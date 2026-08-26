import { runRazorpayReadiness } from './razorpay-readiness';

describe('Razorpay read-only readiness probe', () => {
  it('reports successful authentication without reading the response body', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { cancel },
    });

    const result = await runRazorpayReadiness({
      keyId: 'rzp_test_key',
      keySecret: 'test_secret',
      fetchImpl,
    });

    expect(result).toEqual({
      probe: 'razorpay-banking-balances',
      readOnly: true,
      reachable: true,
      authenticated: true,
      authorizationRejected: false,
      status: 200,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.razorpay.com/v1/banking_balances',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reports rejected authorization without exposing a provider response body', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const result = await runRazorpayReadiness({
      keyId: 'rzp_test_key',
      keySecret: 'wrong_secret',
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 401, body: { cancel } }),
    });

    expect(result.authenticated).toBe(false);
    expect(result.authorizationRejected).toBe(true);
    expect(result.status).toBe(401);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('fails before making a request when credentials are missing', async () => {
    const fetchImpl = jest.fn();
    await expect(runRazorpayReadiness({ keyId: '', keySecret: '', fetchImpl })).rejects.toThrow(
      'Razorpay credentials are not configured.',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
