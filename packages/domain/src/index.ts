import { z } from 'zod';

export const failureCategorySchema = z.enum([
  'TRANSIENT_TECHNICAL', 'INVALID_BENEFICIARY', 'REVERSED', 'PROCESSING_AMBIGUITY', 'UNKNOWN', 'SUCCESSFUL',
]);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

export const proposedActionSchema = z.enum(['RETRY', 'ESCALATE', 'STOP', 'NO_ACTION']);
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export const policyDecisionSchema = z.enum(['AUTO_RETRY', 'APPROVAL_REQUIRED', 'ESCALATE', 'STOPPED', 'NO_ACTION']);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const incidentStatusSchema = z.enum([
  'RECEIVED', 'ANALYZING', 'POLICY_PENDING', 'AUTO_RETRY', 'APPROVAL_REQUIRED', 'STOPPED', 'NO_ACTION',
  'EXECUTING', 'PROCESSING', 'RECOVERED', 'FAILED', 'REVERSED', 'ESCALATE', 'EXECUTION_UNKNOWN',
]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentSchema = z.object({
  id: z.string().uuid().optional(), razorpayPayoutId: z.string(), status: incidentStatusSchema,
  amountPaise: z.number().int().nonnegative(), currency: z.string().length(3).default('INR'),
  reason: z.string().nullable().optional(), beneficiaryRef: z.string().nullable().optional(), attempts: z.number().int().nonnegative(),
  duplicateSuspected: z.boolean().default(false), policyVersion: z.string().default('v1.0.0'),
});
export type Incident = z.infer<typeof incidentSchema>;

export const aiProposalSchema = z.object({
  category: failureCategorySchema, confidence: z.number().min(0).max(1), evidenceSummary: z.string().min(1).max(1000),
  recommendedAction: proposedActionSchema, proposedDelayMinutes: z.number().int().min(0).max(10080).nullable(),
});
export type AiProposal = z.infer<typeof aiProposalSchema>;

export const policyConfigSchema = z.object({
  version: z.string().min(1), maxAutoRetryAttempts: z.number().int().min(0).max(10).default(2),
  maxAutonomousAmountPaise: z.number().int().positive().default(1_000_000), minimumRetryDelayMinutes: z.number().int().min(0).default(30),
});
export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const beneficiaryRemediationSchema = z.object({
  beneficiaryRef: z.string().trim().min(3).max(200),
  note: z.string().trim().min(10).max(500),
});
export type BeneficiaryRemediation = z.infer<typeof beneficiaryRemediationSchema>;

export const revenueFailureCategorySchema = z.enum([
  'TRANSIENT_PROVIDER', 'SOFT_DECLINE', 'INSUFFICIENT_FUNDS', 'CUSTOMER_AUTHENTICATION',
  'INVALID_PAYMENT_METHOD', 'DUPLICATE_OR_PROCESSING', 'FRAUD_OR_COMPLIANCE', 'UNKNOWN',
]);
export type RevenueFailureCategory = z.infer<typeof revenueFailureCategorySchema>;

export const revenueProposedActionSchema = z.enum(['SMART_RETRY', 'CREATE_PAYMENT_LINK', 'CONTACT_CUSTOMER', 'ESCALATE', 'STOP']);
export type RevenueProposedAction = z.infer<typeof revenueProposedActionSchema>;

export const revenueTimelineEventSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(100),
  occurredAt: z.string().datetime(),
  summary: z.string().min(1).max(500),
});

export const revenueIncidentContextSchema = z.object({
  incidentId: z.string().min(1),
  sourcePaymentId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  currency: z.string().length(3),
  paymentMethod: z.string().min(1).max(50),
  failureCode: z.string().min(1).max(100),
  failureDescription: z.string().min(1).max(500),
  attemptCount: z.number().int().nonnegative(),
  consentToContact: z.boolean(),
  timeline: z.array(revenueTimelineEventSchema).min(1).max(20),
});
export type RevenueIncidentContext = z.infer<typeof revenueIncidentContextSchema>;

export const revenueProposalSchema = z.object({
  category: revenueFailureCategorySchema,
  confidence: z.number().min(0).max(1),
  diagnosis: z.string().min(1).max(1000),
  evidence: z.array(z.object({ eventId: z.string().min(1).max(200), fact: z.string().min(1).max(500) })).min(1).max(6),
  recommendedAction: revenueProposedActionSchema,
  proposedDelayMinutes: z.number().int().min(0).max(10080).nullable(),
  playbook: z.array(z.object({
    order: z.number().int().min(1).max(5),
    action: revenueProposedActionSchema,
    delayMinutes: z.number().int().min(0).max(10080),
    requiresHuman: z.boolean(),
    rationale: z.string().min(1).max(500),
  })).min(1).max(3),
  riskFlags: z.array(z.enum(['DUPLICATE_RISK', 'CONSENT_REQUIRED', 'HIGH_VALUE', 'AUTHENTICATION_REQUIRED', 'COMPLIANCE_REVIEW'])).max(5),
});
export type RevenueProposal = z.infer<typeof revenueProposalSchema>;

export const revenuePolicyConfigSchema = z.object({
  version: z.string().min(1),
  maxAutomaticAttempts: z.number().int().min(0).max(10).default(2),
  maxAutonomousAmountPaise: z.number().int().positive().default(1_000_000),
  minimumRetryDelayMinutes: z.number().int().min(0).default(30),
  minimumConfidence: z.number().min(0).max(1).default(0.7),
});
export type RevenuePolicyConfig = z.infer<typeof revenuePolicyConfigSchema>;
export type RevenuePolicyResult = { finalAction: 'AUTO_RETRY' | 'APPROVAL_REQUIRED' | 'ESCALATE' | 'STOPPED'; authorized: boolean; delayMinutes: number | null; reasons: string[] };

/** Authorization boundary for inbound revenue recovery. AI proposes a playbook; policy authorizes at most its first bounded action. */
export function evaluateRevenuePolicy(context: RevenueIncidentContext, proposal: RevenueProposal, config: RevenuePolicyConfig): RevenuePolicyResult {
  const evidenceIds = new Set(context.timeline.map(event => event.eventId));
  if (proposal.evidence.some(item => !evidenceIds.has(item.eventId))) return { finalAction: 'STOPPED', authorized: false, delayMinutes: null, reasons: ['REV-01: AI cited evidence outside the persisted timeline'] };
  if (proposal.category === 'DUPLICATE_OR_PROCESSING' || proposal.riskFlags.includes('DUPLICATE_RISK')) return { finalAction: 'STOPPED', authorized: false, delayMinutes: null, reasons: ['REV-02: payment outcome is active, duplicated, or ambiguous'] };
  if (proposal.category === 'FRAUD_OR_COMPLIANCE' || proposal.riskFlags.includes('COMPLIANCE_REVIEW')) return { finalAction: 'ESCALATE', authorized: false, delayMinutes: null, reasons: ['REV-03: compliance or fraud review is mandatory'] };
  if (proposal.category === 'INVALID_PAYMENT_METHOD') return { finalAction: 'ESCALATE', authorized: false, delayMinutes: null, reasons: ['REV-04: payment method must be replaced before another attempt'] };
  if (proposal.category === 'UNKNOWN' || proposal.confidence < config.minimumConfidence || proposal.recommendedAction === 'STOP') return { finalAction: 'STOPPED', authorized: false, delayMinutes: null, reasons: ['REV-05: evidence or confidence is insufficient for an automated action'] };
  if (context.attemptCount >= config.maxAutomaticAttempts) return { finalAction: 'STOPPED', authorized: false, delayMinutes: null, reasons: ['REV-06: automatic-attempt limit reached'] };
  if (['CREATE_PAYMENT_LINK', 'CONTACT_CUSTOMER'].includes(proposal.recommendedAction)) {
    if (!context.consentToContact) return { finalAction: 'STOPPED', authorized: false, delayMinutes: null, reasons: ['REV-07: customer-contact consent is absent'] };
    return { finalAction: 'APPROVAL_REQUIRED', authorized: false, delayMinutes: null, reasons: ['REV-08: customer-facing recovery requires human approval'] };
  }
  if (proposal.recommendedAction === 'ESCALATE' || proposal.category === 'CUSTOMER_AUTHENTICATION') return { finalAction: 'ESCALATE', authorized: false, delayMinutes: null, reasons: ['REV-09: customer authentication or manual intervention is required'] };
  if (context.amountPaise > config.maxAutonomousAmountPaise || proposal.riskFlags.includes('HIGH_VALUE')) return { finalAction: 'APPROVAL_REQUIRED', authorized: false, delayMinutes: null, reasons: ['REV-10: autonomous revenue-action amount cap exceeded'] };
  if (proposal.recommendedAction === 'SMART_RETRY' && ['TRANSIENT_PROVIDER', 'SOFT_DECLINE', 'INSUFFICIENT_FUNDS'].includes(proposal.category)) {
    return { finalAction: 'AUTO_RETRY', authorized: true, delayMinutes: Math.max(config.minimumRetryDelayMinutes, proposal.proposedDelayMinutes ?? 0), reasons: ['REV-11: bounded smart retry authorized from persisted evidence'] };
  }
  return { finalAction: 'ESCALATE', authorized: false, delayMinutes: null, reasons: ['REV-12: no deterministic revenue-recovery path matched'] };
}

export type PolicyResult = { decision: PolicyDecision; reasons: string[]; delayMinutes: number | null };

/** The authorization boundary. This function never trusts a model's recommendation by itself. */
export function evaluatePolicy(incident: Incident, proposal: AiProposal, config: PolicyConfig): PolicyResult {
  const reasons: string[] = [];
  if (incident.status === 'PROCESSING' || proposal.category === 'PROCESSING_AMBIGUITY') return { decision: 'STOPPED', reasons: ['POL-01: payout outcome is processing or ambiguous'], delayMinutes: null };
  if (incident.duplicateSuspected) return { decision: 'STOPPED', reasons: ['POL-07: duplicate or reference conflict suspected'], delayMinutes: null };
  if (proposal.category === 'UNKNOWN' || proposal.recommendedAction === 'STOP') return { decision: 'STOPPED', reasons: ['POL-04: unknown or unsupported failure reason'], delayMinutes: null };
  if (proposal.category === 'INVALID_BENEFICIARY') return { decision: 'ESCALATE', reasons: ['POL-03: beneficiary correction required'], delayMinutes: null };
  if (proposal.category === 'SUCCESSFUL' || proposal.recommendedAction === 'NO_ACTION') return { decision: 'NO_ACTION', reasons: ['Payout is already successful'], delayMinutes: null };
  if (incident.attempts >= config.maxAutoRetryAttempts) return { decision: 'STOPPED', reasons: ['POL-06: retry limit reached'], delayMinutes: null };
  if (proposal.recommendedAction === 'ESCALATE') return { decision: 'ESCALATE', reasons: ['AI proposal requires human review'], delayMinutes: null };
  if (incident.amountPaise > config.maxAutonomousAmountPaise) return { decision: 'APPROVAL_REQUIRED', reasons: ['POL-05: autonomous amount cap exceeded'], delayMinutes: null };
  if (proposal.category === 'TRANSIENT_TECHNICAL' && proposal.recommendedAction === 'RETRY') {
    reasons.push('POL-02: transient technical failure within retry and value limits');
    return { decision: 'AUTO_RETRY', reasons, delayMinutes: Math.max(config.minimumRetryDelayMinutes, proposal.proposedDelayMinutes ?? 0) };
  }
  return { decision: 'ESCALATE', reasons: ['No deterministic automatic-recovery path matched'], delayMinutes: null };
}

export function formatInr(paise: number) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(paise / 100); }
