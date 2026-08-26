const SENSITIVE_KEY = /authorization|api[-_]?key|secret|password|token|account[-_]?number|fund[-_]?account|beneficiary/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(item)]));
  }
  return typeof value === 'string' ? redactText(value) : value;
}

export function redactText(value: string) {
  return value
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(postgres(?:ql)?|rediss?):\/\/[^@\s]+@/gi, '$1://[REDACTED]@')
    .replace(/\b(api[-_]?key|secret|password|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export function safeErrorMessage(error: unknown, fallback = 'Operation failed') {
  return error instanceof Error ? redactText(error.message) : fallback;
}
