import { config } from 'dotenv';

config({ path: '../../.env' });

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ReadinessOptions = {
  keyId?: string;
  keySecret?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export type RazorpayReadinessResult = {
  probe: 'razorpay-banking-balances';
  readOnly: true;
  reachable: boolean;
  authenticated: boolean;
  authorizationRejected: boolean;
  status: number;
};

export async function runRazorpayReadiness(options: ReadinessOptions = {}): Promise<RazorpayReadinessResult> {
  const keyId = options.keyId ?? process.env.RAZORPAY_KEY_ID;
  const keySecret = options.keySecret ?? process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials are not configured.');

  const timeoutMs = options.timeoutMs ?? Number(process.env.RAZORPAY_TIMEOUT_MS || 10_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)('https://api.razorpay.com/v1/banking_balances', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      },
      signal: controller.signal,
    });

    await response.body?.cancel();
    return {
      probe: 'razorpay-banking-balances',
      readOnly: true,
      reachable: true,
      authenticated: response.ok,
      authorizationRejected: response.status === 401 || response.status === 403,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

if (require.main === module) {
  if (!process.argv.includes('--read-only')) {
    console.error('Refusing to run without the explicit --read-only guard.');
    process.exit(1);
  }

  runRazorpayReadiness()
    .then(result => {
      console.log(JSON.stringify(result));
      if (!result.authenticated) process.exitCode = 1;
    })
    .catch(error => {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'Razorpay readiness probe timed out.'
        : error instanceof Error ? error.message : 'Razorpay readiness probe failed.';
      console.error(reason);
      process.exit(1);
    });
}
