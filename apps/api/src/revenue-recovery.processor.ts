import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { RevenueRecoveryService } from './revenue-recovery.service';

@Processor('revenue-recovery')
export class RevenueRecoveryProcessor extends WorkerHost {
  constructor(private readonly revenue: RevenueRecoveryService) { super(); }
  async process(job: Job<{ actionId: string }>) {
    if (job.name !== 'execute-revenue-action') return;
    return this.revenue.executeAction(job.data.actionId);
  }
}
