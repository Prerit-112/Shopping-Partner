/**
 * Persists detailed LLM call traces (sanitized summaries) per agent run to chrome.storage.local.
 */

export const AGENT_LLM_LOGS_KEY = 'agentLlmRunLogs';

const MAX_STORED_RUNS = 40;
const CONTENT_PREVIEW = 1200;
const MSG_PREVIEW = 800;

function preview(str, max = CONTENT_PREVIEW) {
  if (str == null) return null;
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const row = { role: m.role };
    if (m.content != null) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      row.contentLength = c.length;
      row.contentPreview = preview(c, MSG_PREVIEW);
    }
    if (m.tool_calls?.length) {
      row.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        argumentsLength: (tc.function?.arguments || '').length,
        argumentsPreview: preview(tc.function?.arguments, 400),
      }));
    }
    if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
    if (m.name) row.name = m.name;
    return row;
  });
}

function summarizeResponseFormat(rf) {
  if (!rf || typeof rf !== 'object') return undefined;
  const out = { type: rf.type };
  const js = rf.json_schema;
  if (js && typeof js === 'object') {
    out.json_schema = { name: js.name, strict: js.strict };
  }
  return out;
}

function summarizeRequest(body) {
  if (!body || typeof body !== 'object') return {};
  return {
    model: body.model,
    temperature: body.temperature,
    tool_choice: body.tool_choice,
    toolsCount: body.tools?.length ?? 0,
    toolNames: body.tools?.map((t) => t?.function?.name).filter(Boolean),
    response_format: summarizeResponseFormat(body.response_format),
    messages: summarizeMessages(body.messages || []),
  };
}

function summarizeResponse(data) {
  if (!data) return null;
  const c = data.choices?.[0];
  const msg = c?.message;
  const out = {
    id: data.id,
    model: data.model,
    usage: data.usage,
    finish_reason: c?.finish_reason,
  };
  if (msg) {
    out.assistant = {
      role: msg.role,
      contentLength: msg.content ? String(msg.content).length : 0,
      contentPreview: msg.content ? preview(String(msg.content), 2000) : null,
      tool_calls: msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        argumentsPreview: preview(tc.function?.arguments, 600),
      })),
    };
  }
  return out;
}

/**
 * @param {{ kind: string, tabId?: number, snapshot?: object, prefs?: object, followUpQuestion?: string }} meta
 */
export function createAgentRunLog(meta) {
  const manifest = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
    ? chrome.runtime.getManifest()
    : null;
  return {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    startedAt: new Date().toISOString(),
    extensionVersion: manifest?.version ?? null,
    metadata: { ...meta },
    llmCalls: [],
  };
}

/**
 * @param {ReturnType<typeof createAgentRunLog>} runLog
 * @param {{ phase: string, turn?: number, ok: boolean, durationMs: number, request: object, response?: object, error?: string }} raw
 */
export function recordLlmExchange(runLog, raw) {
  if (!runLog?.llmCalls) return;
  runLog.llmCalls.push({
    at: new Date().toISOString(),
    phase: raw.phase,
    turn: raw.turn,
    ok: raw.ok,
    durationMs: raw.durationMs,
    request: summarizeRequest(raw.request),
    response: raw.ok ? summarizeResponse(raw.response) : undefined,
    error: raw.ok ? undefined : raw.error,
  });
}

/**
 * @param {ReturnType<typeof createAgentRunLog>} runLog
 * @param {{ ok: boolean, partial?: boolean, error?: string }} outcome
 */
export async function flushAgentRunLog(runLog, outcome) {
  if (!runLog) return;
  runLog.endedAt = new Date().toISOString();
  runLog.outcome = outcome;
  try {
    const raw = await chrome.storage.local.get(AGENT_LLM_LOGS_KEY);
    let sessions = raw[AGENT_LLM_LOGS_KEY] || [];
    sessions.push(runLog);
    while (sessions.length > MAX_STORED_RUNS) sessions.shift();
    await chrome.storage.local.set({ [AGENT_LLM_LOGS_KEY]: sessions });
  } catch (e) {
    console.warn('[agent llm log] persist failed', e?.message || e);
  }
}
