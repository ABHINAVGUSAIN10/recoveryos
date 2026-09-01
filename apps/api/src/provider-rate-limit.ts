export const DEFAULT_GROQ_EVALUATION_INTERVAL_MS = 9_000;

type HeaderContainer = { get?: (name: string) => string | null } & Record<string, unknown>;

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const container = headers as HeaderContainer;
  const fromGetter = container.get?.(name);
  if (fromGetter) return fromGetter;
  const direct = container[name] ?? container[name.toLowerCase()];
  return typeof direct === 'string' ? direct : undefined;
}

export function rateLimitRetryDelayMs(error: unknown, maximumMs = 30_000): number {
  if (!error || typeof error !== 'object' || (error as { status?: number }).status !== 429) return 0;
  const retryAfter = headerValue((error as { headers?: unknown }).headers, 'retry-after');
  let delayMs = 2_000;
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) delayMs = Math.ceil(seconds * 1_000);
    else {
      const retryDate = Date.parse(retryAfter);
      if (Number.isFinite(retryDate)) delayMs = Math.max(0, retryDate - Date.now());
    }
  }
  // A small margin avoids retrying on the exact rolling-window boundary and
  // consuming the only bounded retry while the provider still reports 429.
  return Math.min(maximumMs, Math.max(1_000, delayMs + 750));
}

export function evaluationPacingDelayMs(lastStartedAt: number | null, now: number, intervalMs: number): number {
  if (lastStartedAt === null || intervalMs <= 0) return 0;
  return Math.max(0, lastStartedAt + intervalMs - now);
}

export function wait(delayMs: number) {
  return delayMs > 0 ? new Promise<void>(resolve => setTimeout(resolve, delayMs)) : Promise.resolve();
}
