import { AiService } from './ai.service';

describe('AiService', () => {
  const savedEnv = { ...process.env };

  const incident = {
    razorpayPayoutId: 'pout_technical',
    status: 'FAILED' as const,
    amountPaise: 1_000,
    currency: 'INR',
    reason: 'Temporary beneficiary bank technical failure',
    attempts: 0,
    duplicateSuspected: false,
    policyVersion: 'v1.0.0',
  };
  const revenueContext = {
    incidentId: 'rev-1', sourcePaymentId: 'pay-1', amountPaise: 75_000, currency: 'INR', paymentMethod: 'card',
    failureCode: 'GATEWAY_TIMEOUT', failureDescription: 'Acquirer gateway temporarily unavailable', attemptCount: 0, consentToContact: true,
    timeline: [
      { eventId: 'evt-checkout', eventType: 'checkout.started', occurredAt: '2026-09-01T00:00:00.000Z', summary: 'Customer completed checkout.' },
      { eventId: 'evt-failed', eventType: 'payment.failed', occurredAt: '2026-09-01T00:01:00.000Z', summary: 'Gateway timeout.' },
    ],
  };

  beforeEach(() => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_MODEL;
    delete process.env.AI_TIMEOUT_MS;
    delete process.env.AI_THINKING_MODE;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('uses the deterministic simulator when no model key is configured', async () => {
    const result = await new AiService().classify(incident);

    expect(result).toMatchObject({
      modelRef: 'deterministic-simulator',
      proposal: { category: 'TRANSIENT_TECHNICAL', recommendedAction: 'RETRY' },
    });
  });

  it('recognizes reversal nouns in deterministic fallback evidence', async () => {
    const result = await new AiService().classify({
      ...incident, status: 'REVERSED', reason: 'Bank reversal confirmed',
    });

    expect(result.proposal).toMatchObject({ category: 'REVERSED', recommendedAction: 'ESCALATE' });
  });

  it('accepts a schema-valid DeepSeek JSON response', async () => {
    process.env.AI_API_KEY = 'test-key';
    const service = new AiService();
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        category: 'TRANSIENT_TECHNICAL', confidence: 0.91, evidenceSummary: 'Temporary provider issue.',
        recommendedAction: 'RETRY', proposedDelayMinutes: 30,
      }) } }],
    });
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);

    const result = await service.classify(incident);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      modelRef: 'deepseek:deepseek-v4-flash:thinking-disabled', promptVersion: 'classifier-v7',
      proposal: { category: 'TRANSIENT_TECHNICAL', recommendedAction: 'RETRY' },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ thinking: { type: 'disabled' }, temperature: 0 }));
  });

  it('uses low reasoning and strict JSON Schema for Groq GPT-OSS 120B', async () => {
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'groq';
    const service = new AiService();
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        category: 'TRANSIENT_TECHNICAL', confidence: 0.94, evidenceSummary: 'Temporary provider issue.',
        recommendedAction: 'RETRY', proposedDelayMinutes: 30,
      }) } }],
    });
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);

    const result = await service.classify(incident);

    expect(result).toMatchObject({
      modelRef: 'groq:openai/gpt-oss-120b', promptVersion: 'classifier-v7',
      proposal: { category: 'TRANSIENT_TECHNICAL', recommendedAction: 'RETRY' },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openai/gpt-oss-120b', temperature: 0, reasoning_effort: 'low',
      response_format: expect.objectContaining({
        type: 'json_schema', json_schema: expect.objectContaining({ strict: true }),
      }),
    }));
  });

  it('fails closed after a malformed response and one bounded retry', async () => {
    process.env.AI_API_KEY = 'test-key';
    const service = new AiService();
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"category":"invented"}' } }] });
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);

    const result = await service.classify(incident);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.proposal).toMatchObject({ category: 'UNKNOWN', confidence: 0, recommendedAction: 'STOP' });
    expect(result.modelRef).toBe('deepseek:deepseek-v4-flash:thinking-disabled:unavailable');
  });

  it('fails closed after a provider timeout and one bounded retry', async () => {
    process.env.AI_API_KEY = 'test-key';
    const service = new AiService();
    const create = jest.fn().mockRejectedValue(new Error('provider timeout token=private'));
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);

    const result = await service.classify(incident);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.proposal).toMatchObject({ category: 'UNKNOWN', recommendedAction: 'STOP' });
  });

  it('fails closed for unsupported provider configuration without calling a model', async () => {
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'unsupported';
    const service = new AiService();
    const createClient = jest.spyOn(service as never, 'createClient');

    const result = await service.classify(incident);

    expect(createClient).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      modelRef: 'configuration-error', proposal: { category: 'UNKNOWN', recommendedAction: 'STOP' },
    });
  });

  it('uses the complete persisted timeline in the deterministic revenue playbook', async () => {
    const result = await new AiService().analyzeRevenue(revenueContext);
    expect(result).toMatchObject({
      modelRef: 'deterministic-revenue-simulator', promptVersion: 'revenue-heuristic-v1',
      proposal: { category: 'TRANSIENT_PROVIDER', recommendedAction: 'SMART_RETRY' },
    });
    expect(result.proposal.evidence[0].eventId).toBe('evt-failed');
    expect(result.proposal.playbook.length).toBeGreaterThan(1);
  });

  it('requests a strict timeline-grounded revenue schema from Groq', async () => {
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_PROVIDER = 'groq';
    const service = new AiService();
    const proposal = {
      category: 'TRANSIENT_PROVIDER', confidence: .93, diagnosis: 'The gateway timeout is transient.',
      evidence: [{ eventId: 'evt-failed', fact: 'Gateway timeout.' }], recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 30,
      playbook: [{ order: 1, action: 'SMART_RETRY', delayMinutes: 30, requiresHuman: false, rationale: 'Retry once.' }], riskFlags: [],
    };
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(proposal) } }] });
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);
    const result = await service.analyzeRevenue(revenueContext);
    expect(result).toMatchObject({ modelRef: 'groq:openai/gpt-oss-120b', promptVersion: 'revenue-playbook-v1', proposal });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ response_format: expect.objectContaining({ type: 'json_schema', json_schema: expect.objectContaining({ strict: true, name: 'revenue_recovery_playbook' }) }) }));
  });

  it('fails the revenue workflow closed when the model invents an unsupported playbook', async () => {
    process.env.AI_API_KEY = 'test-key';
    const service = new AiService();
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"category":"invented"}' } }] });
    jest.spyOn(service as never, 'createClient').mockReturnValue({ chat: { completions: { create } } } as never);
    const result = await service.analyzeRevenue(revenueContext);
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.proposal).toMatchObject({ category: 'UNKNOWN', recommendedAction: 'STOP', confidence: 0 });
    expect(result.proposal.evidence[0].eventId).toBe('evt-failed');
  });
});
