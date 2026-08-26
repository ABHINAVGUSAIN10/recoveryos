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
