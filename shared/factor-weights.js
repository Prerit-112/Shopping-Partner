/** Default verdict factor weights (1–5, higher = more influence on the final verdict). */

export const FACTOR_KEYS = ['price', 'reviews', 'features', 'reliability'];

export const FACTOR_LABELS = {
  price: 'Price / value',
  reviews: 'Reviews & reputation',
  features: 'Features & specs',
  reliability: 'Reliability & support',
};

export const DEFAULT_FACTOR_WEIGHTS = {
  price: 3,
  reviews: 3,
  features: 3,
  reliability: 3,
};

function clampWeight(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 3;
  return Math.min(5, Math.max(1, x));
}

export function mergeFactorWeights(prefs) {
  const w = prefs?.factorWeights;
  const out = { ...DEFAULT_FACTOR_WEIGHTS };
  if (!w || typeof w !== 'object') return out;
  for (const k of FACTOR_KEYS) {
    if (w[k] != null) out[k] = clampWeight(w[k]);
  }
  return out;
}

/** Human-readable block for prompts: relative importance + normalized shares. */
export function formatFactorWeightsForPrompt(weights) {
  const merged = mergeFactorWeights({ factorWeights: weights });
  const sum = FACTOR_KEYS.reduce((s, k) => s + merged[k], 0) || 1;
  const lines = FACTOR_KEYS.map((k) => {
    const pct = ((merged[k] / sum) * 100).toFixed(0);
    const v = merged[k];
    const imp =
      Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
    return `  - ${FACTOR_LABELS[k]} (id: ${k}): importance ${imp}/5 — ~${pct}% of your stated factor emphasis`;
  });
  return `Verdict factor weights (you MUST respect these when trading off dimensions and when choosing among verdict enum values; higher importance means that dimension should sway the verdict more when evidence is mixed):\n${lines.join(
    '\n'
  )}\nWhen evidence is scarce on a high-importance factor, say so and temper confidence rather than ignoring that factor.`;
}
