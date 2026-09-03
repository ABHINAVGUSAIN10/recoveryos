import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

export type PayoutCreateRequest = {
  accountNumber: string;
  fundAccountId: string;
  amount: number;
  currency: string;
  mode: string;
  purpose: string;
  referenceId: string;
  narration?: string;
  notes?: Record<string, string>;
  queueIfLowBalance?: boolean;
};

export type RazorpayPayout = {
  id: string;
  status: string;
  fund_account_id?: string;
  amount?: number;
  currency?: string;
  mode?: string;
  purpose?: string;
  reference_id?: string | null;
  narration?: string | null;
  debit_account_number?: string;
  account_number?: string;
  notes?: Record<string, unknown>;
  status_details?: Record<string, unknown>;
  [key: string]: unknown;
};

type BankingBalance = { account_number?: string; available_amount?: number };
type FundAccount = { id?: string; active?: boolean; account_type?: string };
type Collection<T> = { items?: T[] };

export const RAZORPAYX_TEST_DEMO_AMOUNT_PAISE = 1_000_000;
export const RAZORPAYX_TEST_DEMO_CONFIRMATION = 'CREATE INR 10000 TEST PAYOUT';

export class RazorpayExecutionUncertainError extends Error {
  override name = 'RazorpayExecutionUncertainError';
}

export class RazorpayRecoveryBlockedError extends Error {
  override name = 'RazorpayRecoveryBlockedError';
}

const ACTIVE_PAYOUT_STATUSES = new Set(['pending', 'queued', 'processing', 'scheduled', 'initiated']);

export function recoveryIdempotencyKey(incidentId: string, attempt: number) {
  const digest = createHash('sha256').update(`${incidentId}:${attempt}`).digest('hex').slice(0, 32);
  return `rr_${digest}`;
}

export function recoveryReferenceId(incidentId: string) {
  const compact = incidentId.replaceAll('-', '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? `rr_${compact}` : `rr_${createHash('sha256').update(incidentId).digest('hex').slice(0, 32)}`;
}

export function incidentIdFromRecoveryReference(referenceId: unknown) {
  if (typeof referenceId !== 'string') return null;
  const match = /^rr_([0-9a-f]{32})$/i.exec(referenceId);
  if (!match) return null;
  const value = match[1].toLowerCase();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

@Injectable()
export class RazorpayService {
  private get simulation() { return process.env.SIMULATION_MODE !== 'false'; }

  testDemoConfiguration() {
    const enabled = process.env.ENABLE_RAZORPAYX_TEST_DEMO === 'true';
    const simulationSafe = this.simulation;
    const testCredentials = Boolean(process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && process.env.RAZORPAY_KEY_SECRET);
    const fundAccountId = process.env.RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID || '';
    const fundAccountConfigured = Boolean(fundAccountId.startsWith('fa_'));
    return {
      enabled,
      ready: enabled && simulationSafe && testCredentials && fundAccountConfigured,
      testMode: testCredentials,
      simulationSafe,
      fundAccountConfigured,
      fundAccountDisplay: fundAccountConfigured ? `fa_…${fundAccountId.slice(-6)}` : undefined,
      amountPaise: RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
      confirmation: RAZORPAYX_TEST_DEMO_CONFIRMATION,
    };
  }

  async fetchPayout(payoutId: string): Promise<RazorpayPayout> {
    if (this.simulation) return { id: payoutId, status: 'processing', status_details: { description: 'Simulation preserves ambiguous provider state until an explicit terminal fixture arrives.' } };
    return this.request(`/v1/payouts/${encodeURIComponent(payoutId)}`, 'GET');
  }

  async createPayout(input: PayoutCreateRequest, idempotencyKey: string): Promise<RazorpayPayout> {
    if (this.simulation) return { id: `sim_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 14)}`, status: 'processing', ...input };
    const payload = {
      account_number: input.accountNumber,
      fund_account_id: input.fundAccountId,
      amount: input.amount,
      currency: input.currency,
      mode: input.mode,
      purpose: input.purpose,
      queue_if_low_balance: input.queueIfLowBalance ?? false,
      reference_id: input.referenceId,
      ...(input.narration ? { narration: input.narration } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    return this.request('/v1/payouts', 'POST', payload, idempotencyKey);
  }

  async executeRecovery(idempotencyKey: string, payoutId: string, incidentId?: string, remediatedFundAccountId?: string | null) {
    if (this.simulation) return { id: payoutId, status: 'processed', simulated: true };
    if (!incidentId) throw new RazorpayRecoveryBlockedError('Recovery incident context is required.');
    const original = await this.fetchPayout(payoutId);
    const originalStatus = String(original.status || '').toLowerCase();
    if (originalStatus === 'processed') return { ...original, recovery_original_processed: true };
    if (ACTIVE_PAYOUT_STATUSES.has(originalStatus)) {
      throw new RazorpayExecutionUncertainError('Original payout is not terminal; no recovery payout was created.');
    }
    if (originalStatus !== 'failed') {
      throw new RazorpayRecoveryBlockedError(`Original payout status ${originalStatus || 'unknown'} is not eligible for automatic recreation.`);
    }

    const accountNumber = original.account_number ?? original.debit_account_number;
    const fundAccountId = remediatedFundAccountId?.startsWith('fa_') ? remediatedFundAccountId : original.fund_account_id;
    const amount = original.amount;
    const currency = original.currency;
    const mode = original.mode;
    const purpose = original.purpose;
    if (!accountNumber || !fundAccountId || !Number.isInteger(amount) || Number(amount) < 100 || !currency || !mode || !purpose) {
      throw new RazorpayRecoveryBlockedError('Original payout is missing required recreation fields.');
    }
    const narration = typeof original.narration === 'string' && /^[A-Za-z0-9 ]{1,30}$/.test(original.narration)
      ? original.narration
      : 'RecoveryOS retry';
    return this.createPayout({
      accountNumber,
      fundAccountId,
      amount: Number(amount),
      currency,
      mode,
      purpose,
      referenceId: recoveryReferenceId(incidentId),
      narration,
      queueIfLowBalance: false,
      notes: { recovery_incident_id: incidentId, recovery_original_payout_id: payoutId },
    }, idempotencyKey);
  }

  async executeTestDemoPayout(idempotencyKey: string, incidentId: string): Promise<RazorpayPayout> {
    const configuration = this.testDemoConfiguration();
    if (!configuration.ready) throw new RazorpayRecoveryBlockedError('RazorpayX Test Mode demonstration is not safely configured.');

    const balances = await this.request<Collection<BankingBalance>>('/v1/banking_balances?count=100', 'GET');
    const source = balances.items?.find(item =>
      typeof item.account_number === 'string'
      && item.account_number.length > 0
      && Number(item.available_amount) >= RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
    );
    if (!source?.account_number) throw new RazorpayRecoveryBlockedError('No RazorpayX Test Mode account has the required dummy balance.');

    const configuredFundAccountId = process.env.RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID!;
    const fundAccounts = await this.request<Collection<FundAccount>>('/v1/fund_accounts?count=100', 'GET');
    const fundAccount = fundAccounts.items?.find(item =>
      item.id === configuredFundAccountId
      && item.active !== false
      && ['vpa', 'bank_account'].includes(item.account_type || ''),
    );
    if (!fundAccount?.id || !fundAccount.account_type) throw new RazorpayRecoveryBlockedError('The configured RazorpayX Test Mode fund account is unavailable or inactive.');

    return this.request<RazorpayPayout>('/v1/payouts', 'POST', {
      account_number: source.account_number,
      fund_account_id: fundAccount.id,
      amount: RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
      currency: 'INR',
      mode: fundAccount.account_type === 'vpa' ? 'UPI' : 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: false,
      reference_id: recoveryReferenceId(incidentId),
      narration: 'RecoveryOS test retry',
      notes: { recovery_incident_id: incidentId, recoveryos_demo: 'razorpayx_test_retry' },
    }, idempotencyKey);
  }

  async fetchTestDemoPayout(payoutId: string): Promise<RazorpayPayout> {
    if (!this.testDemoConfiguration().ready) throw new RazorpayRecoveryBlockedError('RazorpayX Test Mode demonstration is not safely configured.');
    return this.request<RazorpayPayout>(`/v1/payouts/${encodeURIComponent(payoutId)}`, 'GET');
  }

  private async request<T = RazorpayPayout>(path: string, method: 'GET' | 'POST', body?: unknown, idempotencyKey?: string): Promise<T> {
    const key = process.env.RAZORPAY_KEY_ID;
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key || !secret) throw new Error('Razorpay credentials are not configured');
    const configuredTimeout = Number.parseInt(process.env.RAZORPAY_TIMEOUT_MS || '10000', 10);
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(30_000, Math.max(1_000, configuredTimeout)) : 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetch(`https://api.razorpay.com${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'X-Payout-Idempotency': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!result.ok) {
        if (method === 'POST' && result.status >= 500) throw new RazorpayExecutionUncertainError(`Razorpay payout request returned status ${result.status}; outcome requires reconciliation.`);
        throw new Error(`Razorpay request failed with status ${result.status}`);
      }
      return await result.json() as T;
    } catch (error) {
      if (error instanceof RazorpayExecutionUncertainError || (error instanceof Error && error.message.startsWith('Razorpay request failed with status'))) throw error;
      throw new RazorpayExecutionUncertainError('Razorpay request did not return a confirmed outcome; reconciliation is required.');
    } finally {
      clearTimeout(timer);
    }
  }
}
