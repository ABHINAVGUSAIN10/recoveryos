import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().regex(/^\d+$/, 'must be a valid port').default('3001'),
  DATABASE_URL: z.string().min(1).refine(value => /^postgres(?:ql)?:\/\//.test(value), 'must be a PostgreSQL URL'),
  REDIS_URL: z.string().min(1).refine(value => /^rediss?:\/\//.test(value), 'must be a Redis URL'),
  LOG_REQUESTS: z.enum(['true', 'false']).default('true'),
  SIMULATION_MODE: z.enum(['true', 'false']).default('true'),
  ENABLE_LIVE_DEMO: z.enum(['true', 'false']).default('false'),
  DEMO_RETRY_DELAY_SECONDS: z.string().regex(/^\d+$/, 'must be seconds').default('5'),
  AUTH_MODE: z.enum(['disabled', 'token']).default('disabled'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_TIMEOUT_MS: z.string().regex(/^\d+$/, 'must be milliseconds').default('10000'),
  VIEWER_API_TOKEN: z.string().optional(),
  OPERATOR_API_TOKEN: z.string().optional(),
  ADMIN_API_TOKEN: z.string().optional(),
  AI_THINKING_MODE: z.enum(['enabled', 'disabled']).default('disabled'),
}).passthrough();

export function validateEnvironment(values: Record<string, unknown>) {
  const result = environmentSchema.safeParse(values);
  if (!result.success) {
    const details = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const env = result.data;
  const errors: string[] = [];
  const production = env.NODE_ENV === 'production';
  const tokenAuth = env.AUTH_MODE === 'token';
  const liveExecution = env.SIMULATION_MODE === 'false';
  const liveDemo = env.ENABLE_LIVE_DEMO === 'true';

  if (production && !tokenAuth) errors.push('AUTH_MODE must be token when NODE_ENV is production');
  if (production && (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS.includes('*'))) errors.push('ALLOWED_ORIGINS must explicitly list trusted origins in production');
  if (production && (!env.RAZORPAY_WEBHOOK_SECRET || /replace|example/i.test(env.RAZORPAY_WEBHOOK_SECRET))) errors.push('RAZORPAY_WEBHOOK_SECRET must be configured in production');

  if (tokenAuth) {
    for (const name of ['VIEWER_API_TOKEN', 'OPERATOR_API_TOKEN', 'ADMIN_API_TOKEN'] as const) {
      if (!env[name] || env[name]!.length < 32 || /replace|example/i.test(env[name]!)) errors.push(`${name} must contain at least 32 non-placeholder characters when token authentication is enabled`);
    }
  }

  if (liveExecution) {
    if (!env.RAZORPAY_KEY_ID || /replace|example/i.test(env.RAZORPAY_KEY_ID)) errors.push('RAZORPAY_KEY_ID is required when simulation mode is disabled');
    if (!env.RAZORPAY_KEY_SECRET || /replace|example/i.test(env.RAZORPAY_KEY_SECRET)) errors.push('RAZORPAY_KEY_SECRET is required when simulation mode is disabled');
    if (!tokenAuth) errors.push('AUTH_MODE must be token when simulation mode is disabled');
  }

  const demoDelaySeconds = Number.parseInt(env.DEMO_RETRY_DELAY_SECONDS, 10);
  if (liveDemo && liveExecution) errors.push('ENABLE_LIVE_DEMO requires SIMULATION_MODE=true');
  if (demoDelaySeconds < 1 || demoDelaySeconds > 60) errors.push('DEMO_RETRY_DELAY_SECONDS must be between 1 and 60');

  if (errors.length) throw new Error(`Unsafe environment configuration: ${errors.join('; ')}`);
  return env;
}
