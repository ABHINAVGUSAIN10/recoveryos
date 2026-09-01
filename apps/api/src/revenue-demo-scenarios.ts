export type RevenueDemoScenario = {
  key: string;
  title: string;
  amountPaise: number;
  paymentMethod: string;
  failureCode: string;
  failureDescription: string;
  consentToContact: boolean;
  priorEvents: Array<{ eventType: string; minutesAgo: number; summary: string }>;
  simulatedOutcome: 'CAPTURED' | 'NOT_ACTIONABLE';
  rulesBaselineEligible: boolean;
  expectedCategory: string;
  expectedPolicyAction: string;
};

export function findRevenueDemoSeed(events: Array<{ dataJson: unknown }>) {
  for (const event of events) {
    if (!event.dataJson || typeof event.dataJson !== 'object') continue;
    const data = event.dataJson as Record<string, unknown>;
    if (typeof data.scenarioKey === 'string' && typeof data.rulesBaselineEligible === 'boolean') return data;
  }
  return undefined;
}

/** Fixed controlled cohort. Outcomes are declared up front so runs are reproducible and never presented as production lift. */
export const REVENUE_DEMO_SCENARIOS: RevenueDemoScenario[] = [
  {
    key: 'TRANSIENT_GATEWAY', title: 'Transient gateway recovery', amountPaise: 750_000, paymentMethod: 'card',
    failureCode: 'GATEWAY_TIMEOUT', failureDescription: 'Acquirer gateway temporarily unavailable after authorization attempt', consentToContact: true,
    priorEvents: [{ eventType: 'checkout.started', minutesAgo: 4, summary: 'Customer completed checkout and initiated one card attempt.' }],
    simulatedOutcome: 'CAPTURED', rulesBaselineEligible: true, expectedCategory: 'TRANSIENT_PROVIDER', expectedPolicyAction: 'AUTO_RETRY',
  },
  {
    key: 'SOFT_DECLINE', title: 'Issuer soft-decline recovery', amountPaise: 450_000, paymentMethod: 'card',
    failureCode: 'ISSUER_DECLINED', failureDescription: 'Issuer soft decline: do not honor; retry may succeed later', consentToContact: true,
    priorEvents: [{ eventType: 'payment.authorized', minutesAgo: 10, summary: 'A previous authorization attempt reached the issuer but was not captured.' }],
    simulatedOutcome: 'CAPTURED', rulesBaselineEligible: false, expectedCategory: 'SOFT_DECLINE', expectedPolicyAction: 'AUTO_RETRY',
  },
  {
    key: 'INSUFFICIENT_FUNDS', title: 'Timed insufficient-funds retry', amountPaise: 320_000, paymentMethod: 'upi_autopay',
    failureCode: 'LOW_BALANCE', failureDescription: 'Customer account has insufficient funds for the mandate debit', consentToContact: true,
    priorEvents: [{ eventType: 'mandate.active', minutesAgo: 1440, summary: 'The recurring mandate is active and permits one bounded retry.' }],
    simulatedOutcome: 'CAPTURED', rulesBaselineEligible: false, expectedCategory: 'INSUFFICIENT_FUNDS', expectedPolicyAction: 'AUTO_RETRY',
  },
  {
    key: 'HIGH_VALUE', title: 'High-value approval', amountPaise: 2_500_000, paymentMethod: 'card',
    failureCode: 'GATEWAY_TIMEOUT', failureDescription: 'Temporary provider network timeout on a high-value invoice', consentToContact: true,
    priorEvents: [{ eventType: 'invoice.due', minutesAgo: 60, summary: 'A high-value invoice remains unpaid after one attempt.' }],
    simulatedOutcome: 'CAPTURED', rulesBaselineEligible: true, expectedCategory: 'TRANSIENT_PROVIDER', expectedPolicyAction: 'APPROVAL_REQUIRED',
  },
  {
    key: 'AUTH_REQUIRED', title: 'Customer authentication', amountPaise: 600_000, paymentMethod: 'card',
    failureCode: '3DS_REQUIRED', failureDescription: 'Customer action and 3DS authentication are required', consentToContact: true,
    priorEvents: [{ eventType: 'checkout.abandoned', minutesAgo: 20, summary: 'Checkout ended before the customer completed authentication.' }],
    simulatedOutcome: 'CAPTURED', rulesBaselineEligible: false, expectedCategory: 'CUSTOMER_AUTHENTICATION', expectedPolicyAction: 'APPROVAL_REQUIRED',
  },
  {
    key: 'EXPIRED_CARD', title: 'Invalid payment method', amountPaise: 280_000, paymentMethod: 'card',
    failureCode: 'CARD_EXPIRED', failureDescription: 'The saved card is expired and must be replaced', consentToContact: false,
    priorEvents: [{ eventType: 'subscription.renewal_due', minutesAgo: 30, summary: 'A subscription renewal became due with a saved card.' }],
    simulatedOutcome: 'NOT_ACTIONABLE', rulesBaselineEligible: false, expectedCategory: 'INVALID_PAYMENT_METHOD', expectedPolicyAction: 'ESCALATE',
  },
  {
    key: 'PROCESSING_DUPLICATE_RISK', title: 'Duplicate-charge prevention', amountPaise: 910_000, paymentMethod: 'upi',
    failureCode: 'PAYMENT_PENDING', failureDescription: 'Payment is processing and final confirmation is pending', consentToContact: true,
    priorEvents: [{ eventType: 'payment.processing', minutesAgo: 2, summary: 'The provider accepted the payment and has not returned a terminal result.' }],
    simulatedOutcome: 'NOT_ACTIONABLE', rulesBaselineEligible: false, expectedCategory: 'DUPLICATE_OR_PROCESSING', expectedPolicyAction: 'STOPPED',
  },
  {
    key: 'FRAUD_REVIEW', title: 'Compliance escalation', amountPaise: 1_200_000, paymentMethod: 'card',
    failureCode: 'RISK_BLOCK', failureDescription: 'Provider risk engine flagged the payment for possible fraud review', consentToContact: false,
    priorEvents: [{ eventType: 'risk.flagged', minutesAgo: 1, summary: 'The provider risk engine blocked automatic collection.' }],
    simulatedOutcome: 'NOT_ACTIONABLE', rulesBaselineEligible: false, expectedCategory: 'FRAUD_OR_COMPLIANCE', expectedPolicyAction: 'ESCALATE',
  },
];
