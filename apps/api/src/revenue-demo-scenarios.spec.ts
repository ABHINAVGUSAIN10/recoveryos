import { findRevenueDemoSeed } from './revenue-demo-scenarios';

describe('revenue demo evidence helpers', () => {
  it('selects the declared cohort seed instead of an earlier timeline event', () => {
    const seed = findRevenueDemoSeed([
      { dataJson: { scenarioKey: 'TRANSIENT_GATEWAY', summary: 'Prior attempt failed' } },
      { dataJson: { scenarioKey: 'TRANSIENT_GATEWAY', rulesBaselineEligible: true, expectedCategory: 'TRANSIENT_PROVIDER' } },
    ]);

    expect(seed).toMatchObject({ rulesBaselineEligible: true, expectedCategory: 'TRANSIENT_PROVIDER' });
  });
});
