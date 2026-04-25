/** Verdict + trust fields (mirrors plan §8). Used by service worker for JSON schema. */

export const PRICE_SIGNAL_QUALITY = ['strong', 'moderate', 'weak'];
export const VERDICT_ENUM = ['worth_it', 'wait_for_sale', 'better_option_exists'];
export const CONFIDENCE_ENUM = ['low', 'medium', 'high'];

export function verdictJsonSchema() {
  return {
    name: 'shopping_verdict',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'verdict',
        'confidence',
        'price_signal_quality',
        'verdict_reasoning',
        'summary',
        'pros',
        'cons_or_red_flags',
        'alternatives',
        'citations',
      ],
      properties: {
        verdict: {
          type: 'string',
          enum: VERDICT_ENUM,
          description:
            'worth_it: evidence supports buying at roughly the current context if price fits user budget; major pros outweigh cons. wait_for_sale: product is acceptable but value is poor, price is high vs snippets, or deal signal is weak—waiting or hunting a discount is rational. better_option_exists: at least one alternative in `alternatives` clearly better matches user priorities (price, features, reliability) than this PDP—must not be used without substantiating alternatives.',
        },
        confidence: { type: 'string', enum: CONFIDENCE_ENUM },
        price_signal_quality: {
          type: 'string',
          enum: PRICE_SIGNAL_QUALITY,
          description: 'Quality of price/deal evidence from web snippets only.',
        },
        verdict_reasoning: {
          type: 'string',
          description:
            '3–5 sentences, plain language: (1) strongest evidence from tools (reviews, complaints, price snippets) and gaps; (2) how the user\'s budget ceiling (if any), region, priorities, brands-to-avoid, and verdict factor weights (price, reviews, features, reliability — with their stated importances) shaped the trade-offs and final call — explicitly name which weighted factors pulled toward or against this verdict; (3) why this verdict fits better than the other two verdict enum values; (4) caveats from snippet-only or conflicting sources. Must not contradict the chosen verdict or lists.',
        },
        summary: {
          type: 'string',
          description:
            'One tight paragraph aligned with verdict and verdict_reasoning (including factor-weight trade-offs where relevant); no recommendation that conflicts with the enum.',
        },
        pros: { type: 'array', items: { type: 'string' } },
        cons_or_red_flags: { type: 'array', items: { type: 'string' } },
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'why', 'source_url'],
            properties: {
              name: { type: 'string' },
              why: { type: 'string' },
              source_url: { type: 'string' },
            },
          },
        },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'url'],
            properties: {
              label: { type: 'string' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

export function clampPriceSignalQuality(modelValue, telemetryHint) {
  const order = { weak: 0, moderate: 1, strong: 2 };
  const m = PRICE_SIGNAL_QUALITY.includes(modelValue) ? modelValue : 'weak';
  if (telemetryHint == null || !PRICE_SIGNAL_QUALITY.includes(telemetryHint)) return m;
  return order[telemetryHint] < order[m] ? telemetryHint : m;
}
