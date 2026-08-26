import { ExecutionOutcome, IncidentStatus } from '@prisma/client';
import { RecoveryService } from './recovery.service';
import { recoveryReferenceId } from './razorpay.service';

describe('RecoveryService reconciliation', () => {
  it('records a confirmed payout and closes unknown executions without retrying', async () => {
    const transactionClient = {
      payoutIncident: { update: jest.fn() },
      actionExecution: { updateMany: jest.fn() },
      auditEvent: { create: jest.fn() },
    };
    const prisma = {
      payoutIncident: { findMany: jest.fn().mockResolvedValue([{ id: 'incident-1', razorpayPayoutId: 'pout_1' }]) },
      auditEvent: { create: jest.fn() },
      $transaction: jest.fn(async (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient)),
    };
    const razorpay = { fetchPayout: jest.fn().mockResolvedValue({ id: 'pout_1', status: 'processed' }) };
    const service = new RecoveryService(prisma as never, {} as never, razorpay as never, {} as never);

    await expect(service.reconcileOpen()).resolves.toEqual({ scanned: 1, reconciled: 1, pending: 0, failures: 0 });
    expect(transactionClient.payoutIncident.update).toHaveBeenCalledWith({ where: { id: 'incident-1' }, data: { status: IncidentStatus.RECOVERED } });
    expect(transactionClient.actionExecution.updateMany).toHaveBeenCalledWith({
      where: { incidentId: 'incident-1', outcome: ExecutionOutcome.UNKNOWN },
      data: { outcome: ExecutionOutcome.SUCCEEDED, responseJson: { id: 'pout_1', status: 'processed' } },
    });
  });

  it('leaves processing payouts blocked and auditable', async () => {
    const prisma = {
      payoutIncident: { findMany: jest.fn().mockResolvedValue([{ id: 'incident-2', razorpayPayoutId: 'pout_2' }]) },
      auditEvent: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    const razorpay = { fetchPayout: jest.fn().mockResolvedValue({ id: 'pout_2', status: 'processing' }) };
    const service = new RecoveryService(prisma as never, {} as never, razorpay as never, {} as never);

    await expect(service.reconcileOpen()).resolves.toEqual({ scanned: 1, reconciled: 0, pending: 1, failures: 0 });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'RECONCILIATION_PENDING' }) }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reconciles the recovery payout id stored on an unknown execution', async () => {
    const execution = { id: 'execution-1', idempotencyKey: 'rr_key', responseJson: { id: 'pout_retry', status: 'processing' } };
    const incident = { id: 'incident-1', razorpayPayoutId: 'pout_original', status: IncidentStatus.EXECUTION_UNKNOWN, executions: [execution] };
    const transactionClient = { payoutIncident: { update: jest.fn() }, actionExecution: { update: jest.fn(), updateMany: jest.fn() }, auditEvent: { create: jest.fn() } };
    const prisma = {
      payoutIncident: { findMany: jest.fn().mockResolvedValue([incident]) }, auditEvent: { create: jest.fn() }, actionExecution: { update: jest.fn() },
      $transaction: jest.fn(async (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient)),
    };
    const razorpay = { fetchPayout: jest.fn().mockResolvedValue({ id: 'pout_retry', status: 'processed' }), executeRecovery: jest.fn() };
    const service = new RecoveryService(prisma as never, {} as never, razorpay as never, {} as never);

    await expect(service.reconcileOpen()).resolves.toEqual({ scanned: 1, reconciled: 1, pending: 0, failures: 0 });
    expect(razorpay.fetchPayout).toHaveBeenCalledWith('pout_retry');
    expect(razorpay.executeRecovery).not.toHaveBeenCalled();
    expect(transactionClient.actionExecution.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'execution-1' }, data: expect.objectContaining({ outcome: ExecutionOutcome.SUCCEEDED }),
    }));
  });

  it('reuses the same action key after an ambiguous create response', async () => {
    const execution = { id: 'execution-2', idempotencyKey: 'rr_same_key', responseJson: { error: 'timeout' } };
    const incident = { id: 'incident-2', razorpayPayoutId: 'pout_original', status: IncidentStatus.EXECUTION_UNKNOWN, executions: [execution] };
    const prisma = {
      payoutIncident: { findMany: jest.fn().mockResolvedValue([incident]) },
      actionExecution: { update: jest.fn() }, auditEvent: { create: jest.fn() }, $transaction: jest.fn(),
    };
    const razorpay = { executeRecovery: jest.fn().mockResolvedValue({ id: 'pout_retry', status: 'processing' }), fetchPayout: jest.fn() };
    const service = new RecoveryService(prisma as never, {} as never, razorpay as never, {} as never);

    await expect(service.reconcileOpen()).resolves.toEqual({ scanned: 1, reconciled: 0, pending: 1, failures: 0 });
    expect(razorpay.executeRecovery).toHaveBeenCalledWith('rr_same_key', 'pout_original', 'incident-2');
    expect(razorpay.fetchPayout).not.toHaveBeenCalled();
    expect(prisma.actionExecution.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'execution-2' } }));
  });
});

describe('RecoveryService durable ingestion and execution recovery', () => {
  it('treats a concurrent webhook unique-key race as a duplicate', async () => {
    const duplicate = { payoutIncidentId: 'incident-1' };
    const prisma = {
      payoutEvent: { findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(duplicate) },
      $transaction: jest.fn().mockRejectedValue({ code: 'P2002' }),
    };
    const ai = { classify: jest.fn() };
    const service = new RecoveryService(prisma as never, ai as never, {} as never, {} as never);

    await expect(service.ingestWebhook('event-1', 'payout.failed', { payload: { payout: { entity: { id: 'pout-1', amount: 1000, status: 'failed' } } } }))
      .resolves.toEqual({ duplicate: true, incidentId: 'incident-1' });
    expect(ai.classify).not.toHaveBeenCalled();
  });

  it('links a recovery payout webhook back to the original incident and action', async () => {
    const incidentId = '123e4567-e89b-12d3-a456-426614174000';
    const entity = { id: 'pout_retry', status: 'processed', amount: 1000, currency: 'INR', reference_id: recoveryReferenceId(incidentId) };
    const incident = { id: incidentId, status: IncidentStatus.RECOVERED };
    const db = {
      actionExecution: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'execution-newer', incidentId, outcome: ExecutionOutcome.UNKNOWN, responseJson: { id: 'pout_other' } },
          { id: 'execution-1', incidentId, outcome: ExecutionOutcome.UNKNOWN, responseJson: { id: 'pout_retry' } },
        ]),
        update: jest.fn(),
      },
      payoutIncident: { update: jest.fn().mockResolvedValue(incident), upsert: jest.fn() },
      payoutEvent: { create: jest.fn().mockResolvedValue({ id: 'event-row-1' }) },
      auditEvent: { create: jest.fn() },
    };
    const prisma = {
      payoutEvent: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const ai = { classify: jest.fn() };
    const service = new RecoveryService(prisma as never, ai as never, {} as never, {} as never);

    await expect(service.ingestWebhook('event-retry-1', 'payout.processed', { payload: { payout: { entity } } }))
      .resolves.toEqual({ duplicate: false, incidentId });
    expect(db.payoutIncident.update).toHaveBeenCalledWith({ where: { id: incidentId }, data: expect.objectContaining({ status: IncidentStatus.RECOVERED }) });
    expect(db.payoutIncident.upsert).not.toHaveBeenCalled();
    expect(db.actionExecution.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'execution-1' }, data: expect.objectContaining({ outcome: ExecutionOutcome.SUCCEEDED }) }));
    expect(db.payoutEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ payoutIncidentId: incidentId }) });
    expect(ai.classify).not.toHaveBeenCalled();
  });

  it('requeues durable intents and marks interrupted executions unknown on startup', async () => {
    const scheduledFor = new Date(Date.now() - 1_000);
    const pending = [
      { id: 'execution-1', incidentId: 'incident-1', scheduledFor, incident: { status: IncidentStatus.AUTO_RETRY } },
      { id: 'execution-2', incidentId: 'incident-2', scheduledFor, incident: { status: IncidentStatus.EXECUTING } },
      { id: 'execution-3', incidentId: 'incident-3', scheduledFor, incident: { status: IncidentStatus.STOPPED } },
    ];
    const prisma = {
      actionExecution: { findMany: jest.fn().mockResolvedValue(pending) },
      auditEvent: { create: jest.fn() },
    };
    const queue = { getJob: jest.fn().mockResolvedValue(null), add: jest.fn().mockResolvedValue({}) };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, queue as never);
    jest.spyOn(service, 'recordExecutionResult').mockResolvedValue({ recorded: true, incidentId: 'incident-2' } as never);

    await expect(service.recoverPendingExecutions()).resolves.toEqual({ scanned: 3, requeued: 1, uncertain: 1, ignored: 1 });
    expect(queue.add).toHaveBeenCalledWith('execute-retry', { executionId: 'execution-1' }, expect.objectContaining({ jobId: 'execution-1' }));
    expect(service.recordExecutionResult).toHaveBeenCalledWith('execution-2', ExecutionOutcome.UNKNOWN, expect.objectContaining({ error: expect.stringContaining('reconciliation') }));
  });

  it('records an execution result only once when duplicate workers finish', async () => {
    const db = {
      actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue({ incidentId: 'incident-1' }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      payoutIncident: { update: jest.fn() }, auditEvent: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)) };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.recordExecutionResult('execution-1', ExecutionOutcome.SUCCEEDED, { status: 'processed' })).resolves.toEqual({ recorded: false, incidentId: 'incident-1' });
    expect(db.payoutIncident.update).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
  });
});

describe('RecoveryService batch reporting', () => {
  const batch = {
    id: 'batch-1', name: 'Regression cohort', cohortSize: 2, totalValueAtRiskPaise: 30000,
    startedAt: new Date('2026-08-21T10:00:00.000Z'), completedAt: null,
    results: [
      { id: 'result-1', batchRunId: 'batch-1', incidentId: 'incident-1', finalState: 'AUTO_RETRY', recoveredValuePaise: 0, incident: { id: 'incident-1', razorpayPayoutId: 'pout_1', status: IncidentStatus.RECOVERED, amountPaise: 10000, currency: 'INR', currentReason: 'temporary bank issue', beneficiaryRef: null, attempts: 1, duplicateSuspected: false, createdAt: new Date(), updatedAt: new Date('2026-08-21T10:10:00.000Z'), analyses: [{ outputJson: { category: 'TRANSIENT_TECHNICAL', confidence: .9, evidenceSummary: 'Temporary issue', recommendedAction: 'RETRY', proposedDelayMinutes: 30 } }], policyDecisions: [{ finalDecision: 'AUTO_RETRY' }] } },
      { id: 'result-2', batchRunId: 'batch-1', incidentId: 'incident-2', finalState: 'PROCESSING', recoveredValuePaise: 0, incident: { id: 'incident-2', razorpayPayoutId: 'pout_2', status: IncidentStatus.PROCESSING, amountPaise: 20000, currency: 'INR', currentReason: 'pending, bank confirmation', beneficiaryRef: null, attempts: 0, duplicateSuspected: false, createdAt: new Date(), updatedAt: new Date('2026-08-21T10:11:00.000Z'), analyses: [], policyDecisions: [{ finalDecision: 'STOPPED' }] } },
    ],
  };
  const service = new RecoveryService({ batchRun: { findUniqueOrThrow: jest.fn().mockResolvedValue(batch) } } as never, {} as never, {} as never, {} as never);

  it('derives metrics from current incident outcomes rather than stale batch snapshots', async () => {
    const report = await service.batchResults('batch-1');
    expect(report.metrics).toMatchObject({
      recoveredValuePaise: 10000, recoveryRate: 1 / 3, eligibleCount: 1, eligibleValuePaise: 10000,
      recoveredEligibleValuePaise: 10000, eligibleRecoveryRate: 1, pendingRecoveryValuePaise: 0,
      protectedValuePaise: 20000, unsafeActionsPrevented: 1, unresolvedIncidents: 1,
    });
    expect(report.results[0]).toMatchObject({ finalState: IncidentStatus.RECOVERED, recoveredValuePaise: 10000 });
  });

  it('exports traceable CSV rows with escaped provider reasons', async () => {
    const csv = await service.batchExportCsv('batch-1');
    expect(csv).toContain('razorpay_payout_id');
    expect(csv).toContain('pout_1,10000,INR,RECOVERED,10000');
    expect(csv).toContain('"pending, bank confirmation"');
  });
});

describe('RecoveryService operational status', () => {
  it('reports database, Redis, queue, and AI mode without exposing credentials', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 3, completed: 4, failed: 0, paused: 0 }),
    };
    const ai = { status: jest.fn().mockReturnValue({ mode: 'deterministic-simulator', configured: false, provider: 'deterministic', model: 'heuristic-v1', promptVersion: 'heuristic-v1' }) };
    const service = new RecoveryService(prisma as never, ai as never, {} as never, queue as never);

    const result = await service.operations();

    expect(result).toMatchObject({
      status: 'ready', services: { database: true, redis: true },
      queue: { waiting: 2, active: 1, delayed: 3, completed: 4, failed: 0 },
      ai: { mode: 'deterministic-simulator', configured: false },
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('reports degraded readiness when database and queue checks fail', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('database unavailable')) };
    const queue = { getJobCounts: jest.fn().mockRejectedValue(new Error('redis unavailable')) };
    const ai = { status: jest.fn().mockReturnValue({ mode: 'deterministic-simulator', configured: false }) };
    const service = new RecoveryService(prisma as never, ai as never, {} as never, queue as never);

    await expect(service.operations()).resolves.toMatchObject({ status: 'degraded', services: { database: false, redis: false } });
  });
});

describe('RecoveryService incident pagination', () => {
  it('applies bounded pagination, search, status, and open-review filters', async () => {
    const prisma = { payoutIncident: { count: jest.fn().mockResolvedValue(21), findMany: jest.fn().mockResolvedValue([{ id: 'incident-1' }]) } };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    const result = await service.listIncidents({ page: 2, pageSize: 10, search: 'pout_01', status: 'ESCALATE', reviewRequired: true });

    expect(result).toMatchObject({ total: 21, page: 2, pageSize: 10, totalPages: 3, items: [{ id: 'incident-1' }] });
    expect(prisma.payoutIncident.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 10, take: 10,
      where: expect.objectContaining({ status: IncidentStatus.ESCALATE, reviewTasks: { some: { status: 'OPEN' } } }),
    }));
  });
});
