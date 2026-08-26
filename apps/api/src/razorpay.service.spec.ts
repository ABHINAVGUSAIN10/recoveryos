import {
  incidentIdFromRecoveryReference,
  RazorpayExecutionUncertainError,
  RazorpayRecoveryBlockedError,
  RazorpayService,
  recoveryIdempotencyKey,
  recoveryReferenceId,
} from './razorpay.service';

describe('RazorpayService guarded payout adapter', () => {
  const savedEnv = { ...process.env };
  const savedFetch = global.fetch;
  const incidentId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    process.env.SIMULATION_MODE = 'false';
    process.env.RAZORPAY_KEY_ID = 'test-id';
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
    delete process.env.RAZORPAY_TIMEOUT_MS;
    global.fetch = savedFetch;
  });

  afterAll(() => { process.env = savedEnv; global.fetch = savedFetch; });

  it('does not copy provider response bodies into thrown errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: jest.fn().mockResolvedValue({ account_number: 'sensitive', token: 'private' }) }) as never;

    await expect(new RazorpayService().fetchPayout('pout_1')).rejects.toThrow('Razorpay request failed with status 400');
    await expect(new RazorpayService().fetchPayout('pout_1')).rejects.not.toThrow('sensitive');
  });

  it('maps the typed request to Razorpay snake-case fields and mandatory idempotency header', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ id: 'pout_new', status: 'processing' }) }) as never;
    const service = new RazorpayService();

    await service.createPayout({
      accountNumber: '1234567890', fundAccountId: 'fa_1', amount: 1000, currency: 'INR', mode: 'IMPS',
      purpose: 'payout', referenceId: 'rr_reference', narration: 'RecoveryOS retry', notes: { source: 'recoveryos' },
    }, 'rr_12345678901234567890123456789012');

    const [, request] = (global.fetch as jest.Mock).mock.calls[0];
    expect(request.headers['X-Payout-Idempotency']).toBe('rr_12345678901234567890123456789012');
    expect(JSON.parse(request.body)).toEqual({
      account_number: '1234567890', fund_account_id: 'fa_1', amount: 1000, currency: 'INR', mode: 'IMPS',
      purpose: 'payout', queue_if_low_balance: false, reference_id: 'rr_reference', narration: 'RecoveryOS retry',
      notes: { source: 'recoveryos' },
    });
  });

  it('never creates a fresh payout while the original is active', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ id: 'pout_1', status: 'processing' }) }) as never;

    await expect(new RazorpayService().executeRecovery('rr_key', 'pout_1', incidentId))
      .rejects.toBeInstanceOf(RazorpayExecutionUncertainError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe('GET');
  });

  it('recreates only a confirmed failed payout with traceable context', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockResolvedValue({
        id: 'pout_1', status: 'failed', debit_account_number: '1234567890', fund_account_id: 'fa_1',
        amount: 2500, currency: 'INR', mode: 'IMPS', purpose: 'payout', narration: 'Original payout',
      }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ id: 'pout_retry', status: 'processing' }) }) as never;
    const key = recoveryIdempotencyKey(incidentId, 1);

    await expect(new RazorpayService().executeRecovery(key, 'pout_1', incidentId))
      .resolves.toEqual({ id: 'pout_retry', status: 'processing' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, createRequest] = (global.fetch as jest.Mock).mock.calls[1];
    const body = JSON.parse(createRequest.body);
    expect(body).toMatchObject({
      account_number: '1234567890', fund_account_id: 'fa_1', amount: 2500, queue_if_low_balance: false,
      reference_id: recoveryReferenceId(incidentId),
      notes: { recovery_incident_id: incidentId, recovery_original_payout_id: 'pout_1' },
    });
    expect(createRequest.headers['X-Payout-Idempotency']).toBe(key);
  });

  it('blocks recreation when terminal status or required provider context is unsafe', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: jest.fn().mockResolvedValue({ id: 'pout_1', status: 'reversed' }) }) as never;
    await expect(new RazorpayService().executeRecovery('rr_key', 'pout_1', incidentId)).rejects.toBeInstanceOf(RazorpayRecoveryBlockedError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('treats POST 5xx and transport failures as execution-unknown', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: jest.fn() }) as never;
    const request = { accountNumber: '1', fundAccountId: 'fa_1', amount: 100, currency: 'INR', mode: 'IMPS', purpose: 'payout', referenceId: 'rr_ref' };
    await expect(new RazorpayService().createPayout(request, 'rr_key')).rejects.toBeInstanceOf(RazorpayExecutionUncertainError);

    global.fetch = jest.fn().mockRejectedValue(new TypeError('network failed')) as never;
    await expect(new RazorpayService().createPayout(request, 'rr_key')).rejects.toBeInstanceOf(RazorpayExecutionUncertainError);
  });

  it('generates provider-safe keys and reversible incident references', () => {
    const key = recoveryIdempotencyKey(incidentId, 2);
    const reference = recoveryReferenceId(incidentId);
    expect(key).toMatch(/^rr_[0-9a-f]{32}$/);
    expect(key.length).toBeLessThanOrEqual(36);
    expect(reference.length).toBeLessThanOrEqual(40);
    expect(incidentIdFromRecoveryReference(reference)).toBe(incidentId);
  });
});
