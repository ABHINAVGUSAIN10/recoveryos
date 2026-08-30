import { z } from 'zod';

export const demoScenarioSchema = z.enum([
  'ALL',
  'TRANSIENT_LOW_VALUE',
  'TRANSIENT_HIGH_VALUE',
  'INVALID_BENEFICIARY',
  'PROCESSING_AMBIGUITY',
]);

export type DemoScenarioKey = Exclude<z.infer<typeof demoScenarioSchema>, 'ALL'>;

export type DemoScenario = {
  key: DemoScenarioKey;
  title: string;
  description: string;
  amountPaise: number;
  providerStatus: 'failed' | 'processing';
  reason: string;
  expectedAiAction: 'RETRY' | 'ESCALATE' | 'STOP';
  expectedPolicyDecision: 'AUTO_RETRY' | 'APPROVAL_REQUIRED' | 'ESCALATE' | 'STOPPED';
  humanRequired: boolean;
};

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    key: 'TRANSIENT_LOW_VALUE',
    title: 'Autonomous recovery',
    description: 'A low-value temporary bank failure should be classified for retry and authorized without human approval.',
    amountPaise: 500_000,
    providerStatus: 'failed',
    reason: 'Temporary beneficiary bank technical failure',
    expectedAiAction: 'RETRY',
    expectedPolicyDecision: 'AUTO_RETRY',
    humanRequired: false,
  },
  {
    key: 'TRANSIENT_HIGH_VALUE',
    title: 'Amount-cap approval',
    description: 'The AI recommends retry, but deterministic policy requires a human because the amount exceeds the autonomous cap.',
    amountPaise: 2_500_000,
    providerStatus: 'failed',
    reason: 'Temporary provider network failure',
    expectedAiAction: 'RETRY',
    expectedPolicyDecision: 'APPROVAL_REQUIRED',
    humanRequired: true,
  },
  {
    key: 'INVALID_BENEFICIARY',
    title: 'Automatic escalation',
    description: 'A closed beneficiary account cannot be repaired by retrying, so the system opens a review task.',
    amountPaise: 300_000,
    providerStatus: 'failed',
    reason: 'Beneficiary account is closed',
    expectedAiAction: 'ESCALATE',
    expectedPolicyDecision: 'ESCALATE',
    humanRequired: true,
  },
  {
    key: 'PROCESSING_AMBIGUITY',
    title: 'Duplicate prevention',
    description: 'A provider-processing payout is blocked from retry and left for reconciliation.',
    amountPaise: 400_000,
    providerStatus: 'processing',
    reason: 'Confirmation pending from destination institution',
    expectedAiAction: 'STOP',
    expectedPolicyDecision: 'STOPPED',
    humanRequired: false,
  },
];

