import { fullEvaluationCases, smokeEvaluationCases } from './ai-evaluation-cases';

describe('AI evaluation cohorts', () => {
  it('provides a fixed 50-case full cohort with unique identifiers', () => {
    expect(fullEvaluationCases).toHaveLength(50);
    expect(new Set(fullEvaluationCases.map(fixture => fixture.name)).size).toBe(50);
    expect(new Set(fullEvaluationCases.map(fixture => fixture.incident.razorpayPayoutId)).size).toBe(50);
  });

  it('covers every supported category and action in the smoke cohort', () => {
    expect(smokeEvaluationCases).toHaveLength(6);
    expect(new Set(smokeEvaluationCases.map(fixture => fixture.expectedCategory)).size).toBe(6);
    expect(new Set(smokeEvaluationCases.map(fixture => fixture.expectedAction))).toEqual(
      new Set(['RETRY', 'ESCALATE', 'STOP', 'NO_ACTION']),
    );
  });
});
