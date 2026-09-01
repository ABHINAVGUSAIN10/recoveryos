import { RevenueIncidentStatus } from '@prisma/client';
import { RevenueRecoveryService } from './revenue-recovery.service';

describe('RevenueRecoveryService', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIMULATION_MODE = 'true';
    process.env.ENABLE_REVENUE_DEMO = 'true';
  });
  afterAll(() => { process.env = savedEnv; });

  it('reports readiness only when simulation and hosted AI safeguards are present', () => {
    const service = new RevenueRecoveryService({} as never, { status: jest.fn().mockReturnValue({ configured: true }) } as never, {} as never);
    expect(service.configuration()).toMatchObject({ enabled: true, simulationSafe: true, aiConfigured: true, ready: true, policy: { version: 'revenue-v1.0.0' } });
    process.env.SIMULATION_MODE = 'false';
    expect(service.configuration()).toMatchObject({ ready: false, simulationSafe: false });
  });

  it('does not accept an approval for an incident that policy did not gate', async () => {
    const prisma = { revenueIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'rev-1', status: RevenueIncidentStatus.ESCALATED, analyses: [] }) } };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);
    await expect(service.approve('rev-1', 'token:operator')).rejects.toThrow('approval-required');
  });

  it('durably schedules the approved first playbook action', async () => {
    const proposal = { category: 'TRANSIENT_PROVIDER', confidence: .9, diagnosis: 'Temporary gateway issue', evidence: [{ eventId: 'evt-1', fact: 'Gateway timeout' }], recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 30, playbook: [{ order: 1, action: 'SMART_RETRY', delayMinutes: 30, requiresHuman: false, rationale: 'Retry once' }], riskFlags: ['HIGH_VALUE'] };
    const prisma = {
      revenueIncident: {
        findUniqueOrThrow: jest.fn()
          .mockResolvedValueOnce({ id: 'rev-1', status: RevenueIncidentStatus.APPROVAL_REQUIRED, amountPaise: 2_000_000, attemptCount: 0, analyses: [{ outputJson: proposal }] })
          .mockResolvedValueOnce({ id: 'rev-1', amountPaise: 2_000_000, attemptCount: 0 }),
        update: jest.fn(),
      },
      revenueAuditEvent: { create: jest.fn() },
      revenueAction: { upsert: jest.fn().mockResolvedValue({ id: 'action-1', scheduledFor: new Date() }) },
    };
    const queue = { add: jest.fn().mockResolvedValue({ id: 'action-1' }) };
    const service = new RevenueRecoveryService(prisma as never, {} as never, queue as never);
    jest.spyOn(service, 'detail').mockResolvedValue({ id: 'rev-1', status: RevenueIncidentStatus.AUTO_ACTION } as never);
    await service.approve('rev-1', 'token:operator');
    expect(prisma.revenueAction.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ actionType: 'SMART_RETRY' }) }));
    expect(queue.add).toHaveBeenCalledWith('execute-revenue-action', { actionId: 'action-1' }, expect.objectContaining({ jobId: 'action-1' }));
  });

  it('refuses to execute an inbound collection action outside simulation mode', async () => {
    process.env.SIMULATION_MODE = 'false';
    const service = new RevenueRecoveryService({} as never, {} as never, {} as never);
    await expect(service.executeAction('action-1')).rejects.toThrow('not implemented');
  });

  it('ignores non-terminal payment events without inventing an incident', async () => {
    const service = new RevenueRecoveryService({} as never, {} as never, {} as never);
    await expect(service.ingestPaymentWebhook('evt-1', 'payment.authorized', { payload: { payment: { entity: { id: 'pay-1' } } } })).resolves.toMatchObject({ accepted: true, ignored: true });
  });

  it('returns experiments as immutable evidence snapshots', async () => {
    const row = { id: 'exp-1', baselineJson: { noAction: { recoveredValuePaise: 0 } }, metricsJson: { recoveredValuePaise: 1000 }, results: [] };
    const service = new RevenueRecoveryService({ revenueExperiment: { findMany: jest.fn().mockResolvedValue([row]) } } as never, {} as never, {} as never);
    await expect(service.listExperiments()).resolves.toEqual([expect.objectContaining({ id: 'exp-1', immutable: true, baseline: row.baselineJson, metrics: row.metricsJson })]);
  });
});
