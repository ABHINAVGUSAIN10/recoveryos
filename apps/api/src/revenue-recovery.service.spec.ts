import { RevenueIncidentStatus } from '@prisma/client';
import { RevenueRecoveryService } from './revenue-recovery.service';

describe('RevenueRecoveryService', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.SIMULATION_MODE = 'true';
    process.env.ENABLE_REVENUE_DEMO = 'true';
  });
  afterAll(() => { process.env = savedEnv; });

  it('reports readiness only when simulation, hosted AI, database, and queue safeguards are present', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const queue = { getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }) };
    const service = new RevenueRecoveryService(prisma as never, { status: jest.fn().mockReturnValue({ configured: true }) } as never, queue as never);
    await expect(service.configuration()).resolves.toMatchObject({ enabled: true, simulationSafe: true, aiConfigured: true, ready: true, services: { database: true, redis: true }, policy: { version: 'revenue-v1.0.0' } });
    process.env.SIMULATION_MODE = 'false';
    await expect(service.configuration()).resolves.toMatchObject({ ready: false, simulationSafe: false });
  });

  it('does not accept an approval for an incident that policy did not gate', async () => {
    const prisma = { revenueIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'rev-1', status: RevenueIncidentStatus.ESCALATED, analyses: [] }) } };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);
    await expect(service.approve('rev-1', 'token:operator')).rejects.toThrow('approval-required');
  });

  it('allows an operator to close an escalated case without executing a financial action', async () => {
    const db = {
      revenueIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      revenueAuditEvent: { create: jest.fn() },
    };
    const prisma = {
      revenueIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'rev-escalated', status: RevenueIncidentStatus.ESCALATED }) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);
    jest.spyOn(service, 'detail').mockResolvedValue({ id: 'rev-escalated', status: RevenueIncidentStatus.STOPPED } as never);

    await expect(service.reject('rev-escalated', 'token:operator')).resolves.toMatchObject({ status: RevenueIncidentStatus.STOPPED });
    expect(db.revenueIncident.updateMany).toHaveBeenCalledWith({ where: { id: 'rev-escalated', status: RevenueIncidentStatus.ESCALATED }, data: { status: RevenueIncidentStatus.STOPPED } });
    expect(db.revenueAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'REVENUE_ESCALATION_CLOSED' }) }));
  });

  it('durably schedules the approved first playbook action', async () => {
    const proposal = { category: 'TRANSIENT_PROVIDER', confidence: .9, diagnosis: 'Temporary gateway issue', evidence: [{ eventId: 'evt-1', fact: 'Gateway timeout' }], recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 30, playbook: [{ order: 1, action: 'SMART_RETRY', delayMinutes: 30, requiresHuman: false, rationale: 'Retry once' }], riskFlags: ['HIGH_VALUE'] };
    const transactionClient = {
      revenueIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      revenueAction: { upsert: jest.fn().mockResolvedValue({ id: 'action-1', scheduledFor: new Date(Date.now() + 30 * 60_000) }) },
      revenueAuditEvent: { create: jest.fn() },
    };
    const prisma = {
      revenueIncident: {
        findUniqueOrThrow: jest.fn()
          .mockResolvedValueOnce({ id: 'rev-1', status: RevenueIncidentStatus.APPROVAL_REQUIRED, amountPaise: 2_000_000, attemptCount: 0, analyses: [{ outputJson: proposal }] }),
      },
      $transaction: jest.fn(async (callback: (db: typeof transactionClient) => Promise<unknown>) => callback(transactionClient)),
    };
    const queue = { add: jest.fn().mockResolvedValue({ id: 'action-1' }) };
    const service = new RevenueRecoveryService(prisma as never, {} as never, queue as never);
    jest.spyOn(service, 'detail').mockResolvedValue({ id: 'rev-1', status: RevenueIncidentStatus.AUTO_ACTION } as never);
    await service.approve('rev-1', 'token:operator');
    expect(transactionClient.revenueAction.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ actionType: 'SMART_RETRY' }) }));
    expect(queue.add).toHaveBeenCalledWith('execute-revenue-action', { actionId: 'action-1' }, expect.objectContaining({ jobId: 'action-1' }));
    expect(transactionClient.revenueAction.upsert.mock.calls[0][0].create.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
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

  it('does not regress recovered revenue when a later failure webhook arrives', async () => {
    const recovered = { id: 'rev-recovered', sourcePaymentId: 'pay-1', status: RevenueIncidentStatus.RECOVERED };
    const db = {
      revenueIncident: { findUnique: jest.fn().mockResolvedValue(recovered), upsert: jest.fn().mockResolvedValue(recovered) },
      revenueEvent: { create: jest.fn(), upsert: jest.fn() },
      revenueAuditEvent: { create: jest.fn() },
    };
    const prisma = {
      revenueEvent: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);

    await expect(service.ingestPaymentWebhook('evt-late-failure', 'payment.failed', { payload: { payment: { entity: { id: 'pay-1', amount: 1000, currency: 'INR', error_description: 'late failure' } } } }))
      .resolves.toEqual({ duplicate: false, incidentId: recovered.id });
    expect(db.revenueIncident.upsert.mock.calls[0][0].update).not.toHaveProperty('status');
    expect(db.revenueAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'REVENUE_FAILURE_RECORDED_NO_STATE_CHANGE' }) }));
  });

  it('records an organic capture but does not claim recovered revenue without a pending action', async () => {
    const incident = { id: 'rev-1', sourcePaymentId: 'pay-failed', status: RevenueIncidentStatus.STOPPED, amountPaise: 50_000, currency: 'INR', recoveredAt: null };
    const db = {
      revenueIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue(incident), update: jest.fn() },
      revenueAction: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), updateMany: jest.fn() },
      revenueEvent: { create: jest.fn() },
      revenueAuditEvent: { create: jest.fn() },
    };
    const prisma = {
      revenueIncident: { findFirst: jest.fn().mockResolvedValue(incident), findUnique: jest.fn() },
      revenueEvent: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);

    await expect(service.ingestPaymentWebhook('evt-organic-capture', 'payment.captured', { payload: { payment: { entity: { id: 'pay-captured', amount: 50_000, currency: 'INR', notes: { recoveryos_incident_id: 'rev-1' } } } } }))
      .resolves.toMatchObject({ recovered: true, attributed: false });
    expect(db.revenueIncident.update.mock.calls[0][0].data).not.toHaveProperty('attemptCount');
    expect(db.revenueAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'REVENUE_CAPTURE_UNATTRIBUTED', dataJson: expect.objectContaining({ amountPaise: 0 }) }) }));
  });

  it('preserves but does not credit a capture with mismatched amount or currency', async () => {
    const incident = { id: 'rev-1', sourcePaymentId: 'pay-failed', status: RevenueIncidentStatus.AUTO_ACTION, amountPaise: 50_000, currency: 'INR', recoveredAt: null };
    const db = {
      revenueIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue(incident), update: jest.fn() },
      revenueAction: { findFirst: jest.fn().mockResolvedValue({ id: 'action-1', incidentId: 'rev-1', outcome: 'PENDING' }), findUnique: jest.fn(), updateMany: jest.fn() },
      revenueEvent: { create: jest.fn() },
      revenueAuditEvent: { create: jest.fn() },
    };
    const prisma = {
      revenueIncident: { findFirst: jest.fn().mockResolvedValue(incident), findUnique: jest.fn() },
      revenueEvent: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const service = new RevenueRecoveryService(prisma as never, {} as never, {} as never);

    await expect(service.ingestPaymentWebhook('evt-mismatch', 'payment.captured', { payload: { payment: { entity: { id: 'pay-captured', amount: 49_999, currency: 'INR', notes: { recoveryos_incident_id: 'rev-1' } } } } }))
      .resolves.toMatchObject({ recovered: false, attributed: false });
    expect(db.revenueAction.updateMany).not.toHaveBeenCalled();
    expect(db.revenueIncident.update).not.toHaveBeenCalled();
    expect(db.revenueAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'REVENUE_CAPTURE_MISMATCH' }) }));
  });

  it('returns experiments as immutable evidence snapshots', async () => {
    const row = { id: 'exp-1', baselineJson: { noAction: { recoveredValuePaise: 0 } }, metricsJson: { recoveredValuePaise: 1000 }, results: [] };
    const service = new RevenueRecoveryService({ revenueExperiment: { findMany: jest.fn().mockResolvedValue([row]) } } as never, {} as never, {} as never);
    await expect(service.listExperiments()).resolves.toEqual([expect.objectContaining({ id: 'exp-1', immutable: true, baseline: row.baselineJson, metrics: row.metricsJson })]);
  });
});
