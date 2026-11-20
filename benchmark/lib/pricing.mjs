// USD per 1M tokens for the single model used across all tools in this benchmark.
// Source: GET https://api.avalai.ir/v1/models -> deepseek-chat.pricing
// (input 0.22, cached_input 0.007, output 0.66), read 2026-11-19.
export const MODEL = "deepseek-chat";
export const PRICE = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.22 };

export function costOf(u) {
  if (!u) return 0;
  return (
    ((u.input || 0) * PRICE.input +
      (u.output || 0) * PRICE.output +
      (u.cacheRead || 0) * PRICE.cacheRead +
      (u.cacheWrite || 0) * PRICE.cacheWrite) /
    1e6
  );
}
