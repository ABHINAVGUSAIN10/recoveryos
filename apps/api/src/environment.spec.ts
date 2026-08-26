import { validateEnvironment } from './environment';

const base = {
  DATABASE_URL: 'postgresql://example.invalid/recoveryos',
  REDIS_URL: 'rediss://example.invalid:6379',
};

describe('validateEnvironment', () => {
  it('accepts local simulation defaults', () => {
    expect(validateEnvironment(base)).toMatchObject({ SIMULATION_MODE: 'true', AUTH_MODE: 'disabled' });
  });

  it('rejects an unauthenticated production deployment', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', RAZORPAY_WEBHOOK_SECRET: 'safe-webhook-secret' }))
      .toThrow('AUTH_MODE must be token');
  });

  it('rejects long placeholder credentials', () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      AUTH_MODE: 'token',
      ALLOWED_ORIGINS: 'https://recovery.example.com',
      RAZORPAY_WEBHOOK_SECRET: 'replace-with-a-long-random-secret',
      VIEWER_API_TOKEN: 'replace-with-at-least-32-random-characters',
      OPERATOR_API_TOKEN: 'replace-with-at-least-32-random-characters',
      ADMIN_API_TOKEN: 'replace-with-at-least-32-random-characters',
    })).toThrow('non-placeholder');
  });

  it('rejects live execution without provider credentials', () => {
    expect(() => validateEnvironment({ ...base, SIMULATION_MODE: 'false', AUTH_MODE: 'token', VIEWER_API_TOKEN: 'v'.repeat(32), OPERATOR_API_TOKEN: 'o'.repeat(32), ADMIN_API_TOKEN: 'a'.repeat(32) }))
      .toThrow('RAZORPAY_KEY_ID is required');
  });

  it('accepts an authenticated production simulation', () => {
    expect(validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      AUTH_MODE: 'token',
      ALLOWED_ORIGINS: 'https://recovery.example.com',
      RAZORPAY_WEBHOOK_SECRET: 'safe-webhook-secret',
      VIEWER_API_TOKEN: 'v'.repeat(32),
      OPERATOR_API_TOKEN: 'o'.repeat(32),
      ADMIN_API_TOKEN: 'a'.repeat(32),
    })).toMatchObject({ NODE_ENV: 'production', SIMULATION_MODE: 'true' });
  });
});
