/** Continuous budget preference: maximum comfortable spend in INR (0 = flexible / no cap). */

export const BUDGET_MAX_INR_CAP = 500000;
export const BUDGET_SLIDER_STEP = 500;

export function normalizeBudgetMaxInr(raw) {
  const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(BUDGET_MAX_INR_CAP, n);
}

/** Map old discrete bands to a representative INR ceiling for one-time migration. */
export function migrateLegacyBudgetBand(band) {
  switch (String(band || '')) {
    case 'under_15k_inr':
      return 15000;
    case '15k_40k_inr':
      return 40000;
    case 'flex':
    case 'unspecified':
    default:
      return 0;
  }
}

/** Resolve ceiling from merged prefs (supports legacy budgetBand if still present). */
export function effectiveBudgetMaxInr(prefs) {
  const p = prefs || {};
  let max = normalizeBudgetMaxInr(p.budgetMaxInr);
  if (max <= 0 && p.budgetBand != null && p.budgetBand !== 'flex' && p.budgetBand !== 'unspecified') {
    max = normalizeBudgetMaxInr(migrateLegacyBudgetBand(p.budgetBand));
  }
  return max;
}

/** Single line for the system prompt (plain language, no enums). */
export function formatBudgetPreferenceLine(prefs) {
  const max = effectiveBudgetMaxInr(prefs);
  if (max <= 0) {
    return 'Budget: flexible — no fixed spending ceiling (use on-page price, priorities, and judgment).';
  }
  const rounded = Math.round(max);
  return `Approximate maximum comfortable spend for this shopper: about ₹${rounded.toLocaleString(
    'en-IN'
  )} INR. Treat as a soft guide, not a hard limit; live and snippet prices may differ.`;
}
