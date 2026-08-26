import { createHash } from 'crypto';
import { config } from 'dotenv';

config({ path: '../../.env' });

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ExerciseOptions = { keyId?: string; keySecret?: string; simulationMode?: string; fetchImpl?: FetchLike; timeoutMs?: number };
type BankingBalance = { account_number?: string; available_amount?: number };
type FundAccount = { id?: string; active?: boolean; account_type?: string };
type Collection<T> = { items?: T[] };
type Payout = { id: string; status: string };

export type SandboxExerciseResult = {
  exercise: 'funded-processing-webhook';
  testMode: true;
  amountPaise: 100;
  payoutId: string;
  payoutStatus: string;
  referenceId: string;
  expectedProcessing: boolean;
};

export async function runRazorpaySandboxExercise(options: ExerciseOptions = {}): Promise<SandboxExerciseResult> {
  const keyId = options.keyId ?? process.env.RAZORPAY_KEY_ID;
  const keySecret = options.keySecret ?? process.env.RAZORPAY_KEY_SECRET;
  const simulationMode = options.simulationMode ?? process.env.SIMULATION_MODE;
  if (!keyId?.startsWith('rzp_test_') || !keySecret) throw new Error('A Razorpay Test Mode key pair is required.');
  if (simulationMode !== 'true') throw new Error('RecoveryOS SIMULATION_MODE=true is required for this exercise.');

  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  const timeoutMs = options.timeoutMs ?? Number(process.env.RAZORPAY_TIMEOUT_MS || 10_000);
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.razorpay.com${path}`, {
        ...init,
        headers: { Accept: 'application/json', Authorization: authorization, ...(init.headers || {}) },
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Razorpay sandbox request failed with status ${response.status}.`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  };

  const balances = await request<Collection<BankingBalance>>('/v1/banking_balances?count=100');
  const source = balances.items?.find(item =>
    typeof item.account_number === 'string' && item.account_number.length > 0 && Number(item.available_amount) >= 100,
  );
  if (!source?.account_number) throw new Error('No Test Mode payout account has the required ₹1 dummy balance.');

  const fundAccounts = await request<Collection<FundAccount>>('/v1/fund_accounts?count=100');
  const fundAccount = fundAccounts.items?.find(item =>
    item.active !== false && typeof item.id === 'string' && ['vpa', 'bank_account'].includes(item.account_type || ''),
  );
  if (!fundAccount?.id || !fundAccount.account_type) throw new Error('No active VPA or bank Test Mode fund account is available.');

  const referenceId = 'recoveryos-funded-webhook-v1';
  const idempotencyKey = createHash('sha256')
    .update(`${referenceId}:${source.account_number}:${fundAccount.id}`)
    .digest('hex')
    .slice(0, 35);
  const payout = await request<Payout>('/v1/payouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payout-Idempotency': idempotencyKey },
    body: JSON.stringify({
      account_number: source.account_number,
      fund_account_id: fundAccount.id,
      amount: 100,
      currency: 'INR',
      mode: fundAccount.account_type === 'vpa' ? 'UPI' : 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: false,
      reference_id: referenceId,
      narration: 'RecoveryOS sandbox',
      notes: { recoveryos_exercise: 'funded_webhook_v1' },
    }),
  });

  return {
    exercise: 'funded-processing-webhook',
    testMode: true,
    amountPaise: 100,
    payoutId: payout.id,
    payoutStatus: payout.status,
    referenceId,
    expectedProcessing: payout.status.toLowerCase() === 'processing',
  };
}

if (require.main === module) {
  if (!process.argv.includes('--create-funded-test-payout')) {
    console.error('Refusing to run without --create-funded-test-payout.');
    process.exit(1);
  }
  runRazorpaySandboxExercise()
    .then(result => {
      console.log(JSON.stringify(result));
      if (!result.expectedProcessing) process.exitCode = 1;
    })
    .catch(error => {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'Razorpay sandbox exercise timed out.'
        : error instanceof Error ? error.message : 'Razorpay sandbox exercise failed.';
      console.error(reason);
      process.exit(1);
    });
}
