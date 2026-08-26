import { ExecutionOutcome, IncidentStatus } from '@prisma/client';
import { RecoveryProcessor } from './recovery.processor';

describe('RecoveryProcessor fault handling', () => {
  const execution = { id: 'execution-1', incidentId: 'incident-1', idempotencyKey: 'recovery-1', outcome: ExecutionOutcome.PENDING, incident: { razorpayPayoutId: 'pout_1', status: IncidentStatus.AUTO_RETRY } };
  const job = { name: 'execute-retry', data: { executionId: execution.id } };

  it('records provider timeouts as execution unknown and does not retry inside the worker', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const razorpay = { executeRecovery: jest.fn().mockRejectedValue(new Error('network timeout token=private')) };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.UNKNOWN, { error: 'network timeout token=[REDACTED]' });
  });

  it('records definite provider failures and allows BullMQ retry policy to handle them', async () => {
    const prisma = { actionExecution: { findUniqueOrThrow: jest.fn().mockResolvedValue(execution) }, payoutIncident: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const razorpay = { executeRecovery: jest.fn().mockRejectedValue(new Error('definite provider rejection')) };
    const recovery = { recordExecutionResult: jest.fn() };
    const processor = new RecoveryProcessor(prisma as never, razorpay as never, recovery as never);

    await expect(processor.process(job as never)).rejects.toThrow('definite provider rejection');
    expect(recovery.recordExecutionResult).toHaveBeenCalledWith(execution.id, ExecutionOutcome.FAILED, { error: 'definite provider rejection' });
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
    expect(razorpay.executeRecovery).toHaveBeenCalledWith(execution.idempotencyKey, execution.incident.razorpayPayoutId, execution.incidentId);
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
});
