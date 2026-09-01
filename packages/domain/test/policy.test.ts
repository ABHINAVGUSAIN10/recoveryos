import { describe, expect, it } from 'vitest';
import { evaluatePolicy, evaluateRevenuePolicy, type AiProposal, type Incident, type PolicyConfig, type RevenueIncidentContext, type RevenuePolicyConfig, type RevenueProposal } from '../src/index.js';

const config: PolicyConfig = { version: 'v1', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 };
const incident: Incident = { razorpayPayoutId: 'pout_test', status: 'FAILED', amountPaise: 50_000, currency: 'INR', attempts: 0, duplicateSuspected: false, policyVersion: 'v1' };
const transient: AiProposal = { category: 'TRANSIENT_TECHNICAL', confidence: .9, evidenceSummary: 'Temporary bank failure', recommendedAction: 'RETRY', proposedDelayMinutes: 10 };

describe('recovery policy', () => {
  it('allows only bounded transient retries', () => expect(evaluatePolicy(incident, transient, config)).toMatchObject({ decision: 'AUTO_RETRY', delayMinutes: 30 }));
  it('stops processing payouts even if the model requests a retry', () => expect(evaluatePolicy({ ...incident, status: 'PROCESSING' }, transient, config).decision).toBe('STOPPED'));
  it('stops duplicate-suspected payouts', () => expect(evaluatePolicy({ ...incident, duplicateSuspected: true }, transient, config).decision).toBe('STOPPED'));
  it('requires approval above the cap', () => expect(evaluatePolicy({ ...incident, amountPaise: 1_000_001 }, transient, config).decision).toBe('APPROVAL_REQUIRED'));
});

const revenueConfig: RevenuePolicyConfig = { version: 'revenue-v1', maxAutomaticAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30, minimumConfidence: .7 };
const revenueContext: RevenueIncidentContext = {
  incidentId: 'revenue-1', sourcePaymentId: 'pay_1', amountPaise: 75_000, currency: 'INR', paymentMethod: 'card',
  failureCode: 'GATEWAY_TIMEOUT', failureDescription: 'Gateway temporarily unavailable', attemptCount: 0, consentToContact: true,
  timeline: [{ eventId: 'evt-1', eventType: 'payment.failed', occurredAt: '2026-09-01T00:00:00.000Z', summary: 'Gateway timeout' }],
};
const revenueProposal: RevenueProposal = {
  category: 'TRANSIENT_PROVIDER', confidence: .92, diagnosis: 'The gateway failure is transient.',
  evidence: [{ eventId: 'evt-1', fact: 'Gateway timeout' }], recommendedAction: 'SMART_RETRY', proposedDelayMinutes: 10,
  playbook: [{ order: 1, action: 'SMART_RETRY', delayMinutes: 10, requiresHuman: false, rationale: 'Retry after the provider cools down.' }], riskFlags: [],
};

describe('inbound revenue policy', () => {
  it('authorizes only the bounded first smart-retry step', () => expect(evaluateRevenuePolicy(revenueContext, revenueProposal, revenueConfig)).toMatchObject({ finalAction: 'AUTO_RETRY', authorized: true, delayMinutes: 30 }));
  it('rejects invented evidence references', () => expect(evaluateRevenuePolicy(revenueContext, { ...revenueProposal, evidence: [{ eventId: 'invented', fact: 'not persisted' }] }, revenueConfig)).toMatchObject({ finalAction: 'STOPPED', authorized: false, reasons: ['REV-01: AI cited evidence outside the persisted timeline'] }));
  it('blocks duplicate-prone or processing payments', () => expect(evaluateRevenuePolicy(revenueContext, { ...revenueProposal, category: 'DUPLICATE_OR_PROCESSING', recommendedAction: 'STOP', proposedDelayMinutes: null, riskFlags: ['DUPLICATE_RISK'] }, revenueConfig).finalAction).toBe('STOPPED'));
  it('requires approval for a customer-facing action and verified consent', () => {
    const link = { ...revenueProposal, category: 'CUSTOMER_AUTHENTICATION' as const, recommendedAction: 'CREATE_PAYMENT_LINK' as const, proposedDelayMinutes: null, riskFlags: ['AUTHENTICATION_REQUIRED' as const] };
    expect(evaluateRevenuePolicy(revenueContext, link, revenueConfig).finalAction).toBe('APPROVAL_REQUIRED');
    expect(evaluateRevenuePolicy({ ...revenueContext, consentToContact: false }, link, revenueConfig).finalAction).toBe('STOPPED');
  });
  it('requires human approval above the autonomous amount cap', () => expect(evaluateRevenuePolicy({ ...revenueContext, amountPaise: 1_000_001 }, { ...revenueProposal, riskFlags: ['HIGH_VALUE'] }, revenueConfig).finalAction).toBe('APPROVAL_REQUIRED'));
});
