import { describe, expect, it } from 'vitest';
import { evaluatePolicy, type AiProposal, type Incident, type PolicyConfig } from '../src/index.js';

const config: PolicyConfig = { version: 'v1', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 };
const incident: Incident = { razorpayPayoutId: 'pout_test', status: 'FAILED', amountPaise: 50_000, currency: 'INR', attempts: 0, duplicateSuspected: false, policyVersion: 'v1' };
const transient: AiProposal = { category: 'TRANSIENT_TECHNICAL', confidence: .9, evidenceSummary: 'Temporary bank failure', recommendedAction: 'RETRY', proposedDelayMinutes: 10 };

describe('recovery policy', () => {
  it('allows only bounded transient retries', () => expect(evaluatePolicy(incident, transient, config)).toMatchObject({ decision: 'AUTO_RETRY', delayMinutes: 30 }));
  it('stops processing payouts even if the model requests a retry', () => expect(evaluatePolicy({ ...incident, status: 'PROCESSING' }, transient, config).decision).toBe('STOPPED'));
  it('stops duplicate-suspected payouts', () => expect(evaluatePolicy({ ...incident, duplicateSuspected: true }, transient, config).decision).toBe('STOPPED'));
  it('requires approval above the cap', () => expect(evaluatePolicy({ ...incident, amountPaise: 1_000_001 }, transient, config).decision).toBe('APPROVAL_REQUIRED'));
});
