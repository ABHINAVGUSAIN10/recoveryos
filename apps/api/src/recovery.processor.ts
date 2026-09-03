import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ExecutionOutcome, IncidentStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { RazorpayExecutionUncertainError, RazorpayService } from './razorpay.service';
import { RecoveryService } from './recovery.service';
import { safeErrorMessage } from './redaction';

@Processor('recovery')
export class RecoveryProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService, private readonly razorpay: RazorpayService, private readonly recovery: RecoveryService) { super(); }
  async process(job: Job<{ executionId: string }>) {
    if (job.name !== 'execute-retry') return;
    const execution = await this.prisma.actionExecution.findUniqueOrThrow({ where: { id: job.data.executionId }, include: { incident: true } });
    if (execution.outcome !== ExecutionOutcome.PENDING) return;
    if (execution.incident.status === IncidentStatus.EXECUTING) {
      await this.recovery.recordExecutionResult(execution.id, ExecutionOutcome.UNKNOWN, { error: 'Worker resumed an in-progress execution; provider reconciliation is required.' });
      return;
    }
    if (execution.incident.status !== IncidentStatus.AUTO_RETRY) return;
    const claimed = await this.prisma.payoutIncident.updateMany({ where: { id: execution.incidentId, status: IncidentStatus.AUTO_RETRY }, data: { status: IncidentStatus.EXECUTING } });
    if (!claimed.count) return;
    try {
      const response = execution.actionType === 'RAZORPAYX_TEST_PAYOUT'
        ? await this.razorpay.executeTestDemoPayout(execution.idempotencyKey, execution.incidentId)
        : await this.razorpay.executeRecovery(execution.idempotencyKey, execution.incident.razorpayPayoutId, execution.incidentId, execution.incident.beneficiaryRef);
      const providerStatus = String(response?.status ?? '').toLowerCase();
      const outcome = providerStatus === 'processed'
        ? ExecutionOutcome.SUCCEEDED
        : ['failed', 'rejected', 'cancelled', 'reversed'].includes(providerStatus)
          ? ExecutionOutcome.FAILED
          : ExecutionOutcome.UNKNOWN;
      const recorded = await this.recovery.recordExecutionResult(execution.id, outcome, response);
      // A provider-confirmed terminal failure may enter a fresh AI + policy cycle.
      // This is not a BullMQ replay: policy rechecks the incremented attempt count
      // and, if allowed, creates a new delayed intent with a new idempotency key.
      if (outcome === ExecutionOutcome.FAILED && recorded.recorded) await this.recovery.analyze(recorded.incidentId);
    } catch (error) {
      const message = safeErrorMessage(error, 'Unknown execution failure');
      const unknown = error instanceof RazorpayExecutionUncertainError || /timeout|network|unknown|reconciliation/i.test(message);
      const recorded = await this.recovery.recordExecutionResult(execution.id, unknown ? ExecutionOutcome.UNKNOWN : ExecutionOutcome.FAILED, { error: message });
      if (unknown) return;
      if (recorded.recorded) await this.recovery.analyze(recorded.incidentId);
      throw error;
    }
  }
}
