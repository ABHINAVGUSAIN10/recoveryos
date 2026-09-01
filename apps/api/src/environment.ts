import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().regex(/^\d+$/, 'must be a valid port').default('3001'),
  DATABASE_URL: z.string().min(1).refine(value => /^postgres(?:ql)?:\/\//.test(value), 'must be a PostgreSQL URL'),
  REDIS_URL: z.string().min(1).refine(value => /^rediss?:\/\//.test(value), 'must be a Redis URL'),
  LOG_REQUESTS: z.enum(['true', 'false']).default('true'),
  SIMULATION_MODE: z.enum(['true', 'false']).default('true'),
  ENABLE_LIVE_DEMO: z.enum(['true', 'false']).default('false'),
  ENABLE_REVENUE_DEMO: z.enum(['true', 'false']).default('false'),
  ENABLE_RAZORPAYX_TEST_DEMO: z.enum(['true', 'false']).default('false'),
  RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID: z.string().optional(),
  RAZORPAYX_TEST_DEMO_COOLDOWN_SECONDS: z.string().regex(/^\d+$/, 'must be seconds').default('300'),
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
  AI_REVENUE_REQUEST_INTERVAL_MS: z.string().regex(/^\d+$/, 'must be milliseconds').default('9000'),
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
  const revenueDemo = env.ENABLE_REVENUE_DEMO === 'true';
  const razorpayTestDemo = env.ENABLE_RAZORPAYX_TEST_DEMO === 'true';

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
  const testDemoCooldownSeconds = Number.parseInt(env.RAZORPAYX_TEST_DEMO_COOLDOWN_SECONDS, 10);
  const revenueRequestIntervalMs = Number.parseInt(env.AI_REVENUE_REQUEST_INTERVAL_MS, 10);
  if (liveDemo && liveExecution) errors.push('ENABLE_LIVE_DEMO requires SIMULATION_MODE=true');
  if (revenueDemo && liveExecution) errors.push('ENABLE_REVENUE_DEMO requires SIMULATION_MODE=true');
  if (razorpayTestDemo) {
    if (liveExecution) errors.push('ENABLE_RAZORPAYX_TEST_DEMO requires SIMULATION_MODE=true');
    if (!tokenAuth) errors.push('ENABLE_RAZORPAYX_TEST_DEMO requires AUTH_MODE=token');
    if (!env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') || !env.RAZORPAY_KEY_SECRET) errors.push('ENABLE_RAZORPAYX_TEST_DEMO requires a Razorpay Test Mode key pair');
    if (!env.RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID?.startsWith('fa_')) errors.push('RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID must identify the dedicated Test Mode fund account');
  }
  if (demoDelaySeconds < 1 || demoDelaySeconds > 60) errors.push('DEMO_RETRY_DELAY_SECONDS must be between 1 and 60');
  if (testDemoCooldownSeconds < 30 || testDemoCooldownSeconds > 3600) errors.push('RAZORPAYX_TEST_DEMO_COOLDOWN_SECONDS must be between 30 and 3600');
  if (revenueRequestIntervalMs < 0 || revenueRequestIntervalMs > 60_000) errors.push('AI_REVENUE_REQUEST_INTERVAL_MS must be between 0 and 60000');

  if (errors.length) throw new Error(`Unsafe environment configuration: ${errors.join('; ')}`);
  return env;
}
