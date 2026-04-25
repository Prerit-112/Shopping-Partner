/**
 * OpenAI chat + tools loop; agent_event stream; synthesis JSON (plan §5, §9.1).
 */
import { buildSystemPrompt, formatSnapshotUserMessage } from './prompt-builder.js';
import {
  runWebSearch,
  runPriceDealSignal,
  runFindAlternatives,
  runOpenRetailerSearch,
  qualityFromToolResults,
} from './tools.js';
import {
  verdictJsonSchema,
  clampPriceSignalQuality,
} from '../shared/schemas.js';
import { recordLlmExchange } from './llm-logger.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web for reviews, complaints, specs, or general context. Use intent to bias the query style.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          intent: {
            type: 'string',
            enum: ['general', 'reviews', 'complaints', 'price'],
            description: 'Why you are searching',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'price_deal_signal',
      description:
        'Snippet-based price/deal signal via search (not a price chart). Returns confidence and source_type.',
      parameters: {
        type: 'object',
        properties: {
          product_hint: { type: 'string' },
          primary_query: { type: 'string' },
          region_hint: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_alternatives',
      description: 'Find alternative products or competing models via web search.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for alternatives' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_retailer_search',
      description:
        'Return a URL to open a retailer search results page for next-step browsing (no network call).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          retailer: {
            type: 'string',
            description: 'amazon or flipkart',
          },
        },
      },
    },
  },
];

function mergeWeakerSignal(current, next) {
  const order = { weak: 0, moderate: 1, strong: 2 };
  if (current == null || order[current] === undefined) return next;
  const a = current;
  const b = next && order[next] !== undefined ? next : 'weak';
  return order[a] <= order[b] ? a : b;
}

function emit(tabId, event) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'AGENT_EVENT', payload: event }).catch(() => {});
}

function previewArgs(obj) {
  try {
    const s = JSON.stringify(obj);
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  } catch {
    return '';
  }
}

async function openaiChat(apiKey, body, logCtx) {
  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    if (logCtx?.runLog) {
      recordLlmExchange(logCtx.runLog, {
        phase: logCtx.phase,
        turn: logCtx.turn,
        ok: false,
        durationMs: Date.now() - started,
        request: body,
        error: e?.message || String(e),
      });
    }
    throw e;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`OpenAI invalid JSON: ${res.status} ${text.slice(0, 300)}`);
    if (logCtx?.runLog) {
      recordLlmExchange(logCtx.runLog, {
        phase: logCtx.phase,
        turn: logCtx.turn,
        ok: false,
        durationMs: Date.now() - started,
        request: body,
        error: err.message,
      });
    }
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `${res.status}: ${text.slice(0, 400)}`);
    if (logCtx?.runLog) {
      recordLlmExchange(logCtx.runLog, {
        phase: logCtx.phase,
        turn: logCtx.turn,
        ok: false,
        durationMs: Date.now() - started,
        request: body,
        error: err.message,
      });
    }
    throw err;
  }
  if (logCtx?.runLog) {
    recordLlmExchange(logCtx.runLog, {
      phase: logCtx.phase,
      turn: logCtx.turn,
      ok: true,
      durationMs: Date.now() - started,
      request: body,
      response: data,
    });
  }
  return data;
}

async function executeToolCall(name, argsRaw, ctx) {
  const args = argsRaw && typeof argsRaw === 'object' ? argsRaw : {};
  const { searchApiKey, snapshot } = ctx;
  switch (name) {
    case 'web_search':
      return runWebSearch(args, searchApiKey, snapshot);
    case 'price_deal_signal': {
      const r = await runPriceDealSignal(args, searchApiKey, snapshot);
      const q = qualityFromToolResults(r);
      ctx.priceTelemetry = mergeWeakerSignal(ctx.priceTelemetry, q);
      return r;
    }
    case 'find_alternatives':
      return runFindAlternatives(args, searchApiKey, snapshot);
    case 'open_retailer_search':
      return runOpenRetailerSearch(args, snapshot);
    default:
      return { error: `unknown_tool: ${name}` };
  }
}

export async function runResearchOrchestration({
  openaiApiKey,
  searchApiKey,
  prefs,
  snapshot,
  tabId,
  turnIndexRef,
  runLog,
}) {
  const maxTurns = prefs?.researchMode === 'deep' ? 14 : 7;
  const model = prefs?.openaiModel || 'gpt-4o-mini';

  const system = buildSystemPrompt(prefs);
  const userSnapshot = formatSnapshotUserMessage(snapshot);

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userSnapshot },
  ];

  const ctx = {
    searchApiKey,
    snapshot,
    priceTelemetry: null,
  };

  let turn = 0;

  emit(tabId, { kind: 'model_turn', turnIndex: turn, phase: 'context' });

  while (turn < maxTurns) {
    turnIndexRef.value = turn;
    const data = await openaiChat(
      openaiApiKey,
      {
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.3,
      },
      runLog ? { runLog, phase: 'research_tool_loop', turn } : null
    );

    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('Empty response from OpenAI');

    messages.push(msg);

    const toolCalls = msg.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      emit(tabId, { kind: 'model_turn', turnIndex: turn, phase: 'research_done' });
      break;
    }

    for (const tc of toolCalls) {
      const id = tc.id;
      const fn = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }

      const start = Date.now();
      const phase = mapToolToPhase(fn, args);
      emit(tabId, {
        kind: 'tool_start',
        turnIndex: turn,
        toolName: fn,
        argsPreview: previewArgs(args),
        phase,
      });

      let result;
      try {
        result = await executeToolCall(fn, args, ctx);
      } catch (e) {
        result = { error: e?.message || String(e) };
        emit(tabId, {
          kind: 'error',
          turnIndex: turn,
          toolName: fn,
          detail: result.error,
        });
      }

      const durationMs = Date.now() - start;
      const resultSummary = summarizeToolResult(fn, result);

      emit(tabId, {
        kind: 'tool_end',
        turnIndex: turn,
        toolName: fn,
        durationMs,
        resultSummary,
        resultDetail: safeDetail(fn, result),
        phase,
      });

      messages.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify(result),
      });
    }

    turn += 1;
    emit(tabId, { kind: 'model_turn', turnIndex: turn, phase: 'research' });
  }

  if (turn >= maxTurns) {
    emit(tabId, { kind: 'error', detail: 'max_turns_reached', partial: true });
  }

  emit(tabId, { kind: 'synthesis_start', turnIndex: turn });

  const synStart = Date.now();
  const synthesisMessages = [
    ...messages,
    {
      role: 'user',
      content: `Research phase complete. Output ONE JSON object matching the schema exactly.

Before emitting JSON, check consistency:
- verdict must match summary, pros, cons_or_red_flags, and alternatives (e.g. better_option_exists requires substantive alternatives tied to user priorities; worth_it must not read like "avoid this").
- verdict_reasoning must name the main evidence and explicitly say why this verdict fits better than the other two enum options, including budget/priorities/region from the system prompt.
- verdict_reasoning MUST explicitly reflect the user's verdict factor weights from the system prompt: state how higher-weighted dimensions (price, reviews, features, reliability) drove the trade-off versus lower-weighted ones — e.g. if reviews were weighted highest, explain how review evidence dominated or where it was insufficient.
- confidence reflects evidence strength and agreement across sources; use low when snippets conflict or are sparse.

Set price_signal_quality consistently with tool evidence (snippet-only => weak or moderate, not strong unless multiple corroborating deal/price hints).

No markdown, no prose outside JSON.`,
    },
  ];

  const schema = verdictJsonSchema();

  const finalData = await openaiChat(
    openaiApiKey,
    {
      model,
      messages: synthesisMessages,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: schema,
      },
    },
    runLog ? { runLog, phase: 'synthesis_json', turn: turn } : null
  );

  const content = finalData?.choices?.[0]?.message?.content;
  let verdict;
  try {
    verdict = JSON.parse(content);
  } catch (e) {
    emit(tabId, { kind: 'synthesis_end', ok: false, durationMs: Date.now() - synStart });
    throw new Error('Verdict JSON parse failed');
  }

  verdict.price_signal_quality = clampPriceSignalQuality(
    verdict.price_signal_quality,
    ctx.priceTelemetry
  );

  emit(tabId, {
    kind: 'synthesis_end',
    ok: true,
    durationMs: Date.now() - synStart,
  });

  return { verdict, priceTelemetry: ctx.priceTelemetry, partial: turn >= maxTurns };
}

function mapToolToPhase(name, args) {
  if (name === 'price_deal_signal') return 'price_deals';
  if (name === 'find_alternatives') return 'alternatives';
  if (name === 'open_retailer_search') return 'alternatives';
  if (name === 'web_search') {
    const intent = args?.intent || '';
    if (intent === 'reviews' || intent === 'complaints') return 'reviews';
    if (intent === 'price') return 'price_deals';
    return 'reviews';
  }
  return 'reviews';
}

function summarizeToolResult(name, result) {
  if (result?.error) return `Error: ${result.error}`;
  if (name === 'open_retailer_search') return `URL: ${result.url || ''}`;
  const n = (result.snippets || []).length;
  if (name === 'price_deal_signal') {
    return `${n} snippets · confidence ${result.confidence || '?'} · ${result.source_type || ''}`;
  }
  return `${n} snippets`;
}

function safeDetail(name, result) {
  if (name === 'price_deal_signal') {
    return {
      confidence: result.confidence,
      source_type: result.source_type,
      queries_used: result.queries_used,
    };
  }
  if (result?.snippets && Array.isArray(result.snippets)) {
    return {
      top_titles: result.snippets.slice(0, 3).map((s) => s.title),
    };
  }
  return undefined;
}

export async function runFollowUp({
  openaiApiKey,
  prefs,
  snapshot,
  verdict,
  userQuestion,
  tabId,
  runLog,
}) {
  const model = prefs?.openaiModel || 'gpt-4o-mini';
  const system = `${buildSystemPrompt(prefs)}\n\nYou answer follow-up questions about the product and prior verdict. Be concise; cite uncertainty when data is from snippets only.`;
  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Snapshot: ${JSON.stringify(snapshot)}\n\nPrior verdict JSON: ${JSON.stringify(verdict)}\n\nUser question: ${userQuestion}`,
    },
  ];

  emit(tabId, { kind: 'model_turn', turnIndex: 0, phase: 'follow_up' });

  const data = await openaiChat(
    openaiApiKey,
    {
      model,
      messages,
      temperature: 0.4,
    },
    runLog ? { runLog, phase: 'follow_up' } : null
  );
  const text = data?.choices?.[0]?.message?.content || '';
  return { answer: text };
}
