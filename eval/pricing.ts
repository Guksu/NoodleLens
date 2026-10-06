/** 1M 토큰당 달러(Standard). 2026-10-06 공식 가격 페이지 기준 — 비용 추정용 */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'mock-echo': { input: 0, output: 0 },
};

export function estimateCost(model: string, inputTokens = 0, outputTokens = 0): number | null {
  const price = PRICING[model];
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
