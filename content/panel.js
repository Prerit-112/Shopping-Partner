/**
 * Shadow DOM panel: phase strip, agent activity, trust banner, verdict (plan §4, §7, §9.1).
 */
(function () {
  if (!window.ShopAgentDetector?.isProductPage()) return;

  const HOST_ID = 'shop-research-agent-root';
  if (document.getElementById(HOST_ID)) return;

  const DEBOUNCE_MS = 800;
  let lastResearchKey = '';
  let agentEvents = [];
  let activityStatus = '';
  let timerStarted = 0;
  let detailedAgent = true;

  const phases = ['context', 'reviews', 'price_deals', 'alternatives', 'verdict'];
  const phaseLabels = {
    context: 'Context',
    reviews: 'Reviews',
    price_deals: 'Price / deals',
    alternatives: 'Alternatives',
    verdict: 'Verdict',
  };

  /** When false, AGENT_EVENT must not overwrite the header status (avoids late messages resetting “Done”). */
  let researchInProgress = false;

  function productPrefsStorageKey(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return '_unknown';
    const asin = String(snapshot.asin || '').trim();
    if (asin) return `asin:${asin}`;
    try {
      const u = new URL(snapshot.url || '');
      return `url:${u.hostname}${u.pathname}`.toLowerCase();
    } catch {
      const u = String(snapshot.url || '').trim();
      return u ? `url:${u.slice(0, 240)}` : '_unknown';
    }
  }

  function clampWeightUi(x) {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
  }

  function formatWeightDisp(v) {
    const n = clampWeightUi(v);
    return Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
  }

  function migrateLegacyBudgetBandPanel(band) {
    switch (String(band || '')) {
      case 'under_15k_inr':
        return 15000;
      case '15k_40k_inr':
        return 40000;
      default:
        return 0;
    }
  }

  function clampBudgetMaxInrUi(n) {
    const x = typeof n === 'string' ? parseFloat(n) : Number(n);
    if (!Number.isFinite(x) || x < 0) return 0;
    return Math.min(500000, x);
  }

  function effectiveBudgetMaxInrForUi(po, r) {
    let b = po.budgetMaxInr;
    if (b === undefined || b === null || b === '') {
      if (po.budgetBand != null && po.budgetBand !== 'flex' && po.budgetBand !== 'unspecified') {
        b = migrateLegacyBudgetBandPanel(po.budgetBand);
      } else {
        b = r.budgetMaxInr;
        if (b === undefined || b === null || b === '') {
          b = migrateLegacyBudgetBandPanel(r.budgetBand);
        } else {
          b = Number(b);
        }
      }
    } else {
      b = Number(b);
    }
    return clampBudgetMaxInrUi(b);
  }

  function syncPrefsBudgetLabel() {
    const el = shadow.getElementById('pp-budget');
    const disp = shadow.getElementById('pp-budget-disp');
    if (!el || !disp) return;
    const v = clampBudgetMaxInrUi(el.value);
    if (v <= 0) disp.textContent = 'Flexible — no fixed cap';
    else disp.textContent = `About ₹${Math.round(v).toLocaleString('en-IN')} (soft guide)`;
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  const host = el('div', 'shop-agent-host-anchor');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const cssUrl = chrome.runtime.getURL('content/panel.css');
  shadow.appendChild(
    Object.assign(document.createElement('link'), { rel: 'stylesheet', href: cssUrl })
  );

  const root = el('div', 'panel-root');
  const fab = el('button', 'fab-toggle', '🛒');
  fab.setAttribute('aria-label', 'Toggle shopping research panel');
  fab.title = 'Shopping research';

  root.innerHTML = `
    <div class="panel-wrap">
      <div class="panel-header">
        <h1>Shopping research</h1>
        <div class="panel-actions">
          <button class="btn btn-primary" id="btn-run" type="button">Research</button>
          <button class="btn" id="btn-hide-panel" type="button" title="Hide panel (use cart button to show again)">Hide</button>
        </div>
      </div>
      <div class="tab-bar" role="tablist" aria-label="Panel sections">
        <button class="tab-btn tab-active" type="button" role="tab" aria-selected="true" data-tab="research" id="tab-research-btn">Results</button>
        <button class="tab-btn" type="button" role="tab" aria-selected="false" data-tab="activity" id="tab-activity-btn">Activity</button>
        <button class="tab-btn" type="button" role="tab" aria-selected="false" data-tab="prefs" id="tab-prefs-btn">Prefs</button>
        <button class="tab-btn" type="button" role="tab" aria-selected="false" data-tab="guide" id="tab-guide-btn">About</button>
      </div>
      <div class="tab-content">
        <div class="tab-panel is-active" id="panel-research" role="tabpanel" aria-labelledby="tab-research-btn">
          <div class="research-stack research-stack-results">
            <div id="trust-slot"></div>
            <div class="research-progress" id="research-progress" aria-live="polite">
              <div class="research-progress-track">
                <div class="research-progress-fill" id="research-progress-fill"></div>
              </div>
              <div class="research-progress-meta">
                <span class="research-progress-label" id="research-progress-label">Ready</span>
                <button type="button" class="link-to-activity" id="link-to-activity" title="Open full trace">View trace</button>
              </div>
            </div>
            <div id="main-body" class="verdict-card">
              <div class="config-hint" id="config-hint" hidden>
                Configure <a id="open-opts">API keys in extension options</a> (OpenAI + SearchAPI.io).
              </div>
              <div id="verdict-content"></div>
            </div>
            <div class="follow-up">
              <div class="section-title">Follow-up</div>
              <textarea id="fu-input" placeholder="Ask about this verdict…"></textarea>
              <div class="follow-up-actions">
                <button class="btn btn-primary" type="button" id="fu-send">Send</button>
                <button class="btn" type="button" id="copy-verdict">Copy verdict</button>
              </div>
              <div class="follow-up-out-scroll" id="fu-out-wrap">
                <div id="fu-out" class="follow-up-out"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="panel-activity" role="tabpanel" aria-labelledby="tab-activity-btn">
          <div class="activity-stack">
            <div class="agent-activity agent-activity-full" id="agent-activity">
              <div class="agent-activity-header">
                <span><strong>Agent activity</strong> <span id="agent-status" class="status-run"></span></span>
                <div class="agent-activity-header-actions">
                  <button class="btn" type="button" id="btn-toggle-detail">Detail</button>
                  <button class="btn" id="btn-collapse-trace" type="button" title="Collapse trace">▾</button>
                </div>
              </div>
              <div class="agent-rows" id="agent-rows"></div>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="panel-prefs" role="tabpanel" aria-labelledby="tab-prefs-btn">
          <div class="prefs-panel">
            <p class="prefs-lead">These settings apply <strong>only to this product page</strong>. They layer on top of extension options. Change the price weight smoothly or toggle research depth; values save automatically.</p>
            <p class="prefs-product-id" id="prefs-product-id"></p>
            <div class="prefs-section">
              <div class="prefs-section-title">Verdict factor weights (1 = lowest, 5 = highest)</div>
              <div class="prefs-range-row">
                <label for="pp-w-price">Price / value <span class="prefs-val" id="pp-disp-price">3</span></label>
                <input type="range" id="pp-w-price" min="1" max="5" step="0.05" value="3" />
              </div>
              <div class="prefs-range-row">
                <label for="pp-w-reviews">Reviews &amp; reputation <span class="prefs-val" id="pp-disp-reviews">3</span></label>
                <input type="range" id="pp-w-reviews" min="1" max="5" step="0.05" value="3" />
              </div>
              <div class="prefs-range-row">
                <label for="pp-w-features">Features &amp; specs <span class="prefs-val" id="pp-disp-features">3</span></label>
                <input type="range" id="pp-w-features" min="1" max="5" step="0.05" value="3" />
              </div>
              <div class="prefs-range-row">
                <label for="pp-w-reliability">Reliability &amp; support <span class="prefs-val" id="pp-disp-reliability">3</span></label>
                <input type="range" id="pp-w-reliability" min="1" max="5" step="0.05" value="3" />
              </div>
            </div>
            <div class="prefs-section">
              <div class="prefs-section-title">Research depth</div>
              <div class="prefs-segment" role="group" aria-label="Research mode">
                <button type="button" class="prefs-segment-btn" data-pp-mode="quick" id="pp-mode-quick">Quick</button>
                <button type="button" class="prefs-segment-btn" data-pp-mode="deep" id="pp-mode-deep">Deep</button>
              </div>
              <p class="prefs-hint">Quick uses fewer tool rounds; Deep spends more searches before the verdict.</p>
            </div>
            <div class="prefs-section">
              <div class="prefs-section-title">Budget &amp; region</div>
              <label class="prefs-label" for="pp-budget">Maximum budget (INR)</label>
              <p class="prefs-hint prefs-budget-disp" id="pp-budget-disp">Flexible — no fixed cap</p>
              <input type="range" id="pp-budget" class="prefs-budget-range" min="0" max="500000" step="500" value="0" />
              <label class="prefs-label" for="pp-region">Region</label>
              <select id="pp-region" class="prefs-select">
                <option value="IN">India (IN)</option>
                <option value="US">United States (US)</option>
                <option value="EU">EU</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="prefs-section">
              <label class="prefs-label" for="pp-priorities">Priorities for this item</label>
              <textarea id="pp-priorities" class="prefs-textarea" placeholder="e.g. battery, warranty, noise" rows="2"></textarea>
              <label class="prefs-label" for="pp-avoid">Brands to avoid (this page)</label>
              <input type="text" id="pp-avoid" class="prefs-input" placeholder="comma-separated" />
            </div>
            <div class="prefs-actions">
              <button type="button" class="btn" id="pp-reset">Use only global options for this product</button>
            </div>
          </div>
        </div>
        <div class="tab-panel" id="panel-guide" role="tabpanel" aria-labelledby="tab-guide-btn">
          <div class="guide-panel">
            <div class="guide-callout">
              <strong>What this extension does</strong>
              On Amazon and Flipkart product pages, it builds a compact snapshot of the listing, runs a web-search-first research loop (OpenAI + SearchAPI.io), and shows a structured verdict with citations. Open the <strong>Activity</strong> tab for a plain-language walkthrough of each research step.
            </div>
            <h2>Setup</h2>
            <p>Open <a id="open-opts-guide">Extension options</a> and add your <strong>OpenAI</strong> and <strong>SearchAPI.io</strong> API keys. Set budget, region, priorities, <strong>verdict factor weights</strong> (price, reviews, features, reliability), and optional brands to avoid; those preferences are merged into every research run and reflected in the verdict reasoning.</p>
            <h2>Tabs</h2>
            <ul>
              <li><strong>Results</strong> — Trust note, progress, verdict, and follow-up Q&amp;A.</li>
              <li><strong>Activity</strong> — What each tool did, in everyday language, plus timings (expand a row for the full note).</li>
              <li><strong>Prefs</strong> — Per-product weights (continuous), research depth, continuous budget ceiling (INR), region, priorities—saved per listing.</li>
              <li><strong>About</strong> — This reference.</li>
            </ul>
            <h3>Research phases (shown as progress on Results)</h3>
            <p>Context → Reviews → Price / deals → Alternatives → Verdict synthesis. The bar advances as the agent completes each stage.</p>
            <h3>Tools (in Activity)</h3>
            <ul>
              <li><strong>web_search</strong> — Web search (reviews, complaints, price hints).</li>
              <li><strong>price_deal_signal</strong> — Deal-oriented snippets; feeds price-signal telemetry.</li>
              <li><strong>find_alternatives</strong> — Alternatives or guides.</li>
              <li><strong>open_retailer_search</strong> — Retailer search URL only (no extra HTTP).</li>
            </ul>
            <h3>Supported sites</h3>
            <p>Amazon (.com, .in, .co.uk, .de) and Flipkart product detail pages.</p>
          </div>
        </div>
      </div>
    </div>`;

  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  document.documentElement.appendChild(fab);

  const tabButtons = shadow.querySelectorAll('.tab-btn');
  const panelResearch = shadow.getElementById('panel-research');
  const panelActivity = shadow.getElementById('panel-activity');
  const panelPrefs = shadow.getElementById('panel-prefs');
  const panelGuide = shadow.getElementById('panel-guide');

  let prefsSaveTimer = 0;
  function patchProductPrefs(partial) {
    const snap = window.ShopAgentSnapshot.build();
    const key = productPrefsStorageKey(snap);
    chrome.storage.local.get(['productPrefs'], (r) => {
      const pp = { ...(r.productPrefs || {}) };
      const cur = { ...(pp[key] || {}) };
      for (const [k, v] of Object.entries(partial)) {
        if (k === 'factorWeights' && v && typeof v === 'object') {
          cur.factorWeights = { ...(cur.factorWeights || {}), ...v };
        } else {
          cur[k] = v;
        }
      }
      if (Object.prototype.hasOwnProperty.call(partial, 'budgetMaxInr')) {
        delete cur.budgetBand;
      }
      pp[key] = cur;
      chrome.storage.local.set({ productPrefs: pp });
    });
  }

  function schedulePrefsPatch(partial) {
    clearTimeout(prefsSaveTimer);
    prefsSaveTimer = setTimeout(() => patchProductPrefs(partial), 380);
  }

  function syncPrefsWeightLabels() {
    const ids = [
      ['pp-w-price', 'pp-disp-price'],
      ['pp-w-reviews', 'pp-disp-reviews'],
      ['pp-w-features', 'pp-disp-features'],
      ['pp-w-reliability', 'pp-disp-reliability'],
    ];
    for (const [rid, did] of ids) {
      const el = shadow.getElementById(rid);
      const d = shadow.getElementById(did);
      if (el && d) d.textContent = formatWeightDisp(el.value);
    }
  }

  function syncPrefsModeButtons(mode) {
    const q = shadow.getElementById('pp-mode-quick');
    const d = shadow.getElementById('pp-mode-deep');
    const m = mode === 'deep' ? 'deep' : 'quick';
    q.classList.toggle('prefs-segment-active', m === 'quick');
    d.classList.toggle('prefs-segment-active', m === 'deep');
  }

  function refreshPrefsTab() {
    const snap = window.ShopAgentSnapshot.build();
    const key = productPrefsStorageKey(snap);
    const idEl = shadow.getElementById('prefs-product-id');
    if (idEl) {
      if (snap.asin) idEl.textContent = `Product key: ASIN ${snap.asin}`;
      else {
        try {
          const u = new URL(snap.url || '');
          idEl.textContent = `Product key: ${u.hostname}${u.pathname}`;
        } catch {
          idEl.textContent = `Product key: ${String(snap.url || '').slice(0, 80)}`;
        }
      }
    }
    chrome.storage.local.get(
      [
        'productPrefs',
        'budgetMaxInr',
        'budgetBand',
        'region',
        'priorities',
        'avoidBrands',
        'researchMode',
        'factorWeights',
      ],
      (r) => {
        const po = (r.productPrefs && r.productPrefs[key]) || {};
        const gfw = { price: 3, reviews: 3, features: 3, reliability: 3 };
        if (typeof r.factorWeights === 'object' && r.factorWeights) {
          for (const k of ['price', 'reviews', 'features', 'reliability']) {
            if (r.factorWeights[k] != null) gfw[k] = clampWeightUi(r.factorWeights[k]);
          }
        }
        const fw = (k) => clampWeightUi(po.factorWeights?.[k] ?? gfw[k]);
        shadow.getElementById('pp-w-price').value = String(fw('price'));
        shadow.getElementById('pp-w-reviews').value = String(fw('reviews'));
        shadow.getElementById('pp-w-features').value = String(fw('features'));
        shadow.getElementById('pp-w-reliability').value = String(fw('reliability'));
        syncPrefsWeightLabels();
        const mode = po.researchMode !== undefined ? po.researchMode : r.researchMode || 'quick';
        syncPrefsModeButtons(mode);
        const budgetVal = effectiveBudgetMaxInrForUi(po, r);
        shadow.getElementById('pp-budget').value = String(budgetVal);
        syncPrefsBudgetLabel();
        shadow.getElementById('pp-region').value = po.region !== undefined ? po.region : r.region || 'IN';
        shadow.getElementById('pp-priorities').value =
          po.priorities !== undefined ? po.priorities : r.priorities || '';
        shadow.getElementById('pp-avoid').value =
          po.avoidBrands !== undefined ? po.avoidBrands : r.avoidBrands || '';
      }
    );
  }

  function setActiveTab(name) {
    for (const btn of tabButtons) {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('tab-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    panelResearch.classList.toggle('is-active', name === 'research');
    panelActivity.classList.toggle('is-active', name === 'activity');
    panelPrefs.classList.toggle('is-active', name === 'prefs');
    panelGuide.classList.toggle('is-active', name === 'guide');
    if (name === 'prefs') refreshPrefsTab();
  }
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  }
  setActiveTab('research');

  shadow.getElementById('pp-mode-quick').addEventListener('click', () => {
    syncPrefsModeButtons('quick');
    patchProductPrefs({ researchMode: 'quick' });
  });
  shadow.getElementById('pp-mode-deep').addEventListener('click', () => {
    syncPrefsModeButtons('deep');
    patchProductPrefs({ researchMode: 'deep' });
  });

  for (const [rid, key] of [
    ['pp-w-price', 'price'],
    ['pp-w-reviews', 'reviews'],
    ['pp-w-features', 'features'],
    ['pp-w-reliability', 'reliability'],
  ]) {
    shadow.getElementById(rid).addEventListener('input', () => {
      syncPrefsWeightLabels();
      const v = clampWeightUi(shadow.getElementById(rid).value);
      schedulePrefsPatch({ factorWeights: { [key]: v } });
    });
  }

  shadow.getElementById('pp-budget').addEventListener('input', () => {
    syncPrefsBudgetLabel();
    schedulePrefsPatch({
      budgetMaxInr: clampBudgetMaxInrUi(shadow.getElementById('pp-budget').value),
    });
  });
  shadow.getElementById('pp-region').addEventListener('change', (e) => {
    patchProductPrefs({ region: e.target.value });
  });
  shadow.getElementById('pp-priorities').addEventListener('input', (e) => {
    schedulePrefsPatch({ priorities: e.target.value });
  });
  shadow.getElementById('pp-avoid').addEventListener('input', (e) => {
    schedulePrefsPatch({ avoidBrands: e.target.value });
  });

  shadow.getElementById('pp-reset').addEventListener('click', () => {
    const snap = window.ShopAgentSnapshot.build();
    const key = productPrefsStorageKey(snap);
    chrome.storage.local.get(['productPrefs'], (r) => {
      const pp = { ...(r.productPrefs || {}) };
      delete pp[key];
      chrome.storage.local.set({ productPrefs: pp }, () => refreshPrefsTab());
    });
  });

  shadow.getElementById('link-to-activity').addEventListener('click', () => setActiveTab('activity'));

  const openOptsGuide = shadow.getElementById('open-opts-guide');
  openOptsGuide.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  let expanded = true;
  function applyExpanded() {
    host.style.display = expanded ? 'block' : 'none';
    fab.setAttribute('aria-label', expanded ? 'Hide shopping research panel' : 'Show shopping research panel');
    fab.title = expanded ? 'Hide panel' : 'Show shopping research';
  }
  fab.addEventListener('click', () => {
    expanded = !expanded;
    applyExpanded();
  });
  applyExpanded();

  shadow.getElementById('btn-hide-panel').addEventListener('click', () => {
    expanded = false;
    applyExpanded();
  });

  const progressFill = shadow.getElementById('research-progress-fill');
  const progressLabel = shadow.getElementById('research-progress-label');
  const agentRows = shadow.getElementById('agent-rows');
  const agentStatus = shadow.getElementById('agent-status');
  const verdictEl = shadow.getElementById('verdict-content');
  const trustSlot = shadow.getElementById('trust-slot');
  const configHint = shadow.getElementById('config-hint');
  const openOpts = shadow.getElementById('open-opts');
  const btnRun = shadow.getElementById('btn-run');
  const fuSend = shadow.getElementById('fu-send');
  const fuInput = shadow.getElementById('fu-input');
  const fuOut = shadow.getElementById('fu-out');
  const copyVerdict = shadow.getElementById('copy-verdict');
  const btnCollapseTrace = shadow.getElementById('btn-collapse-trace');
  const btnToggleDetail = shadow.getElementById('btn-toggle-detail');

  let agentActivityCollapsed = false;

  function renderProgressFromState() {
    let done = 0;
    let activePhase = null;
    for (const p of phases) {
      if (stripState[p] === 'done') done += 1;
      else if (stripState[p] === 'active') {
        activePhase = p;
        break;
      }
    }
    const allDone = phases.every((p) => stripState[p] === 'done');
    const idle = phases.every((p) => !stripState[p]);
    let pct;
    let label;
    if (allDone) {
      pct = 100;
      label = 'Complete';
    } else if (idle || (done === 0 && !activePhase)) {
      pct = 0;
      label = 'Ready';
    } else {
      pct = Math.min(95, done * 20 + (activePhase ? 10 : 0));
      label = activePhase ? phaseLabels[activePhase] : 'Working…';
    }
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = label;
  }

  const stripState = {
    context: '',
    reviews: '',
    price_deals: '',
    alternatives: '',
    verdict: '',
  };

  function renderStripFromState() {
    renderProgressFromState();
  }

  renderStripFromState();

  function updateStrip(ev) {
    if (ev.kind === 'model_turn' && ev.phase === 'context') {
      stripState.context = 'active';
    }
    if (ev.kind === 'tool_start') {
      stripState.context = 'done';
      const ph = ev.phase || 'reviews';
      if (ph === 'reviews') stripState.reviews = 'active';
      if (ph === 'price_deals') {
        stripState.reviews = 'done';
        stripState.price_deals = 'active';
      }
      if (ph === 'alternatives') {
        stripState.reviews = 'done';
        stripState.price_deals = 'done';
        stripState.alternatives = 'active';
      }
    }
    if (ev.kind === 'tool_end') {
      stripState.context = 'done';
      const ph = ev.phase || 'reviews';
      if (ph === 'reviews') stripState.reviews = 'done';
      if (ph === 'price_deals') stripState.price_deals = 'done';
      if (ph === 'alternatives') stripState.alternatives = 'done';
    }
    if (ev.kind === 'synthesis_start') {
      stripState.reviews = 'done';
      stripState.price_deals = 'done';
      stripState.alternatives = 'done';
      stripState.verdict = 'active';
    }
    if (ev.kind === 'synthesis_end' && ev.ok) {
      stripState.context = 'done';
      stripState.verdict = 'done';
    }
    renderStripFromState();
  }

  function pushEvent(ev) {
    if (ev.kind !== 'model_turn') {
      agentEvents.push(ev);
    }
    if (researchInProgress) {
      activityStatus = 'Running…';
    }
    timerStarted = timerStarted || Date.now();
    updateStrip(ev);
    renderAgentRows();
  }

  function buildMergedDisplay(events) {
    const out = [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const next = events[i + 1];
      if (
        ev.kind === 'tool_start' &&
        next?.kind === 'tool_end' &&
        next.toolName === ev.toolName &&
        next.turnIndex === ev.turnIndex
      ) {
        out.push({ kind: 'tool_pair', start: ev, end: next });
        i++;
        continue;
      }
      if (ev.kind === 'tool_start') {
        out.push({ kind: 'tool_running', start: ev });
        continue;
      }
      if (ev.kind === 'tool_end') {
        out.push({ kind: 'tool_end_only', end: ev });
        continue;
      }
      if (ev.kind === 'synthesis_start' && next?.kind === 'synthesis_end') {
        out.push({ kind: 'synthesis_pair', start: ev, end: next });
        i++;
        continue;
      }
      if (ev.kind === 'synthesis_start') {
        out.push({ kind: 'synthesis_running', start: ev });
        continue;
      }
      if (ev.kind === 'synthesis_end') {
        out.push({ kind: 'synthesis_end_only', end: ev });
        continue;
      }
      if (ev.kind === 'error') {
        out.push({ kind: 'error', ev });
      }
    }
    return out;
  }

  function parseArgsPreview(raw) {
    if (raw == null || typeof raw !== 'string' || !raw.trim()) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function truncateText(s, max) {
    const t = String(s || '');
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
  }

  const INTENT_PHRASE = {
    reviews: 'reviews and what buyers say',
    complaints: 'complaints and common issues',
    price: 'pricing and deals',
    general: 'general background',
  };

  function toolDisplayName(toolName) {
    const m = {
      web_search: 'Web search',
      price_deal_signal: 'Price and deals check',
      find_alternatives: 'Alternatives search',
      open_retailer_search: 'Store search link',
    };
    return m[toolName] || String(toolName || 'Step').replace(/_/g, ' ');
  }

  /** Plain-language description of what the tool was asked to do (no JSON). */
  function humanizeToolIntro(toolName, argsPreview) {
    const args = parseArgsPreview(argsPreview);
    const t = toolName || '';
    if (t === 'web_search') {
      const q = args?.query != null ? String(args.query).trim() : '';
      const intent = args?.intent != null ? String(args.intent) : 'general';
      const focus = INTENT_PHRASE[intent] || INTENT_PHRASE.general;
      if (q) {
        return `Looked up “${truncateText(q, 160)}” on the web, focusing on ${focus}.`;
      }
      return `Ran a web search with emphasis on ${focus}.`;
    }
    if (t === 'price_deal_signal') {
      return 'Compared price and deal hints from several web searches. This is based on short search snippets, not a live price chart.';
    }
    if (t === 'find_alternatives') {
      const q = args?.query != null ? String(args.query).trim() : '';
      if (q) {
        return `Searched for other options or guides using “${truncateText(q, 160)}”.`;
      }
      return 'Searched for alternative products and buying guides.';
    }
    if (t === 'open_retailer_search') {
      const retailer = args?.retailer != null ? String(args.retailer).trim() : '';
      const q = args?.query != null ? String(args.query).trim() : '';
      const r = retailer || 'the store';
      if (q) {
        return `Prepared a ${r} search for “${truncateText(q, 120)}” so you can open similar listings on the retailer site.`;
      }
      return `Prepared a search link on ${r} for this product.`;
    }
    return '';
  }

  function humanizeResultSummary(toolName, summary) {
    if (!summary || typeof summary !== 'string') return '';
    if (/^Error:/i.test(summary)) {
      return `Something went wrong: ${summary.replace(/^Error:\s*/i, '')}`;
    }
    const snip = summary.match(/^(\d+) snippets/);
    if (snip) {
      const n = snip[1];
      if (toolName === 'price_deal_signal') {
        return `Gathered ${n} short excerpts about price and deals. The extension treats this only as soft evidence from the web, not confirmed prices.`;
      }
      return `Gathered ${n} short excerpts from search results for the assistant to read.`;
    }
    if (/^URL:/i.test(summary)) {
      const u = summary.replace(/^URL:\s*/i, '').trim();
      return `Ready-to-open search URL: ${u}`;
    }
    return summary;
  }

  /** Extra plain sentences from structured detail (never JSON). */
  function humanizeResultDetailSentences(toolName, resultDetail) {
    if (!resultDetail || typeof resultDetail !== 'object') return [];
    const lines = [];
    if (toolName === 'price_deal_signal') {
      const qu = resultDetail.queries_used;
      if (Array.isArray(qu) && qu.length) {
        const parts = qu.map((x) => `“${truncateText(String(x), 100)}”`).join(' and ');
        lines.push(`Example search phrases were ${parts}.`);
      }
      if (resultDetail.confidence) {
        lines.push(`Snippet strength was rated “${resultDetail.confidence}” (how much the text backed a price story).`);
      }
      if (resultDetail.source_type) {
        const label = String(resultDetail.source_type).replace(/_/g, ' ');
        lines.push(`Evidence type: ${label}.`);
      }
    }
    if (Array.isArray(resultDetail.top_titles) && resultDetail.top_titles.length) {
      const titles = resultDetail.top_titles.filter(Boolean).map((x) => truncateText(String(x), 120));
      if (titles.length) {
        lines.push(`Some of the pages skimmed included: ${titles.join('; ')}.`);
      }
    }
    return lines;
  }

  function buildToolNarrativeHtml(toolName, argsPreview, resultSummary, resultDetail) {
    const intro = humanizeToolIntro(toolName, argsPreview);
    const outcome = humanizeResultSummary(toolName, resultSummary);
    const extra = humanizeResultDetailSentences(toolName, resultDetail);
    const blocks = [];
    if (intro) {
      blocks.push(`<p class="agent-prose-lead">${escapeHtml(intro)}</p>`);
    }
    if (outcome) {
      blocks.push(`<p class="agent-prose-outcome">${escapeHtml(outcome)}</p>`);
    }
    for (const line of extra) {
      blocks.push(`<p class="agent-prose-detail">${escapeHtml(line)}</p>`);
    }
    if (!blocks.length) {
      blocks.push(`<p class="agent-prose-detail">${escapeHtml('This step finished; expand the summary row above for timing.')}</p>`);
    }
    return `<div class="agent-row-prose">${blocks.join('')}</div>`;
  }

  function renderAgentRows() {
    if (!detailedAgent) {
      agentRows.innerHTML = `<div style="padding:8px 14px;color:#8fa3bc;">${escapeHtml(
        summarizeTrace()
      )}</div>`;
      return;
    }
    const merged = buildMergedDisplay(agentEvents);
    const frag = document.createDocumentFragment();
    for (const item of merged) {
      if (item.kind === 'tool_pair') {
        const ev = item.end;
        const row = el('details', 'agent-row');
        row.open = true;
        row.innerHTML = `
          <summary>
            <div class="agent-row-title">
              <span class="badge-tool">${escapeHtml(toolDisplayName(ev.toolName))}</span>
              <span class="status-ok">Done</span>
              <span style="color:#8fa3bc;">${ev.durationMs != null ? `${ev.durationMs} ms` : ''}</span>
            </div>
          </summary>
          ${buildToolNarrativeHtml(ev.toolName, item.start.argsPreview, ev.resultSummary, ev.resultDetail)}`;
        frag.appendChild(row);
      } else if (item.kind === 'tool_running') {
        const ev = item.start;
        const intro = humanizeToolIntro(ev.toolName, ev.argsPreview);
        const row = el('div', 'agent-row');
        row.innerHTML = `
          <div class="agent-row-title">
            <span class="badge-tool">${escapeHtml(toolDisplayName(ev.toolName))}</span>
            <span class="status-run">In progress…</span>
          </div>
          ${
            intro
              ? `<div class="agent-row-prose"><p class="agent-prose-lead">${escapeHtml(intro)}</p></div>`
              : `<div class="agent-row-prose"><p class="agent-prose-detail">${escapeHtml('Working on this step…')}</p></div>`
          }`;
        frag.appendChild(row);
      } else if (item.kind === 'tool_end_only') {
        const ev = item.end;
        const row = el('details', 'agent-row');
        row.open = true;
        row.innerHTML = `
          <summary>
            <div class="agent-row-title">
              <span class="badge-tool">${escapeHtml(toolDisplayName(ev.toolName))}</span>
              <span class="status-ok">Done</span>
              <span style="color:#8fa3bc;">${ev.durationMs != null ? `${ev.durationMs} ms` : ''}</span>
            </div>
          </summary>
          ${buildToolNarrativeHtml(ev.toolName, '', ev.resultSummary, ev.resultDetail)}`;
        frag.appendChild(row);
      } else if (item.kind === 'synthesis_pair') {
        const syn = item.end;
        const row = el('details', 'agent-row');
        row.open = true;
        const okText = syn.ok
          ? 'Finished writing the verdict.'
          : 'Could not produce the final verdict; see the error on the Results tab.';
        row.innerHTML = `
          <summary>
            <div class="agent-row-title">
              <span class="badge-tool">${escapeHtml('Final verdict step')}</span>
              <span class="${syn.ok ? 'status-ok' : 'status-err'}">${syn.ok ? 'Done' : 'Failed'}</span>
              <span style="color:#8fa3bc;">${syn.durationMs != null ? `${syn.durationMs} ms` : ''}</span>
            </div>
          </summary>
          <div class="agent-row-prose">
            <p class="agent-prose-lead">${escapeHtml(okText)}</p>
            <p class="agent-prose-detail">${escapeHtml(
              'This step does not search the web again. It organizes everything from the steps above into the recommendation, pros and cons, alternatives, and citation links you see under Results.'
            )}</p>
          </div>`;
        frag.appendChild(row);
      } else if (item.kind === 'synthesis_running') {
        const row = el('div', 'agent-row');
        row.innerHTML = `
          <div class="agent-row-title">
            <span class="badge-tool">${escapeHtml('Final verdict step')}</span>
            <span class="status-run">In progress…</span>
          </div>
          <div class="agent-row-prose">
            <p class="agent-prose-lead">${escapeHtml('Turning research notes into your structured verdict…')}</p>
          </div>`;
        frag.appendChild(row);
      } else if (item.kind === 'synthesis_end_only') {
        const syn = item.end;
        const row = el('details', 'agent-row');
        row.open = true;
        const okText = syn.ok
          ? 'Finished writing the verdict.'
          : 'Could not produce the final verdict.';
        row.innerHTML = `
          <summary>
            <div class="agent-row-title">
              <span class="badge-tool">${escapeHtml('Final verdict step')}</span>
              <span class="${syn.ok ? 'status-ok' : 'status-err'}">${syn.ok ? 'Done' : 'Failed'}</span>
              <span style="color:#8fa3bc;">${syn.durationMs != null ? `${syn.durationMs} ms` : ''}</span>
            </div>
          </summary>
          <div class="agent-row-prose">
            <p class="agent-prose-lead">${escapeHtml(okText)}</p>
          </div>`;
        frag.appendChild(row);
      } else if (item.kind === 'error') {
        const ev = item.ev;
        const row = el('div', 'agent-row');
        row.innerHTML = `<div class="agent-row-prose"><p class="status-err">${escapeHtml(
          `A problem stopped this part of the run: ${ev.detail || 'Unknown error'}`
        )}</p></div>`;
        frag.appendChild(row);
      }
    }
    agentRows.innerHTML = '';
    agentRows.appendChild(frag);
    if (agentActivityCollapsed) {
      shadow.getElementById('agent-activity')?.classList.add('agent-collapsed');
    }
  }

  function summarizeTrace() {
    const tools = agentEvents.filter((e) => e.kind === 'tool_end').length;
    const sec = timerStarted ? ((Date.now() - timerStarted) / 1000).toFixed(1) : '?';
    return `${tools} research step${tools === 1 ? '' : 's'} completed in about ${sec}s. Turn on Detail for plain-language notes for each step.`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let latestVerdict = null;

  function renderTrust(verdict) {
    trustSlot.innerHTML = '';
    if (!verdict) return;
    const q = verdict.price_signal_quality || 'weak';
    if (q === 'weak') {
      const b = el('div', 'trust-banner');
      b.innerHTML = `
        <strong>Limited price signal</strong>
        Price and deal information comes from web snippets, not a live price history chart.
        Treat “wait for sale” as uncertain — check the retailer and recent sales yourself.`;
      trustSlot.appendChild(b);
    } else if (q === 'moderate') {
      const b = el('div', 'trust-banner');
      b.style.background = 'rgba(56, 189, 248, 0.08)';
      b.style.borderBottomColor = 'rgba(56, 189, 248, 0.25)';
      b.style.color = '#bae6fd';
      b.innerHTML = `
        <strong>Snippet-based pricing context</strong>
        Deal signals are inferred from search snippets — verify on the retailer before buying.`;
      trustSlot.appendChild(b);
    } else {
      const b = el('div', 'footer-note');
      b.style.padding = '8px 14px';
      b.textContent =
        'Still not a live price chart — snippets can lag or omit discounts.';
      trustSlot.appendChild(b);
    }
  }

  function verdictTitle(v) {
    const m = {
      worth_it: 'Worth it',
      wait_for_sale: 'Wait for sale',
      better_option_exists: 'Better option exists',
    };
    return m[v] || v;
  }

  function renderVerdict(v, partial) {
    latestVerdict = v;
    if (!v) {
      verdictEl.innerHTML = '';
      return;
    }
    const cites = (v.citations || [])
      .map(
        (c) =>
          `<div class="citations">• <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
            c.label || c.url
          )}</a></div>`
      )
      .join('');
    const alt = (v.alternatives || [])
      .map(
        (a) => `<div class="alt-item"><strong>${escapeHtml(a.name)}</strong> — ${escapeHtml(
          a.why
        )}<br/><a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></div>`
      )
      .join('');

    const reasoning = (v.verdict_reasoning || '').trim();
    const reasoningBlock = reasoning
      ? `<div class="section-title">Why this verdict</div><p class="verdict-reasoning">${escapeHtml(reasoning)}</p>`
      : '';

    verdictEl.innerHTML = `
      <div class="verdict-label">${escapeHtml(verdictTitle(v.verdict))}</div>
      <div style="font-size:12px;color:#8fa3bc;">Confidence: ${escapeHtml(v.confidence || '')} · Price signal: ${escapeHtml(
        v.price_signal_quality || ''
      )}${partial ? ' · <span class="status-err">Partial (step limit)</span>' : ''}</div>
      ${reasoningBlock}
      <p class="verdict-summary">${escapeHtml(v.summary || '')}</p>
      <div class="section-title">Pros</div>
      <ul class="simple">${(v.pros || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      <div class="section-title">Cons / red flags</div>
      <ul class="simple">${(v.cons_or_red_flags || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      <div class="section-title">Alternatives</div>
      ${alt || '<p style="color:#8fa3bc;">None listed</p>'}
      <div class="section-title">Citations</div>
      ${cites || '<p style="color:#8fa3bc;">None</p>'}`;
  }

  chrome.storage.local.get(['detailedAgentActivity'], (r) => {
    if (r.detailedAgentActivity === false) detailedAgent = false;
  });

  btnToggleDetail.addEventListener('click', () => {
    detailedAgent = !detailedAgent;
    chrome.storage.local.set({ detailedAgentActivity: detailedAgent });
    renderAgentRows();
  });

  btnCollapseTrace.addEventListener('click', () => {
    agentActivityCollapsed = !agentActivityCollapsed;
    shadow.getElementById('agent-activity')?.classList.toggle('agent-collapsed', agentActivityCollapsed);
  });

  openOpts.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  async function runResearch() {
    researchInProgress = true;
    configHint.hidden = true;
    const snap = window.ShopAgentSnapshot.build();
    fuOut.innerHTML = '';
    verdictEl.innerHTML = '<p style="color:#8fa3bc;">Starting research…</p>';
    agentEvents = [];
    timerStarted = 0;
    activityStatus = 'Running…';
    agentStatus.textContent = activityStatus;
    Object.assign(stripState, {
      context: 'active',
      reviews: '',
      price_deals: '',
      alternatives: '',
      verdict: '',
    });
    renderStripFromState();
    renderAgentRows();

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'RUN_RESEARCH',
        snapshot: snap,
      });
      if (!res?.ok) {
        if (/keys|API keys/i.test(res?.error || '')) {
          configHint.hidden = false;
        }
        verdictEl.innerHTML = `<p class="status-err">${escapeHtml(res?.error || 'Failed')}</p>`;
        agentStatus.textContent = 'Stopped';
        renderAgentRows();
        return;
      }
      renderTrust(res.verdict);
      renderVerdict(res.verdict, res.partial);
      const elapsed = timerStarted ? ((Date.now() - timerStarted) / 1000).toFixed(1) : '?';
      agentStatus.textContent = `Done in ${elapsed}s`;
      renderAgentRows();
    } catch (e) {
      verdictEl.innerHTML = `<p class="status-err">${escapeHtml(e?.message || String(e))}</p>`;
      agentStatus.textContent = 'Error';
      renderAgentRows();
    } finally {
      researchInProgress = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'AGENT_EVENT') return;
    pushEvent(msg.payload || {});
    if (researchInProgress) {
      agentStatus.textContent = activityStatus;
    }
  });

  btnRun.addEventListener('click', () => runResearch());

  const fuOutWrap = shadow.getElementById('fu-out-wrap');

  fuSend.addEventListener('click', async () => {
    const q = (fuInput.value || '').trim();
    if (!q || !latestVerdict) return;
    const pending = document.createElement('div');
    pending.className = 'follow-up-exchange';
    pending.innerHTML = `<div class="follow-up-q"><strong>Q:</strong> ${escapeHtml(q)}</div><div class="follow-up-a follow-up-pending">…</div>`;
    fuOut.appendChild(pending);
    fuOutWrap.scrollTop = fuOutWrap.scrollHeight;
    fuInput.value = '';
    const snap = window.ShopAgentSnapshot.build();
    const res = await chrome.runtime.sendMessage({
      type: 'RUN_FOLLOWUP',
      snapshot: snap,
      verdict: latestVerdict,
      question: q,
    });
    const aEl = pending.querySelector('.follow-up-a');
    aEl.classList.remove('follow-up-pending');
    const text = res?.ok ? res.answer : res?.error || 'Failed';
    aEl.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = 'A: ';
    aEl.appendChild(strong);
    aEl.appendChild(document.createTextNode(text));
    fuOutWrap.scrollTop = fuOutWrap.scrollHeight;
  });

  copyVerdict.addEventListener('click', async () => {
    if (!latestVerdict) return;
    await navigator.clipboard.writeText(JSON.stringify(latestVerdict, null, 2));
    copyVerdict.textContent = 'Copied';
    setTimeout(() => {
      copyVerdict.textContent = 'Copy verdict';
    }, 1500);
  });

  function maybeAutoRun() {
    const snap = window.ShopAgentSnapshot.build();
    const key = `${snap.url}|${snap.title}`;
    if (key === lastResearchKey) return;
    lastResearchKey = key;
    runResearch();
  }

  setTimeout(() => {
    chrome.storage.local.get(['openaiApiKey', 'searchApiKey'], (k) => {
      if (!k.openaiApiKey || !k.searchApiKey) {
        configHint.hidden = false;
        verdictEl.innerHTML =
          '<p style="color:#8fa3bc;">Add API keys in options to run research.</p>';
      } else {
        maybeAutoRun();
      }
    });
  }, DEBOUNCE_MS);

  window.addEventListener('popstate', () => {
    setTimeout(() => {
      lastResearchKey = '';
      maybeAutoRun();
      if (panelPrefs.classList.contains('is-active')) refreshPrefsTab();
    }, DEBOUNCE_MS);
  });
})();
