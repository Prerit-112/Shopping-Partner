/**
 * Tool implementations: SearchAPI.io Google engine (web-search-first; plan §8).
 * open_retailer_search has no HTTP — builds a retailer search URL.
 *
 * Docs: https://www.searchapi.io/docs/google
 * GET https://www.searchapi.io/api/v1/search?engine=google&q=...&api_key=...
 */

const SEARCHAPI_BASE = 'https://www.searchapi.io/api/v1/search';

/** Map prefs region to Google `gl` (country) for localized SERPs. */
function glFromRegion(region) {
  const r = String(region || 'IN').toUpperCase();
  if (r === 'IN') return 'in';
  if (r === 'US') return 'us';
  if (r === 'EU') return 'de';
  return 'us';
}

function searchOpts(snapshot) {
  return {
    region: snapshot?.region,
    gl: snapshot?.gl,
    hl: snapshot?.hl,
  };
}

function summarizeSnippets(data) {
  const items = data?.organic_results || [];
  return items.slice(0, 10).map((r) => ({
    title: r.title || '',
    url: r.link || r.url || '',
    description: (r.snippet || '').slice(0, 400),
  }));
}

/**
 * @param {string} apiKey - SearchAPI.io API key
 * @param {string} query
 * @param {{ region?: string, gl?: string, hl?: string }} [opts]
 */
async function searchApiSearch(apiKey, query, opts = {}) {
  const url = new URL(SEARCHAPI_BASE);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  const gl = opts.gl || glFromRegion(opts.region);
  url.searchParams.set('gl', gl);
  url.searchParams.set('hl', opts.hl || 'en');

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`SearchAPI.io failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export async function runWebSearch(args, apiKey, snapshot) {
  const query = String(args.query || '').trim();
  const intent = args.intent || 'general';
  if (!query) {
    return { snippets: [], meta: { intent, count: 0 }, error: 'empty_query' };
  }
  const opts = searchOpts(snapshot);
  const data = await searchApiSearch(apiKey, query, opts);
  const snippets = summarizeSnippets(data);
  return {
    snippets,
    meta: { intent, query: query.slice(0, 200), count: snippets.length },
  };
}

/** 1–2 searches; derive confidence from result volume and snippet overlap (plan §8). */
export async function runPriceDealSignal(args, apiKey, snapshot) {
  const title = snapshot?.title || args.product_hint || 'product';
  const region = (args.region_hint || snapshot?.region || 'IN').toString();
  const q1 =
    args.primary_query ||
    `${title} price deal discount ${region === 'IN' ? 'India' : ''}`.trim();
  const q2 = `${title} best price ${region}`;
  const opts = searchOpts({ ...snapshot, region });
  let all = [];
  try {
    const d1 = await searchApiSearch(apiKey, q1, opts);
    all = summarizeSnippets(d1);
    const d2 = await searchApiSearch(apiKey, q2, opts);
    const s2 = summarizeSnippets(d2);
    const seen = new Set(all.map((x) => x.url));
    for (const s of s2) {
      if (!seen.has(s.url)) {
        seen.add(s.url);
        all.push(s);
      }
    }
  } catch (e) {
    return {
      snippets: [],
      confidence: 'low',
      source_type: 'snippet_aggregate',
      queries_used: [q1, q2],
      error: e?.message || String(e),
    };
  }

  const count = all.length;
  let confidence = 'low';
  if (count >= 5) confidence = 'medium';
  if (count >= 8 && new Set(all.map((x) => x.description.slice(0, 40))).size >= 4) {
    confidence = 'medium';
  }
  return {
    snippets: all.slice(0, 12),
    confidence,
    source_type: 'snippet_aggregate',
    queries_used: [q1.slice(0, 120), q2.slice(0, 120)],
  };
}

export async function runFindAlternatives(args, apiKey, snapshot) {
  const title = snapshot?.title || '';
  const budget = snapshot?.budgetHint || '';
  const q =
    String(args.query || '').trim() ||
    `alternatives to ${title} ${budget} buying guide`.trim();
  const opts = searchOpts(snapshot);
  const data = await searchApiSearch(apiKey, q, opts);
  const snippets = summarizeSnippets(data);
  return {
    snippets,
    meta: { query: q.slice(0, 200), count: snippets.length },
  };
}

export function runOpenRetailerSearch(args, snapshot) {
  const q = encodeURIComponent(
    String(args.query || snapshot?.title || 'product').trim() || 'product'
  );
  const retailer = String(args.retailer || snapshot?.retailer || 'amazon').toLowerCase();
  let url = `https://www.google.com/search?q=${q}`;
  if (retailer.includes('flipkart')) {
    url = `https://www.flipkart.com/search?q=${q}`;
  } else if (retailer.includes('amazon')) {
    const host =
      snapshot?.hostname && String(snapshot.hostname).includes('amazon.in')
        ? 'https://www.amazon.in'
        : 'https://www.amazon.com';
    url = `${host}/s?k=${q}`;
  }
  return { url, retailer, query: decodeURIComponent(q) };
}

/** Map tool payloads to UI quality (plan §8, §5). */
export function qualityFromToolResults(priceToolResult) {
  if (!priceToolResult || priceToolResult.error) return 'weak';
  const conf = priceToolResult.confidence;
  const n = (priceToolResult.snippets || []).length;
  if (conf === 'low' || n < 3) return 'weak';
  if (conf === 'medium' && n >= 5) return 'moderate';
  if (conf === 'medium') return 'moderate';
  return 'weak';
}
