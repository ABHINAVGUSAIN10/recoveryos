import { ExecutionOutcome, IncidentStatus, ReviewKind, ReviewStatus } from '@prisma/client';
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
    expect(razorpay.executeRecovery).toHaveBeenCalledWith('rr_same_key', 'pout_original', 'incident-2', undefined);
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
      payoutIncident: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: incidentId, status: IncidentStatus.EXECUTION_UNKNOWN }), update: jest.fn().mockResolvedValue(incident), create: jest.fn() },
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
    expect(db.payoutIncident.create).not.toHaveBeenCalled();
    expect(db.actionExecution.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'execution-1' }, data: expect.objectContaining({ outcome: ExecutionOutcome.SUCCEEDED }) }));
    expect(db.payoutEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ payoutIncidentId: incidentId }) });
    expect(ai.classify).not.toHaveBeenCalled();
  });

  it('records a late provider failure without regressing a recovered payout', async () => {
    const recovered = { id: 'incident-recovered', razorpayPayoutId: 'pout-1', status: IncidentStatus.RECOVERED };
    const db = {
      actionExecution: { findMany: jest.fn().mockResolvedValue([]) },
      payoutIncident: {
        findUnique: jest.fn().mockResolvedValue(recovered),
        update: jest.fn().mockResolvedValue(recovered),
        create: jest.fn(),
      },
      payoutEvent: { create: jest.fn().mockResolvedValue({ id: 'event-row-2' }) },
      auditEvent: { create: jest.fn() },
    };
    const prisma = {
      payoutEvent: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)),
    };
    const ai = { classify: jest.fn() };
    const service = new RecoveryService(prisma as never, ai as never, {} as never, {} as never);

    await expect(service.ingestWebhook('event-late-failure', 'payout.failed', { payload: { payout: { entity: { id: 'pout-1', amount: 1000, status: 'failed' } } } }))
      .resolves.toEqual({ duplicate: false, incidentId: recovered.id });
    expect(db.payoutIncident.update).toHaveBeenCalledWith({ where: { id: recovered.id }, data: { status: IncidentStatus.RECOVERED } });
    expect(db.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'WEBHOOK_STATE_IGNORED' }) }));
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
    expect(queue.add).toHaveBeenCalledWith('execute-retry', { executionId: 'execution-1' }, expect.objectContaining({
      jobId: 'execution-1',
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
    }));
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

  it('flags and excludes a recovery action that succeeds after the original payout already recovered', async () => {
    const db = {
      actionExecution: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'execution-race', incidentId: 'incident-race' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutIncident: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'incident-race', status: IncidentStatus.RECOVERED }),
        update: jest.fn(),
      },
      auditEvent: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback: (client: typeof db) => Promise<unknown>) => callback(db)) };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.recordExecutionResult('execution-race', ExecutionOutcome.SUCCEEDED, { id: 'pout_retry', status: 'processed' }))
      .resolves.toEqual({ recorded: true, incidentId: 'incident-race' });
    expect(db.payoutIncident.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'incident-race' },
      data: expect.objectContaining({ duplicateSuspected: true, status: IncidentStatus.RECOVERED }),
    }));
    expect(db.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'DUPLICATE_PAYOUT_CONFIRMED' }) }));
  });
});

describe('RecoveryService live demonstration', () => {
  const originalDemo = process.env.ENABLE_LIVE_DEMO;
  const originalSimulation = process.env.SIMULATION_MODE;
  const originalDelay = process.env.DEMO_RETRY_DELAY_SECONDS;

  afterEach(() => {
    if (originalDemo === undefined) delete process.env.ENABLE_LIVE_DEMO; else process.env.ENABLE_LIVE_DEMO = originalDemo;
    if (originalSimulation === undefined) delete process.env.SIMULATION_MODE; else process.env.SIMULATION_MODE = originalSimulation;
    if (originalDelay === undefined) delete process.env.DEMO_RETRY_DELAY_SECONDS; else process.env.DEMO_RETRY_DELAY_SECONDS = originalDelay;
    jest.restoreAllMocks();
  });

  it('refuses to create demo incidents unless the explicit simulation guard is enabled', async () => {
    process.env.ENABLE_LIVE_DEMO = 'false';
    process.env.SIMULATION_MODE = 'true';
    const service = new RecoveryService({} as never, { status: jest.fn().mockReturnValue({ configured: true }) } as never, {} as never, {} as never);

    await expect(service.runLiveDemo('TRANSIENT_LOW_VALUE')).rejects.toThrow('disabled');
  });

  it('creates a unique live-AI incident, verifies replay deduplication, and groups evidence', async () => {
    process.env.ENABLE_LIVE_DEMO = 'true';
    process.env.SIMULATION_MODE = 'true';
    process.env.DEMO_RETRY_DELAY_SECONDS = '5';
    const service = new RecoveryService({} as never, { status: jest.fn().mockReturnValue({ configured: true }) } as never, {} as never, {} as never);
    const ingest = jest.spyOn(service, 'ingestWebhook')
      .mockResolvedValueOnce({ duplicate: false, incidentId: 'incident-1' })
      .mockResolvedValueOnce({ duplicate: true, incidentId: 'incident-1' });
    jest.spyOn(service, 'createBatch').mockResolvedValue({ id: 'batch-1', name: 'Live AI Demo' } as never);
    jest.spyOn(service, 'incidentDetail').mockResolvedValue({ id: 'incident-1', status: IncidentStatus.AUTO_RETRY } as never);

    const result = await service.runLiveDemo('TRANSIENT_LOW_VALUE', 'token:operator');

    expect(result).toMatchObject({
      scenario: 'TRANSIENT_LOW_VALUE', retryDelaySeconds: 5,
      duplicateReplayVerified: { TRANSIENT_LOW_VALUE: true },
      batch: { id: 'batch-1' }, incidents: [{ id: 'incident-1' }],
    });
    expect(result.runId).toMatch(/^demo_/);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0][2]).toMatchObject({ payload: { payout: { entity: {
      amount: 500_000, status: 'failed', notes: { recoveryos_demo_scenario: 'TRANSIENT_LOW_VALUE' },
    } } } });
    expect(ingest.mock.calls[0][3]).toMatchObject({ actorId: 'token:operator', retryDelaySeconds: 5 });
  });

  it('creates a fixed ₹10,000 provider-test run only after explicit confirmation', async () => {
    const razorpay = { testDemoConfiguration: jest.fn().mockReturnValue({ enabled: true, ready: true, amountPaise: 1_000_000 }) };
    const prisma = { actionExecution: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new RecoveryService(prisma as never, { status: jest.fn().mockReturnValue({ configured: true }) } as never, razorpay as never, {} as never);
    jest.spyOn(service, 'getPolicy').mockResolvedValue({ version: 'v1', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 });
    const ingest = jest.spyOn(service, 'ingestWebhook')
      .mockResolvedValueOnce({ duplicate: false, incidentId: 'incident-rx' })
      .mockResolvedValueOnce({ duplicate: true, incidentId: 'incident-rx' });
    jest.spyOn(service, 'createBatch').mockResolvedValue({ id: 'batch-rx', name: 'RazorpayX Test Demo' } as never);
    jest.spyOn(service, 'incidentDetail').mockResolvedValue({ id: 'incident-rx', amountPaise: 1_000_000, status: IncidentStatus.AUTO_RETRY } as never);

    await expect(service.runRazorpayTestDemo('wrong', 'token:admin')).rejects.toThrow('confirmation');
    const result = await service.runRazorpayTestDemo('CREATE INR 10000 TEST PAYOUT', 'token:admin');

    expect(result).toMatchObject({ amountPaise: 1_000_000, duplicateReplayVerified: true, incident: { id: 'incident-rx' } });
    expect(ingest.mock.calls[0][2]).toMatchObject({ payload: { payout: { entity: { amount: 1_000_000, status: 'failed' } } } });
    expect(ingest.mock.calls[0][3]).toMatchObject({ actorId: 'token:admin', executionMode: 'RAZORPAYX_TEST' });
  });
});

describe('RecoveryService batch reporting', () => {
  const batch = {
    id: 'batch-1', name: 'Regression cohort', cohortSize: 2, totalValueAtRiskPaise: 30000,
    policyVersion: 'v1.0.0', modelRef: 'groq:test', promptVersion: 'classifier-v7', cohortFingerprint: 'frozen-fingerprint', baselineJson: { noAction: { recoveredValuePaise: 0 } },
    metricsJson: { valueAtRiskPaise: 30000, recoveredValuePaise: 0, recoveryRate: 0, eligibleCount: 1, eligibleValuePaise: 10000, recoveredEligibleValuePaise: 0, eligibleRecoveryRate: 0, pendingRecoveryValuePaise: 10000, manualReviewValuePaise: 0, protectedValuePaise: 20000, manualInterventions: 0, unsafeActionsPrevented: 1, unresolvedIncidents: 2, statusDistribution: { AUTO_RETRY: 1, PROCESSING: 1 } },
    startedAt: new Date('2026-08-21T10:00:00.000Z'), completedAt: new Date('2026-08-21T10:00:01.000Z'),
    results: [
      { id: 'result-1', batchRunId: 'batch-1', incidentId: 'incident-1', finalState: 'AUTO_RETRY', recoveredValuePaise: 0, eligibleForRecovery: true, humanInterventions: 0, unsafeActionsPrevented: 0, snapshotJson: { incident: { id: 'incident-1', razorpayPayoutId: 'pout_1', status: 'AUTO_RETRY', amountPaise: 10000, currency: 'INR', currentReason: 'temporary bank issue', beneficiaryRef: null, attempts: 0, duplicateSuspected: false, createdAt: '2026-08-21T10:00:00.000Z', updatedAt: '2026-08-21T10:00:00.000Z' } }, incident: { id: 'incident-1', razorpayPayoutId: 'pout_1', status: IncidentStatus.RECOVERED, amountPaise: 10000, currency: 'INR', currentReason: 'temporary bank issue', beneficiaryRef: null, attempts: 1, duplicateSuspected: false, createdAt: new Date(), updatedAt: new Date('2026-08-21T10:10:00.000Z'), auditEvents: [], executions: [{ outcome: ExecutionOutcome.SUCCEEDED, responseJson: { id: 'pout_retry' } }] } },
      { id: 'result-2', batchRunId: 'batch-1', incidentId: 'incident-2', finalState: 'PROCESSING', recoveredValuePaise: 0, eligibleForRecovery: false, humanInterventions: 0, unsafeActionsPrevented: 1, snapshotJson: { incident: { id: 'incident-2', razorpayPayoutId: 'pout_2', status: 'PROCESSING', amountPaise: 20000, currency: 'INR', currentReason: 'pending, bank confirmation', beneficiaryRef: null, attempts: 0, duplicateSuspected: false, createdAt: '2026-08-21T10:00:00.000Z', updatedAt: '2026-08-21T10:00:00.000Z' } }, incident: { id: 'incident-2', razorpayPayoutId: 'pout_2', status: IncidentStatus.PROCESSING, amountPaise: 20000, currency: 'INR', currentReason: 'pending, bank confirmation', beneficiaryRef: null, attempts: 0, duplicateSuspected: false, createdAt: new Date(), updatedAt: new Date('2026-08-21T10:11:00.000Z'), auditEvents: [], executions: [] } },
    ],
  };
  const service = new RecoveryService({ batchRun: { findUniqueOrThrow: jest.fn().mockResolvedValue(batch) } } as never, {} as never, {} as never, {} as never);

  it('returns immutable metrics and incident snapshots even when the live incident later changes', async () => {
    const report = await service.batchResults('batch-1');
    expect(report.metrics).toMatchObject({
      recoveredValuePaise: 0, recoveryRate: 0, eligibleCount: 1, eligibleValuePaise: 10000,
      recoveredEligibleValuePaise: 0, eligibleRecoveryRate: 0, pendingRecoveryValuePaise: 10000,
      protectedValuePaise: 20000, unsafeActionsPrevented: 1, unresolvedIncidents: 2,
    });
    expect(report.liveMetrics).toMatchObject({
      openValueAtRiskPaise: 20000, recoveredValuePaise: 10000, recoveryRate: 1 / 3,
      recoveredEligibleValuePaise: 10000, eligibleRecoveryRate: 1,
      pendingRecoveryValuePaise: 0, protectedValuePaise: 20000, unresolvedIncidents: 1,
      statusDistribution: { RECOVERED: 1, PROCESSING: 1 },
    });
    expect(report).toMatchObject({ immutable: true });
    expect(report.results[0]).toMatchObject({ finalState: IncidentStatus.AUTO_RETRY, recoveredValuePaise: 0, incident: { status: IncidentStatus.AUTO_RETRY, attempts: 0 } });
  });

  it('exports traceable CSV rows with escaped provider reasons', async () => {
    const csv = await service.batchExportCsv('batch-1');
    expect(csv).toContain('razorpay_payout_id');
    expect(csv).toContain('pout_1,10000,INR,AUTO_RETRY,0');
    expect(csv).toContain('"pending, bank confirmation"');
  });
});

describe('RecoveryService operational status', () => {
  it('calculates account-wide live metrics from current incident states', async () => {
    const prisma = { payoutIncident: { findMany: jest.fn().mockResolvedValue([
      { id: 'recovered', status: IncidentStatus.RECOVERED, amountPaise: 1_000_000, analyses: [], policyDecisions: [{ finalDecision: 'AUTO_RETRY' }], executions: [{ outcome: ExecutionOutcome.SUCCEEDED, responseJson: { id: 'pout_retry' } }], auditEvents: [] },
      { id: 'processing', status: IncidentStatus.PROCESSING, amountPaise: 250_000, analyses: [], policyDecisions: [], executions: [], auditEvents: [] },
      { id: 'stopped', status: IncidentStatus.STOPPED, amountPaise: 100_000, analyses: [], policyDecisions: [], executions: [], auditEvents: [{ eventType: 'HUMAN_REJECTED' }] },
    ]) } };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.operationalMetrics()).resolves.toMatchObject({
      valueAtRiskPaise: 1_350_000,
      openValueAtRiskPaise: 250_000,
      recoveredValuePaise: 1_000_000,
      protectedValuePaise: 350_000,
      manualInterventions: 1,
      unresolvedIncidents: 1,
      statusDistribution: { RECOVERED: 1, PROCESSING: 1, STOPPED: 1 },
    });
  });

  it('does not claim a naturally completed payout as RecoveryOS-recovered value', async () => {
    const prisma = { payoutIncident: { findMany: jest.fn().mockResolvedValue([
      { id: 'natural', status: IncidentStatus.RECOVERED, amountPaise: 500_000, analyses: [], policyDecisions: [], executions: [], auditEvents: [] },
      { id: 'duplicate', status: IncidentStatus.RECOVERED, amountPaise: 700_000, duplicateSuspected: true, analyses: [], policyDecisions: [], executions: [{ outcome: ExecutionOutcome.SUCCEEDED, responseJson: { id: 'pout_retry' } }], auditEvents: [] },
    ]) } };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.operationalMetrics()).resolves.toMatchObject({ valueAtRiskPaise: 1_200_000, recoveredValuePaise: 0 });
  });

  it('reports database, Redis, queue, and AI mode without exposing credentials', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 2, active: 1, delayed: 3, completed: 4, failed: 0, paused: 0 }),
    };
    const ai = { status: jest.fn().mockReturnValue({ mode: 'deterministic-simulator', configured: false, provider: 'deterministic', model: 'heuristic-v1', promptVersion: 'heuristic-v1' }) };
    const razorpay = { testDemoConfiguration: jest.fn().mockReturnValue({ enabled: false, ready: false, testMode: false, simulationSafe: true, fundAccountConfigured: false, amountPaise: 1_000_000, confirmation: 'CREATE INR 10000 TEST PAYOUT' }) };
    const service = new RecoveryService(prisma as never, ai as never, razorpay as never, queue as never);

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
    const razorpay = { testDemoConfiguration: jest.fn().mockReturnValue({ enabled: false, ready: false, testMode: false, simulationSafe: true, fundAccountConfigured: false, amountPaise: 1_000_000, confirmation: 'CREATE INR 10000 TEST PAYOUT' }) };
    const service = new RecoveryService(prisma as never, ai as never, razorpay as never, queue as never);

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

describe('RecoveryService remediation safety', () => {
  it('never converts an escalation directly into a retry approval', async () => {
    const prisma = { reviewTask: { findFirst: jest.fn().mockResolvedValue({ id: 'review-1', kind: ReviewKind.REMEDIATION, status: ReviewStatus.OPEN, remediationJson: null, incident: { id: 'incident-1', status: IncidentStatus.ESCALATE } }) } };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.decideReview('incident-1', true, 'token:operator')).rejects.toThrow('require recorded remediation');
  });

  it('enforces maker-checker separation after remediation', async () => {
    const prisma = { reviewTask: { findFirst: jest.fn().mockResolvedValue({ id: 'review-2', kind: ReviewKind.RETRY_APPROVAL, status: ReviewStatus.OPEN, remediationJson: { remediatedBy: 'token:operator' }, incident: { id: 'incident-1', status: IncidentStatus.APPROVAL_REQUIRED } }) } };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.decideReview('incident-1', true, 'token:operator')).rejects.toThrow('different actor');
  });

  it('atomically claims an approval and keeps the configured retry delay', async () => {
    const task = { id: 'review-3', kind: ReviewKind.RETRY_APPROVAL, status: ReviewStatus.OPEN, remediationJson: null, incident: { id: 'incident-3', status: IncidentStatus.APPROVAL_REQUIRED } };
    const transactionClient = {
      reviewTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: jest.fn() },
    };
    const prisma = {
      reviewTask: { findFirst: jest.fn().mockResolvedValue(task) },
      $transaction: jest.fn(async (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient)),
    };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service, 'getPolicy').mockResolvedValue({ version: 'v2', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 45 });
    const schedule = jest.spyOn(service as any, 'scheduleRetry').mockResolvedValue(undefined);

    await service.decideReview('incident-3', true, 'token:checker');

    expect(transactionClient.reviewTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'review-3', status: ReviewStatus.OPEN } }));
    expect(schedule).toHaveBeenCalledWith('incident-3', 45);
  });

  it('rejects a second concurrent decision after another request claims the review', async () => {
    const transactionClient = { reviewTask: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, payoutIncident: { updateMany: jest.fn() }, auditEvent: { create: jest.fn() } };
    const prisma = {
      reviewTask: { findFirst: jest.fn().mockResolvedValue({ id: 'review-4', kind: ReviewKind.RETRY_APPROVAL, status: ReviewStatus.OPEN, remediationJson: null, incident: { id: 'incident-4', status: IncidentStatus.APPROVAL_REQUIRED } }) },
      $transaction: jest.fn(async (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient)),
    };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service, 'getPolicy').mockResolvedValue({ version: 'v2', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 });

    await expect(service.decideReview('incident-4', true, 'token:checker')).rejects.toThrow('already been decided');
    expect(transactionClient.payoutIncident.updateMany).not.toHaveBeenCalled();
  });

  it('records remediation, revalidates policy, and opens a separate retry approval', async () => {
    const transactionClient = {
      reviewTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn() }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      policyDecision: { create: jest.fn() }, auditEvent: { create: jest.fn() },
    };
    const prisma = {
      reviewTask: { findFirst: jest.fn().mockResolvedValue({ id: 'review-1', kind: ReviewKind.REMEDIATION, status: ReviewStatus.OPEN, incident: { id: 'incident-1', status: IncidentStatus.ESCALATE, beneficiaryRef: 'fa_old' } }) },
      $transaction: jest.fn(async (callback: (client: typeof transactionClient) => Promise<void>) => callback(transactionClient)),
    };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service, 'getPolicy').mockResolvedValue({ version: 'v2', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 });
    jest.spyOn(service, 'incidentDetail').mockResolvedValue({ id: 'incident-1', status: IncidentStatus.APPROVAL_REQUIRED } as never);
    await service.remediateIncident('incident-1', { beneficiaryRef: 'fa_Corrected123', note: 'Validated replacement account from operations.' }, 'token:operator');
    expect(transactionClient.reviewTask.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: ReviewKind.RETRY_APPROVAL, remediationJson: expect.objectContaining({ remediatedBy: 'token:operator' }) }) });
    expect(transactionClient.payoutIncident.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: IncidentStatus.APPROVAL_REQUIRED, beneficiaryRef: 'fa_Corrected123' }) }));
  });
});

describe('RecoveryService policy evidence', () => {
  it('does not allow rules to change under an existing policy version', async () => {
    const prisma = {
      policyConfig: { findUnique: jest.fn().mockResolvedValue({ version: 'v1', rulesJson: { version: 'v1', maxAutoRetryAttempts: 1, maxAutonomousAmountPaise: 100_000, minimumRetryDelayMinutes: 30 } }) },
      $transaction: jest.fn(),
    };
    const service = new RecoveryService(prisma as never, {} as never, {} as never, {} as never);

    await expect(service.updatePolicy({ version: 'v1', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 100_000, minimumRetryDelayMinutes: 30 }))
      .rejects.toThrow('immutable');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
