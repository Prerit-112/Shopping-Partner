# Shopping Research Agent — Functionality (Explainability)

This document describes **what the extension does from a user and system perspective**, how decisions are surfaced, and how to reason about outputs. It is intended for demos, grading, and transparency (“why did the UI say this?”).

## 1. User-visible journey

1. Install the extension and open **Extension options** (`options/options.html`).
2. Enter an **OpenAI API key** and a **SearchAPI.io API key** (required for web search tools).
3. Set **budget band**, **region**, **priorities**, and optional **brands to avoid**. These values are persisted in `chrome.storage.local` and merged into the **system prompt** on every research run so the model reasons under the same constraints the shopper chose.
4. Visit a supported **product detail page** (Amazon or Flipkart domains listed in `manifest.json`).
5. After a short debounce, the extension may **auto-run** research, or the user can press **Research** in the side panel.
6. The panel shows, in order:
   - **Trust messaging** driven by `price_signal_quality` in the final verdict (see §4).
   - A **phase strip** (Context → Reviews → Price/deals → Alternatives → Verdict) updated from tool phases and the synthesis step.
   - **Agent activity**: per-tool rows with argument previews and result summaries, plus a distinct **Generate verdict (JSON)** row for the synthesis pass.
   - The **verdict card** (recommendation, pros/cons, alternatives, citations).
   - **Follow-up** Q&A, which calls the service worker without the full tool loop (contextual answer using snapshot + prior verdict JSON).

## 2. Functional surfaces (what each part “means”)

| Function | Input | Output / effect |
|----------|--------|----------------|
| **PDP detection** (`detector.js`) | Current URL and light DOM signals | Decides whether to inject the panel (Amazon ASIN path or product signals; Flipkart `/p/` or title signals). |
| **Snapshot** (`snapshot.js`) | DOM | Compact JSON: title, price text, URL, retailer, hostname. No full HTML is sent by default. |
| **Research run** (`RUN_RESEARCH`) | Snapshot | Tool research loop + structured verdict JSON; `AGENT_EVENT` stream to the content script. |
| **Follow-up** (`RUN_FOLLOWUP`) | Snapshot + last verdict + user question | Short natural-language answer; no mandatory tools (faster, cheaper). |
| **Options save** | Form fields | Updates storage; next run picks up new prefs without restart. |

## 3. Agent behavior (explainability)

### 3.1 Who decides what?

| Concern | Who |
|---------|-----|
| Which tools to call and in what order | **OpenAI chat model** (`tools` enabled) using the system prompt, snapshot, and prior tool outputs. |
| Executing tools and enforcing turn limits | **Extension service worker** (`orchestrator.js`). |
| Final JSON shape and fields | **OpenAI** with `response_format: json_schema`; **extension** parses JSON and optionally **clamps** `price_signal_quality` using telemetry from `price_deal_signal`. |

### 3.2 Tools (observable in “Agent activity”)

| Tool | Purpose | Network |
|------|---------|---------|
| `web_search` | General web search with an `intent` hint (reviews, complaints, price, general). | SearchAPI.io (Google engine). |
| `price_deal_signal` | One or two searches oriented around price/deals; returns snippets plus **confidence** and **source_type** (snippet aggregate). | SearchAPI.io (Google engine). |
| `find_alternatives` | Search for alternative products or guides. | SearchAPI.io (Google engine). |
| `open_retailer_search` | Returns a **retailer search URL** (Amazon/Flipkart) for the shopper’s next step. | No external HTTP from extension (URL only). |

### 3.3 Phases vs tools

Phases in the UI are **labels** derived from tool names and arguments (e.g. review-style `web_search` maps to “Reviews”; `price_deal_signal` maps to “Price / deals”). They explain *workflow*, not hidden internal reasoning.

### 3.4 Synthesis step

After tool use completes, the extension performs a **second** API call **without tools**, with a strict JSON schema. The UI shows this as **Generate verdict (JSON)** so users can distinguish **research** from **structured output**.

## 4. Trust: `price_signal_quality`

The verdict includes **`price_signal_quality`**: `strong` | `moderate` | `weak`.

| Value | Meaning (intended interpretability) |
|--------|-------------------------------------|
| **weak** | Evidence is thin, conflicting, or clearly snippet-only; the UI shows a prominent **trust banner**. |
| **moderate** | Some corroboration in snippets; softer warning. |
| **strong** | More consistent secondary mentions in text (still **not** a price chart); a short disclaimer may still appear. |

The worker may record telemetry from `price_deal_signal`. On parse success, `clampPriceSignalQuality` ensures the model cannot claim a **stronger** price signal than telemetry allows if the price tool was used.

**Important limitation (by design):** There is no live price history API (e.g. Keepa). Any “deal” language is **narrative from web text**, not tick-level truth.

## 5. Event protocol (`AGENT_EVENT`)

Messages from the service worker to the content script use:

`{ type: 'AGENT_EVENT', payload: { kind, turnIndex, toolName?, argsPreview?, resultSummary?, durationMs?, phase?, ... } }`

Kinds used in this build include: `model_turn` (mostly for strip/timeline bookkeeping), `tool_start`, `tool_end`, `synthesis_start`, `synthesis_end`, `error`.

This protocol favors **explainability** (what ran, how long, what came back at a summary level) over exposing raw model chain-of-thought.

## 6. Failure modes (what users see)

| Condition | Behavior |
|-----------|----------|
| Missing API keys | Panel hints to open options; `RUN_RESEARCH` returns an error message. |
| Search/OpenAI HTTP errors | Tool row or final error string; partial state possible if max turns reached. |
| Invalid verdict JSON | Synthesis error; user sees parse failure messaging rather than a fabricated verdict. |

## 7. Privacy stance

- Only **compact snapshot fields** and **user preferences** from storage are sent to the model providers configured in options.
- **Agent activity** shows truncated argument previews and summaries, not raw API keys.

---

For structural diagrams of components and data flow, see [ARCHITECTURE.md](./ARCHITECTURE.md).
