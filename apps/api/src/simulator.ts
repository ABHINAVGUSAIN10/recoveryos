import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RecoveryService } from './recovery.service';

async function main() {
  const liveAi = process.argv.includes('--live-ai');
  if (!liveAi) delete process.env.AI_API_KEY;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const service = app.get(RecoveryService);
  const cases = Array.from({ length: 100 }, (_, i) => {
    const group = i % 10;
    const details = group < 3 ? ['temporary beneficiary bank technical failure', 'failed'] : group < 5 ? ['beneficiary account closed', 'failed'] : group < 7 ? ['payout reversed', 'reversed'] : group === 7 ? ['payout processing', 'processing'] : group === 8 ? ['unmapped provider reason', 'failed'] : ['already processed', 'processed'];
    return { event_id: `sim-${i + 1}`, event: 'payout.updated', payload: { payout: { entity: { id: `pout_sim_${String(i + 1).padStart(3, '0')}`, status: details[1], amount: 100_000 + i * 1_000, currency: 'INR', reference_id: `demo-${i + 1}`, status_details: { description: details[0] } } } } };
  });
  const ids: string[] = [];
  for (const fixture of cases) { const result = await service.ingestWebhook(fixture.event_id, fixture.event, fixture); if (result.incidentId) ids.push(result.incidentId); }
  const batch = await service.createBatch('RecoveryOS 100-case deterministic cohort', ids);
  console.log(JSON.stringify({ batchId: batch.id, aiMode: liveAi ? 'live-provider' : 'deterministic-simulator', metrics: batch.metrics }, null, 2));
  await app.close();
}
main().catch(error => { console.error(error); process.exit(1); });
