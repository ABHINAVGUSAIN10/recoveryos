import { createHmac } from 'crypto';
import { runWebhookAcceptance, signWebhookBody } from './webhook-acceptance';

describe('webhook acceptance runner', () => {
  it('signs the exact request body with HMAC-SHA256', () => {
    const body = '{"event":"payout.processed"}';
    expect(signWebhookBody(body, 'fixture-secret')).toBe(createHmac('sha256', 'fixture-secret').update(body).digest('hex'));
  });

  it('verifies deduplication and traceable batch exports', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { duplicate: false, incidentId: 'incident-1' },
      { duplicate: true, incidentId: 'incident-1' },
      { status: 'RECOVERED', events: [{}], auditEvents: [{ eventType: 'WEBHOOK_RECEIVED' }] },
      { id: 'batch-1' },
      { cohortSize: 1, results: [{ incidentId: 'incident-1' }] },
    ];
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/export.csv')) return new Response('incident_id,status\nincident-1,RECOVERED', { status: 200 });
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await runWebhookAcceptance({
      baseUrl: 'https://recovery.example/api/v1',
      webhookSecret: 'fixture-secret',
      authMode: 'token',
      viewerToken: 'viewer-token',
      operatorToken: 'operator-token',
      simulationMode: 'true',
      fetchImpl,
    });

    expect(result).toMatchObject({
      incidentId: 'incident-1', secondDeliveryDuplicate: true, persistedEventCount: 1,
      webhookAuditCount: 1, batchId: 'batch-1', jsonIncidentTraceable: true,
      csvLineCount: 2, csvIncidentTraceable: true,
    });
    const postedBody = String(calls[0].init?.body);
    expect((calls[0].init?.headers as Record<string, string>)['X-Razorpay-Signature']).toBe(signWebhookBody(postedBody, 'fixture-secret'));
    expect(calls[2].init?.headers).toEqual({ Authorization: 'Bearer viewer-token' });
    expect(calls[3].init?.headers).toEqual({ Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' });
  });

  it('refuses to run fixtures outside simulation mode', async () => {
    await expect(runWebhookAcceptance({ simulationMode: 'false' })).rejects.toThrow('only in simulation mode');
  });
});
