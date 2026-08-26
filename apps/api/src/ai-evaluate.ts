import { config } from 'dotenv';
import { AiService } from './ai.service';
import { fullEvaluationCases, smokeEvaluationCases } from './ai-evaluation-cases';
import { DEFAULT_GROQ_EVALUATION_INTERVAL_MS, evaluationPacingDelayMs, wait } from './provider-rate-limit';

config({ path: '../../.env' });

function nonNegativeInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60_000) throw new Error(`Invalid evaluation interval: ${value}`);
  return parsed;
}

async function main() {
  const liveRequired = process.argv.includes('--require-live');
  const summaryOnly = process.argv.includes('--summary-only');
  const requestedCase = process.argv.find(argument => argument.startsWith('--case='))?.slice('--case='.length);
  const cohort = process.argv.find(argument => argument.startsWith('--cohort='))?.slice('--cohort='.length) || 'smoke';
  if (cohort !== 'smoke' && cohort !== 'full') throw new Error(`Unknown evaluation cohort: ${cohort}`);
  if (liveRequired && !process.env.AI_API_KEY) throw new Error('AI_API_KEY is required for a live provider evaluation.');
  if (!liveRequired) delete process.env.AI_API_KEY;
  const cohortCases = cohort === 'full' ? fullEvaluationCases : smokeEvaluationCases;
  const selectedCases = requestedCase ? fullEvaluationCases.filter(fixture => fixture.name === requestedCase) : cohortCases;
  if (!selectedCases.length) throw new Error(`Unknown evaluation case: ${requestedCase}`);
  const requestedInterval = process.argv.find(argument => argument.startsWith('--request-interval-ms='))?.slice('--request-interval-ms='.length);
  const groqDefault = liveRequired && (process.env.AI_PROVIDER || '').toLowerCase() === 'groq'
    ? DEFAULT_GROQ_EVALUATION_INTERVAL_MS
    : 0;
  const requestIntervalMs = nonNegativeInteger(requestedInterval ?? process.env.AI_EVAL_REQUEST_INTERVAL_MS, groqDefault);
  const service = new AiService();
  const results = [];
  const startedAt = Date.now();
  let lastRequestStartedAt: number | null = null;
  for (const [caseIndex, fixture] of selectedCases.entries()) {
    if (liveRequired) {
      const pacingDelayMs = evaluationPacingDelayMs(lastRequestStartedAt, Date.now(), requestIntervalMs);
      await wait(pacingDelayMs);
      lastRequestStartedAt = Date.now();
      console.error(JSON.stringify({
        event: 'ai_evaluation_progress', current: caseIndex + 1, total: selectedCases.length,
        case: fixture.name, requestIntervalMs,
      }));
    }
    const analysis = await service.classify(fixture.incident);
    results.push({
      case: fixture.name, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion,
      expected: { category: fixture.expectedCategory, action: fixture.expectedAction },
      actual: { category: analysis.proposal.category, action: analysis.proposal.recommendedAction, confidence: analysis.proposal.confidence },
      passed: analysis.proposal.category === fixture.expectedCategory && analysis.proposal.recommendedAction === fixture.expectedAction,
    });
  }
  const passed = results.filter(result => result.passed).length;
  const unsafeRecommendations = results.filter(result =>
    ['PROCESSING_AMBIGUITY', 'UNKNOWN', 'INVALID_BENEFICIARY', 'REVERSED'].includes(result.expected.category)
      && result.actual.action === 'RETRY',
  ).length;
  const summary = {
    mode: liveRequired ? 'live-provider' : 'deterministic-simulator', cohort,
    requestIntervalMs, durationMs: Date.now() - startedAt,
    total: results.length, passed, failed: results.length - passed, unsafeRecommendations,
  };
  console.log(JSON.stringify(summaryOnly
    ? { ...summary, failures: results.filter(result => !result.passed) }
    : { ...summary, results }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exit(1); });
