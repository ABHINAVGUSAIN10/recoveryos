import { runRazorpaySandboxExercise } from './razorpay-sandbox-exercise';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('Razorpay funded Test Mode webhook exercise', () => {
  it('uses existing entities and creates one deterministic ₹1 processing payout', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ account_number: 'test-account', available_amount: 100_000 }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'fa_test', active: true, account_type: 'vpa' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'pout_test', status: 'processing' }));

    const result = await runRazorpaySandboxExercise({
      keyId: 'rzp_test_key', keySecret: 'test-secret', simulationMode: 'true', fetchImpl,
    });

    expect(result).toEqual({
      exercise: 'funded-processing-webhook', testMode: true, amountPaise: 100,
      payoutId: 'pout_test', payoutStatus: 'processing', referenceId: 'recoveryos-funded-webhook-v1', expectedProcessing: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const payoutCall = fetchImpl.mock.calls[2];
    expect(payoutCall[0]).toBe('https://api.razorpay.com/v1/payouts');
    expect(payoutCall[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Payout-Idempotency': expect.stringMatching(/^[a-f0-9]{35}$/) }),
    }));
    expect(JSON.parse(String(payoutCall[1].body))).toMatchObject({
      amount: 100, mode: 'UPI', queue_if_low_balance: false, fund_account_id: 'fa_test',
    });
  });

  it('selects IMPS for a bank fund account', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ account_number: 'test-account', available_amount: 100 }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'fa_bank', active: true, account_type: 'bank_account' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'pout_bank', status: 'processing' }));
    await runRazorpaySandboxExercise({ keyId: 'rzp_test_key', keySecret: 'secret', simulationMode: 'true', fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1].body)).mode).toBe('IMPS');
  });

  it('refuses Live Mode credentials or disabled simulation before calling Razorpay', async () => {
    const fetchImpl = jest.fn();
    await expect(runRazorpaySandboxExercise({
      keyId: 'rzp_live_key', keySecret: 'secret', simulationMode: 'true', fetchImpl,
    })).rejects.toThrow('A Razorpay Test Mode key pair is required.');
    await expect(runRazorpaySandboxExercise({
      keyId: 'rzp_test_key', keySecret: 'secret', simulationMode: 'false', fetchImpl,
    })).rejects.toThrow('RecoveryOS SIMULATION_MODE=true is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses before payout creation when balance or a compatible fund account is unavailable', async () => {
    const noBalanceFetch = jest.fn().mockResolvedValueOnce(jsonResponse({ items: [{ account_number: 'test', available_amount: 99 }] }));
    await expect(runRazorpaySandboxExercise({
      keyId: 'rzp_test_key', keySecret: 'secret', simulationMode: 'true', fetchImpl: noBalanceFetch,
    })).rejects.toThrow('required ₹1 dummy balance');
    expect(noBalanceFetch).toHaveBeenCalledTimes(1);

    const noFundFetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ account_number: 'test', available_amount: 100 }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'fa_wallet', active: true, account_type: 'wallet' }] }));
    await expect(runRazorpaySandboxExercise({
      keyId: 'rzp_test_key', keySecret: 'secret', simulationMode: 'true', fetchImpl: noFundFetch,
    })).rejects.toThrow('No active VPA or bank');
    expect(noFundFetch).toHaveBeenCalledTimes(2);
  });

  it('does not expose provider response bodies in errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(jsonResponse({ secret: 'provider-body-secret' }, 403));
    const error: unknown = await runRazorpaySandboxExercise({
      keyId: 'rzp_test_key', keySecret: 'secret', simulationMode: 'true', fetchImpl,
    }).then<unknown>(() => undefined, value => value);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    expect(message).toBe('Razorpay sandbox request failed with status 403.');
    expect(message).not.toContain('provider-body-secret');
  });
});
