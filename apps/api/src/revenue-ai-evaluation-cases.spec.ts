import { revenueEvaluationCases } from './revenue-ai-evaluation-cases';

describe('revenue AI evaluation cohort', () => {
  it('contains eight unique timeline-grounded scenarios', () => {
    expect(revenueEvaluationCases).toHaveLength(8);
    expect(new Set(revenueEvaluationCases.map(item => item.name))).toHaveProperty('size', 8);
    expect(revenueEvaluationCases.every(item => item.context.timeline.length >= 2)).toBe(true);
  });
});
