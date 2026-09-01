import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { AppController } from './app.controller';

describe('AppController Razorpay webhook', () => {
  const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const recovery = { ingestWebhook: jest.fn() };
  const revenue = { ingestPaymentWebhook: jest.fn().mockResolvedValue({ accepted: true }) };
  const controller = new AppController(recovery as never, revenue as never);
  const payload = { event_id: 'event-1', event: 'payout.failed', payload: { payout: { entity: { id: 'pout-1' } } } };
  const rawBody = Buffer.from(JSON.stringify(payload));

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
    recovery.ingestWebhook.mockReset().mockResolvedValue({ accepted: true });
    revenue.ingestPaymentWebhook.mockReset().mockResolvedValue({ accepted: true, domain: 'revenue' });
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;
  });

  it('rejects a missing or invalid signature with 401 semantics', async () => {
    await expect(controller.webhook({ rawBody } as never, undefined, payload)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.webhook({ rawBody } as never, 'invalid', payload)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(recovery.ingestWebhook).not.toHaveBeenCalled();
  });

  it('accepts the exact signed body and forwards its stable event id', async () => {
    const signature = createHmac('sha256', 'test-webhook-secret').update(rawBody).digest('hex');
    await expect(controller.webhook({ rawBody } as never, signature, payload)).resolves.toEqual({ accepted: true });
    expect(recovery.ingestWebhook).toHaveBeenCalledWith('event-1', 'payout.failed', payload);
  });

  it('routes signed inbound payment events to the revenue recovery domain', async () => {
    const paymentPayload = { event_id: 'event-payment-1', event: 'payment.failed', payload: { payment: { entity: { id: 'pay-1' } } } };
    const paymentBody = Buffer.from(JSON.stringify(paymentPayload));
    const signature = createHmac('sha256', 'test-webhook-secret').update(paymentBody).digest('hex');
    await expect(controller.webhook({ rawBody: paymentBody } as never, signature, paymentPayload)).resolves.toMatchObject({ accepted: true, domain: 'revenue' });
    expect(revenue.ingestPaymentWebhook).toHaveBeenCalledWith('event-payment-1', 'payment.failed', paymentPayload);
    expect(recovery.ingestWebhook).not.toHaveBeenCalled();
  });

  it('returns the authenticated actor for role-aware clients', () => {
    expect(controller.session({ recoveryActor: { id: 'token:operator', role: 'OPERATOR' } } as never)).toEqual({ id: 'token:operator', role: 'OPERATOR' });
  });
});
