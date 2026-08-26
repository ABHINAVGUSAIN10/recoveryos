import type { FailureCategory, Incident, ProposedAction } from '@recoveryos/domain';

export type EvaluationCase = {
  name: string;
  incident: Incident;
  expectedCategory: FailureCategory;
  expectedAction: ProposedAction;
};

const base = {
  amountPaise: 100_000,
  currency: 'INR',
  attempts: 0,
  duplicateSuspected: false,
  policyVersion: 'v1.0.0',
} as const;

function evaluationCase(
  name: string,
  index: number,
  status: Incident['status'],
  reason: string | null,
  expectedCategory: FailureCategory,
  expectedAction: ProposedAction,
): EvaluationCase {
  return {
    name,
    incident: {
      ...base,
      razorpayPayoutId: `eval_${String(index + 1).padStart(3, '0')}`,
      amountPaise: base.amountPaise + index * 1_000,
      attempts: index % 2,
      status,
      reason,
    },
    expectedCategory,
    expectedAction,
  };
}

const transientReasons = [
  ['temporary-bank-failure', 'Temporary beneficiary bank technical failure'],
  ['network-route-unavailable', 'Bank network temporarily unavailable'],
  ['beneficiary-service-unavailable', 'Beneficiary bank technical service unavailable'],
  ['provider-gateway-network-error', 'Provider gateway network error'],
  ['upstream-technical-failure', 'Upstream bank technical failure'],
  ['intermittent-network-failure', 'Intermittent payout network failure'],
  ['temporary-provider-unavailable', 'Temporary provider service unavailable'],
  ['bank-api-connectivity-failure', 'Bank API connectivity technical failure'],
  ['technical-switch-error', 'Technical payment switch error'],
  ['temporary-clearing-error', 'Temporary clearing network error'],
] as const;

const invalidReasons = [
  ['invalid-beneficiary', 'Beneficiary account closed'],
  ['account-closed', 'Destination account is closed'],
  ['account-frozen', 'Beneficiary account frozen'],
  ['account-dormant', 'Beneficiary account dormant'],
  ['invalid-bank-account', 'Invalid beneficiary bank account'],
  ['beneficiary-invalid', 'Beneficiary details invalid'],
  ['closed-beneficiary-account', 'Closed beneficiary account cannot receive funds'],
  ['frozen-beneficiary', 'Frozen beneficiary account'],
  ['dormant-beneficiary', 'Dormant beneficiary account'],
  ['invalid-beneficiary-details', 'Invalid beneficiary details supplied'],
] as const;

const processingReasons = [
  ['processing-ambiguity', 'Payout pending at provider'],
  ['bank-confirmation-pending', 'Confirmation pending from destination institution'],
  ['provider-processing', 'Provider is processing the payout'],
  ['awaiting-terminal-status', 'Awaiting a terminal payout status'],
  ['submitted-no-terminal-status', 'Submitted without a terminal outcome'],
  ['acknowledged-outcome-pending', 'Execution acknowledged; final outcome pending'],
  ['queued-by-provider', 'Payout queued by provider'],
  ['submitted-outcome-unresolved', 'Submission accepted but outcome unresolved'],
] as const;

const reversedReasons = [
  ['reversed-payout', 'Payout reversed by bank'],
  ['bank-reversal-confirmed', 'Bank reversal confirmed'],
  ['reverted-after-debit', 'Payout reverted after debit'],
  ['provider-marked-reversed', 'Provider marked transaction reversed'],
  ['beneficiary-bank-reversed', 'Beneficiary institution reversed transfer'],
  ['settlement-reverted', 'Settlement reverted'],
  ['transfer-reversal-received', 'Transfer reversal received'],
  ['debit-reversed', 'Debit reversed to source'],
] as const;

const unknownReasons = [
  ['unknown-reason', 'Unmapped provider code X-17'],
  ['provider-code-x17', 'Provider returned code X17'],
  ['failure-code-zz9', 'Failure code ZZ9'],
  ['no-status-detail', 'No mapped status detail'],
  ['opaque-provider-response', 'Opaque provider response'],
  ['unsupported-reason-code', 'Unsupported reason code Q4'],
  ['missing-description', null],
  ['generic-failure', 'Payout failed without detail'],
] as const;

const successfulReasons = [
  ['already-successful', 'Already completed'],
  ['provider-confirmed-processed', 'Provider confirmed processed'],
  ['payout-successful', 'Payout successful'],
  ['beneficiary-credited', 'Beneficiary credited'],
  ['terminal-success-confirmed', 'Terminal success confirmed'],
  ['recovered-after-retry', 'Recovered after retry'],
] as const;

let index = 0;
function expand(
  fixtures: ReadonlyArray<readonly [string, string | null]>,
  status: Incident['status'],
  category: FailureCategory,
  action: ProposedAction,
) {
  return fixtures.map(([name, reason]) => evaluationCase(name, index++, status, reason, category, action));
}

export const fullEvaluationCases: EvaluationCase[] = [
  ...expand(transientReasons, 'FAILED', 'TRANSIENT_TECHNICAL', 'RETRY'),
  ...expand(invalidReasons, 'FAILED', 'INVALID_BENEFICIARY', 'ESCALATE'),
  ...expand(processingReasons, 'PROCESSING', 'PROCESSING_AMBIGUITY', 'STOP'),
  ...expand(reversedReasons, 'REVERSED', 'REVERSED', 'ESCALATE'),
  ...expand(unknownReasons, 'FAILED', 'UNKNOWN', 'STOP'),
  ...expand(successfulReasons, 'RECOVERED', 'SUCCESSFUL', 'NO_ACTION'),
];

const smokeCaseNames = new Set([
  'temporary-bank-failure', 'invalid-beneficiary', 'processing-ambiguity',
  'reversed-payout', 'unknown-reason', 'already-successful',
]);

export const smokeEvaluationCases = fullEvaluationCases.filter(fixture => smokeCaseNames.has(fixture.name));
