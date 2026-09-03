import { ExecutionOutcome, IncidentStatus } from '@prisma/client';
import { RecoveryProcessor } from './recovery.processor';

describe('RecoveryProcessor fault handling', () => {
  const execution = { id: 'execution-1', incidentId: 'incident-1', idempotencyKey: 'recovery-1', outcome: ExecutionOutcome.PENDING, incident: { razorpayPayoutId: 'pout_1', status: IncidentStatus.AUTO_RETRY } };
  const job = { name: 'execute-retry', data: { executionId: execution.id } };

  it('records provider timeouts as execution unknown and does not retry inside the worker', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const razorpay = { executeRecovery: jest.fn().mockRejectedValue(new Error('network timeout token=private')) };
    const recovery = { recordExecutionResult: jest.fn().mockResolvedValue({ recorded: true, incidentId: execution.incidentId }), analyze: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.UNKNOWN, { error: 'network timeout token=[REDACTED]' });
  });

  it('records definite request failures without blindly replaying the financial call', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const razorpay = { executeRecovery: jest.fn().mockRejectedValue(new Error('definite provider rejection')) };
    const recovery = { recordExecutionResult: jest.fn().mockResolvedValue({ recorded: true, incidentId: execution.incidentId }), analyze: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).rejects.toThrow('definite provider rejection');
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.FAILED, { error: 'definite provider rejection' });
    expect(recovery.analyze).toHaveBeenCalledWith(execution.incidentId);
  });

  it('re-evaluates a provider-confirmed terminal failure under the incremented retry limit', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const response = { id: 'pout_retry', status: 'failed', status_details: { description: 'Temporary bank outage' } };
    const recovery = { recordExecutionResult: jest.fn().mockResolvedValue({ recorded: true, incidentId: execution.incidentId }), analyze: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, { executeRecovery: jest.fn().mockResolvedValue(response) } as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(recovery.analyze).toHaveBeenCalledWith(execution.incidentId);
  });

  it('converts an execution interrupted by a worker restart to unknown without calling Razorpay again', async () => {
    const resumed = { ...execution, incident: { ...execution.incident, status: IncidentStatus.EXECUTING } };
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(resumed) }, payoutIncident: { updateMany: jest.fn() } };
    const razorpay = { executeRecovery: jest.fn() };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.UNKNOWN, expect.objectContaining({ error: expect.stringContaining('reconciliation') }));
    expect(razorpay.executeRecovery).not.toHaveBeenCalled();
  });

  it('allows only one worker to claim an automatic retry', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const razorpay = { executeRecovery: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, { recordExecutionResult: jest.fn() } as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(razorpay.executeRecovery).not.toHaveBeenCalled();
  });

  it('keeps a newly created processing payout execution-unknown until a terminal outcome', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const response = { id: 'pout_retry', status: 'processing' };
    const razorpay = { executeRecovery: jest.fn().mockResolvedValue(response) };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(razorpay.executeRecovery).toHaveBeenCalledWith(execution.idempotencyKey, execution.incident.razorpayPayoutId, execution.incidentId, undefined);
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.UNKNOWN, response);
  });

  it('marks an execution recovered only when Razorpay confirms processed', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const response = { id: 'pout_retry', status: 'processed' };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, { executeRecovery: jest.fn().mockResolvedValue(response) } as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.SUCCEEDED, response);
  });

  it('routes the dedicated demo action to RazorpayX Test Mode without using the normal recreation adapter', async () => {
    const providerExecution = { ...execution, actionType: 'RAZORPAYX_TEST_PAYOUT' };
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(providerExecution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const razorpay = { executeTestDemoPayout: jest.fn().mockResolvedValue({ id: 'pout_demo', status: 'processing' }), executeRecovery: jest.fn() };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(razorpay.executeTestDemoPayout).toHaveBeenCalledWith(execution.idempotencyKey, execution.incidentId);
    expect(razorpay.executeRecovery).not.toHaveBeenCalled();
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.UNKNOWN, { id: 'pout_demo', status: 'processing' });
  });
});
