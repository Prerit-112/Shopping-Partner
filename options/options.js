const DEFAULT_WEIGHTS = { price: 3, reviews: 3, features: 3, reliability: 3 };

function clampWeight(n) {
  const x = typeof n === 'string' ? parseFloat(n) : Number(n);
  return Number.isFinite(x) ? Math.min(5, Math.max(1, x)) : 3;
}

function readWeightInputs() {
  const parse = (id) => {
    const n = parseFloat(document.getElementById(id).value);
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
  };
  return {
    price: parse('w-price'),
    reviews: parse('w-reviews'),
    features: parse('w-features'),
    reliability: parse('w-reliability'),
  };
}

function syncWeightDisplays() {
  const w = readWeightInputs();
  document.getElementById('disp-price').textContent = String(w.price);
  document.getElementById('disp-reviews').textContent = String(w.reviews);
  document.getElementById('disp-features').textContent = String(w.features);
  document.getElementById('disp-reliability').textContent = String(w.reliability);
}

function migrateLegacyBudgetBand(band) {
  switch (String(band || '')) {
    case 'under_15k_inr':
      return 15000;
    case '15k_40k_inr':
      return 40000;
    default:
      return 0;
  }
}

function clampBudgetMaxInr(n) {
  const x = parseFloat(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.min(500000, x);
}

function syncBudgetDisplay() {
  const el = document.getElementById('budget');
  const v = clampBudgetMaxInr(el.value);
  const disp = document.getElementById('budget-disp');
  if (v <= 0) {
    disp.textContent = 'Flexible — no fixed cap (₹0)';
  } else {
    disp.textContent = `About ₹${Math.round(v).toLocaleString('en-IN')} max (soft guide)`;
  }
}

function load() {
  chrome.storage.local.get(
    [
      'openaiApiKey',
      'searchApiKey',
      'openaiModel',
      'budgetMaxInr',
      'budgetBand',
      'region',
      'priorities',
      'avoidBrands',
      'researchMode',
      'detailedAgentActivity',
      'factorWeights',
    ],
    (r) => {
      document.getElementById('openai').value = r.openaiApiKey || '';
      document.getElementById('search').value = r.searchApiKey || '';
      document.getElementById('model').value = r.openaiModel || '';
      let b = r.budgetMaxInr;
      if (b === undefined || b === null || b === '') {
        b = migrateLegacyBudgetBand(r.budgetBand);
      }
      b = clampBudgetMaxInr(b);
      document.getElementById('budget').value = String(b);
      syncBudgetDisplay();
      document.getElementById('region').value = r.region || 'IN';
      document.getElementById('priorities').value = r.priorities || '';
      document.getElementById('avoid').value = r.avoidBrands || '';
      document.getElementById('mode').value = r.researchMode || 'quick';
      document.getElementById('detail').value = r.detailedAgentActivity === false ? 'minimal' : 'on';

      const rawFw = r.factorWeights || {};
      const fw = {
        price: clampWeight(rawFw.price ?? DEFAULT_WEIGHTS.price),
        reviews: clampWeight(rawFw.reviews ?? DEFAULT_WEIGHTS.reviews),
        features: clampWeight(rawFw.features ?? DEFAULT_WEIGHTS.features),
        reliability: clampWeight(rawFw.reliability ?? DEFAULT_WEIGHTS.reliability),
      };
      document.getElementById('w-price').value = String(fw.price);
      document.getElementById('w-reviews').value = String(fw.reviews);
      document.getElementById('w-features').value = String(fw.features);
      document.getElementById('w-reliability').value = String(fw.reliability);
      syncWeightDisplays();
    }
  );
}

for (const id of ['w-price', 'w-reviews', 'w-features', 'w-reliability']) {
  document.getElementById(id).addEventListener('input', syncWeightDisplays);
}

document.getElementById('budget').addEventListener('input', syncBudgetDisplay);

document.getElementById('save').addEventListener('click', () => {
  const openaiApiKey = document.getElementById('openai').value.trim();
  const searchApiKey = document.getElementById('search').value.trim();
  const openaiModel = document.getElementById('model').value.trim() || 'gpt-4o-mini';
  chrome.storage.local.set(
    {
      openaiApiKey,
      searchApiKey,
      openaiModel,
      budgetMaxInr: clampBudgetMaxInr(document.getElementById('budget').value),
      region: document.getElementById('region').value,
      priorities: document.getElementById('priorities').value.trim(),
      avoidBrands: document.getElementById('avoid').value.trim(),
      researchMode: document.getElementById('mode').value,
      detailedAgentActivity: document.getElementById('detail').value === 'on',
      factorWeights: readWeightInputs(),
    },
    () => {
      chrome.storage.local.remove('budgetBand');
      const el = document.getElementById('status');
      el.textContent = 'Saved.';
      setTimeout(() => {
        el.textContent = '';
      }, 2000);
    }
  );
});

const AGENT_LLM_LOGS_KEY = 'agentLlmRunLogs';

document.getElementById('export-llm-logs').addEventListener('click', () => {
  chrome.storage.local.get([AGENT_LLM_LOGS_KEY], (r) => {
    const sessions = r[AGENT_LLM_LOGS_KEY] || [];
    const payload = {
      exportedAt: new Date().toISOString(),
      runCount: sessions.length,
      runs: sessions,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shopping-research-agent-llm-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const el = document.getElementById('status');
    el.textContent =
      sessions.length === 0
        ? 'No runs logged yet — run research on a product page first.'
        : `Exported ${sessions.length} run(s).`;
    setTimeout(() => {
      el.textContent = '';
    }, 4000);
  });
});

load();
