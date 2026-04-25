/** Stable storage key for per-product preference overrides (Amazon ASIN or URL path). */

export function productPrefsStorageKey(snapshot) {
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
