import { runResearchOrchestration, runFollowUp } from './orchestrator.js';
import { createAgentRunLog, flushAgentRunLog } from './llm-logger.js';

import { DEFAULT_FACTOR_WEIGHTS, mergeFactorWeights } from '../shared/factor-weights.js';
import { productPrefsStorageKey } from '../shared/product-key.js';
import {
  normalizeBudgetMaxInr,
  migrateLegacyBudgetBand,
} from '../shared/budget-prefs.js';

const DEFAULT_PREFS = {
  budgetMaxInr: 0,
  region: 'IN',
  priorities: '',
  avoidBrands: '',
  researchMode: 'quick',
  detailedAgentActivity: true,
  openaiModel: 'gpt-4o-mini',
  factorWeights: { ...DEFAULT_FACTOR_WEIGHTS },
};

function mergeProductPrefs(globalPrefs, productOverride) {
  if (!productOverride || typeof productOverride !== 'object') {
    return {
      ...globalPrefs,
      factorWeights: mergeFactorWeights({ factorWeights: globalPrefs.factorWeights }),
    };
  }
  const out = { ...globalPrefs };
  for (const k of ['region', 'priorities', 'avoidBrands', 'researchMode']) {
    if (productOverride[k] !== undefined) out[k] = productOverride[k];
  }
  if (productOverride.budgetMaxInr !== undefined) {
    out.budgetMaxInr = normalizeBudgetMaxInr(productOverride.budgetMaxInr);
  } else if (productOverride.budgetBand !== undefined) {
    out.budgetMaxInr = normalizeBudgetMaxInr(migrateLegacyBudgetBand(productOverride.budgetBand));
  }
  const fwMerged = {
    ...globalPrefs.factorWeights,
    ...(productOverride.factorWeights && typeof productOverride.factorWeights === 'object'
      ? productOverride.factorWeights
      : {}),
  };
  out.factorWeights = mergeFactorWeights({ factorWeights: fwMerged });
  return out;
}

async function loadStorage() {
  const raw = await chrome.storage.local.get([
    'openaiApiKey',
    'searchApiKey',
    ...Object.keys(DEFAULT_PREFS),
    'productPrefs',
  ]);
  const prefs = { ...DEFAULT_PREFS };
  for (const k of Object.keys(DEFAULT_PREFS)) {
    if (raw[k] !== undefined) prefs[k] = raw[k];
  }
  let budgetRaw = raw.budgetMaxInr;
  if (budgetRaw === undefined || budgetRaw === null || budgetRaw === '') {
    budgetRaw = migrateLegacyBudgetBand(raw.budgetBand);
  }
  prefs.budgetMaxInr = normalizeBudgetMaxInr(budgetRaw);
  if (raw.factorWeights && typeof raw.factorWeights === 'object') {
    prefs.factorWeights = { ...DEFAULT_FACTOR_WEIGHTS, ...raw.factorWeights };
  }
  prefs.factorWeights = mergeFactorWeights({ factorWeights: prefs.factorWeights });
  const productPrefs =
    raw.productPrefs && typeof raw.productPrefs === 'object' ? raw.productPrefs : {};
  return {
    openaiApiKey: raw.openaiApiKey || '',
    searchApiKey: raw.searchApiKey || '',
    prefs,
    productPrefs,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'RUN_RESEARCH') {
    const tabId = sender.tab?.id ?? msg.tabId;
    const turnIndexRef = { value: 0 };
    (async () => {
      const { openaiApiKey, searchApiKey, prefs: globalPrefs, productPrefs } = await loadStorage();
      if (!openaiApiKey || !searchApiKey) {
        sendResponse({
          ok: false,
          error: 'Missing API keys — open extension options to add OpenAI and SearchAPI.io keys.',
        });
        return;
      }
      const runLog = createAgentRunLog({
        kind: 'research',
        tabId: tabId ?? null,
        snapshot: msg.snapshot
          ? {
              title: msg.snapshot.title,
              url: msg.snapshot.url,
              retailer: msg.snapshot.retailer,
              hostname: msg.snapshot.hostname,
              asin: msg.snapshot.asin,
              capturedAt: msg.snapshot.capturedAt,
            }
          : null,
        prefs: null,
      });
      try {
        const pKey = productPrefsStorageKey(msg.snapshot);
        const prefs = mergeProductPrefs(globalPrefs, productPrefs[pKey]);
        const snapshot = {
          ...msg.snapshot,
          region: prefs.region,
        };
        runLog.metadata.prefs = {
          researchMode: prefs.researchMode,
          openaiModel: prefs.openaiModel,
          region: prefs.region,
        };
        const result = await runResearchOrchestration({
          openaiApiKey,
          searchApiKey,
          prefs,
          snapshot,
          tabId,
          turnIndexRef,
          runLog,
        });
        await flushAgentRunLog(runLog, { ok: true, partial: result.partial });
        sendResponse({
          ok: true,
          verdict: result.verdict,
          partial: result.partial,
          priceTelemetry: result.priceTelemetry,
        });
      } catch (e) {
        await flushAgentRunLog(runLog, { ok: false, error: e?.message || String(e) });
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'RUN_FOLLOWUP') {
    const tabId = sender.tab?.id ?? msg.tabId;
    (async () => {
      const { openaiApiKey, prefs: globalPrefs, productPrefs } = await loadStorage();
      if (!openaiApiKey) {
        sendResponse({ ok: false, error: 'Missing OpenAI API key.' });
        return;
      }
      const runLog = createAgentRunLog({
        kind: 'follow_up',
        tabId: tabId ?? null,
        followUpQuestion: msg.question,
        snapshot: msg.snapshot
          ? {
              title: msg.snapshot.title,
              url: msg.snapshot.url,
              retailer: msg.snapshot.retailer,
            }
          : null,
        prefs: null,
      });
      try {
        const pKey = productPrefsStorageKey(msg.snapshot);
        const prefs = mergeProductPrefs(globalPrefs, productPrefs[pKey]);
        runLog.metadata.prefs = {
          openaiModel: prefs.openaiModel,
          region: prefs.region,
        };
        const out = await runFollowUp({
          openaiApiKey,
          prefs,
          snapshot: { ...msg.snapshot, region: prefs.region },
          verdict: msg.verdict,
          userQuestion: msg.question,
          tabId,
          runLog,
        });
        await flushAgentRunLog(runLog, { ok: true });
        sendResponse({ ok: true, answer: out.answer });
      } catch (e) {
        await flushAgentRunLog(runLog, { ok: false, error: e?.message || String(e) });
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  return undefined;
});
