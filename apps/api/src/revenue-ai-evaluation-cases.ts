import type { RevenueIncidentContext } from '@recoveryos/domain';
import { REVENUE_DEMO_SCENARIOS } from './revenue-demo-scenarios';

const anchor = new Date('2026-09-01T00:00:00.000Z');

export const revenueEvaluationCases = REVENUE_DEMO_SCENARIOS.map((scenario, index) => ({
  name: scenario.key,
  context: {
    incidentId: `revenue-eval-${index + 1}`,
    sourcePaymentId: `pay_revenue_eval_${index + 1}`,
    amountPaise: scenario.amountPaise,
    currency: 'INR',
    paymentMethod: scenario.paymentMethod,
    failureCode: scenario.failureCode,
    failureDescription: scenario.failureDescription,
    attemptCount: 0,
    consentToContact: scenario.consentToContact,
    timeline: [
      ...scenario.priorEvents.map((event, eventIndex) => ({ eventId: `evt-${index + 1}-prior-${eventIndex}`, eventType: event.eventType, occurredAt: new Date(anchor.getTime() - event.minutesAgo * 60_000).toISOString(), summary: event.summary })),
      { eventId: `evt-${index + 1}-failed`, eventType: 'payment.failed', occurredAt: anchor.toISOString(), summary: scenario.failureDescription },
    ],
  } satisfies RevenueIncidentContext,
  expectedCategory: scenario.expectedCategory,
  expectedPolicyAction: scenario.expectedPolicyAction,
}));
