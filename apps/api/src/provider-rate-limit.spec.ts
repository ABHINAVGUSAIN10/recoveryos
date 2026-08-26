import { evaluationPacingDelayMs, rateLimitRetryDelayMs } from './provider-rate-limit';

describe('provider rate-limit helpers', () => {
  it('paces request starts without adding delay after slow requests', () => {
    expect(evaluationPacingDelayMs(null, 1_000, 4_000)).toBe(0);
    expect(evaluationPacingDelayMs(1_000, 2_500, 4_000)).toBe(2_500);
    expect(evaluationPacingDelayMs(1_000, 5_500, 4_000)).toBe(0);
  });

  it('honors numeric Retry-After and caps excessive provider delays', () => {
    expect(rateLimitRetryDelayMs({ status: 429, headers: { 'retry-after': '1.5' } })).toBe(1_500);
    expect(rateLimitRetryDelayMs({ status: 429, headers: { 'retry-after': '120' } })).toBe(30_000);
    expect(rateLimitRetryDelayMs({ status: 500 })).toBe(0);
  });

  it('uses a bounded fallback when a 429 omits Retry-After', () => {
    expect(rateLimitRetryDelayMs({ status: 429, headers: {} })).toBe(2_000);
  });
});
