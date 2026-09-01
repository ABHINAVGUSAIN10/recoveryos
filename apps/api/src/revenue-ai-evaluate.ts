import { config } from 'dotenv';
import { evaluateRevenuePolicy, type RevenuePolicyConfig } from '@recoveryos/domain';
import { AiService } from './ai.service';
import { revenueEvaluationCases } from './revenue-ai-evaluation-cases';
import { DEFAULT_GROQ_EVALUATION_INTERVAL_MS, evaluationPacingDelayMs, wait } from './provider-rate-limit';

config({ path: '../../.env' });

const policy: RevenuePolicyConfig = { version: 'revenue-v1.0.0', maxAutomaticAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30, minimumConfidence: .7 };

async function main() {
  const liveRequired = process.argv.includes('--require-live');
  if (liveRequired && !process.env.AI_API_KEY) throw new Error('AI_API_KEY is required for a live revenue evaluation.');
  if (!liveRequired) delete process.env.AI_API_KEY;
  const requestedInterval = process.argv.find(argument => argument.startsWith('--request-interval-ms='))?.split('=')[1];
  const requestIntervalMs = requestedInterval ? Number.parseInt(requestedInterval, 10) : liveRequired && (process.env.AI_PROVIDER || '').toLowerCase() === 'groq' ? DEFAULT_GROQ_EVALUATION_INTERVAL_MS : 0;
  if (!Number.isFinite(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) throw new Error('Invalid evaluation interval.');
  const service = new AiService();
  const results = [];
  let lastRequestStartedAt: number | null = null;
  for (const [index, fixture] of revenueEvaluationCases.entries()) {
    if (liveRequired) {
      await wait(evaluationPacingDelayMs(lastRequestStartedAt, Date.now(), requestIntervalMs));
      lastRequestStartedAt = Date.now();
      console.error(JSON.stringify({ event: 'revenue_ai_evaluation_progress', current: index + 1, total: revenueEvaluationCases.length, case: fixture.name }));
    }
    const analysis = await service.analyzeRevenue(fixture.context);
    const decision = evaluateRevenuePolicy(fixture.context, analysis.proposal, policy);
    const categoryPassed = analysis.proposal.category === fixture.expectedCategory;
    const policyPassed = decision.finalAction === fixture.expectedPolicyAction;
    results.push({ case: fixture.name, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, expected: { category: fixture.expectedCategory, policyAction: fixture.expectedPolicyAction }, actual: { category: analysis.proposal.category, proposedAction: analysis.proposal.recommendedAction, policyAction: decision.finalAction, confidence: analysis.proposal.confidence }, evidenceEventIds: analysis.proposal.evidence.map(item => item.eventId), passed: categoryPassed && policyPassed });
  }
  const passed = results.filter(result => result.passed).length;
  const unsafeAuthorizations = results.filter(result => ['PROCESSING_DUPLICATE_RISK', 'EXPIRED_CARD', 'FRAUD_REVIEW'].includes(result.case) && result.actual.policyAction === 'AUTO_RETRY').length;
  console.log(JSON.stringify({ mode: liveRequired ? 'live-provider' : 'deterministic-simulator', total: results.length, passed, failed: results.length - passed, unsafeAuthorizations, results }, null, 2));
  if (passed !== results.length || unsafeAuthorizations) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Revenue AI evaluation failed'); process.exit(1); });
