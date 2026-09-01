import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import { Prisma, RevenueActionOutcome, RevenueIncidentStatus } from '@prisma/client';
import { evaluateRevenuePolicy, revenueIncidentContextSchema, revenueProposalSchema, type RevenueIncidentContext, type RevenuePolicyConfig } from '@recoveryos/domain';
import { AiService } from './ai.service';
import { PrismaService } from './prisma.service';
import { DEFAULT_GROQ_EVALUATION_INTERVAL_MS, evaluationPacingDelayMs, wait } from './provider-rate-limit';
import { findRevenueDemoSeed, REVENUE_DEMO_SCENARIOS, type RevenueDemoScenario } from './revenue-demo-scenarios';

const REVENUE_POLICY: RevenuePolicyConfig = {
  version: 'revenue-v1.0.0', maxAutomaticAttempts: 2, maxAutonomousAmountPaise: 1_000_000,
  minimumRetryDelayMinutes: 30, minimumConfidence: .7,
};

type RevenueListQuery = { page?: number; pageSize?: number; status?: string; search?: string };
type DemoContext = { runId: string; actorId: string; retryDelaySeconds: number; scenario: RevenueDemoScenario };

@Injectable()
export class RevenueRecoveryService implements OnApplicationBootstrap {
  private demoActive = false;
  private lastRevenueAnalysisStartedAt: number | null = null;
  constructor(private readonly prisma: PrismaService, private readonly ai: AiService, @InjectQueue('revenue-recovery') private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    try { await this.recoverPendingActions(); } catch {}
  }

  configuration() {
    const enabled = process.env.ENABLE_REVENUE_DEMO === 'true';
    const simulationSafe = process.env.SIMULATION_MODE !== 'false';
    return {
      enabled, simulationSafe, aiConfigured: this.ai.status().configured,
      ready: enabled && simulationSafe && this.ai.status().configured,
      policy: REVENUE_POLICY,
      scenarios: REVENUE_DEMO_SCENARIOS.map(({ key, title, amountPaise, expectedCategory, expectedPolicyAction }) => ({ key, title, amountPaise, expectedCategory, expectedPolicyAction })),
    };
  }

  async runDemo(actorId = 'operator') {
    const configuration = this.configuration();
    if (!configuration.enabled) throw new ForbiddenException('Inbound revenue demonstration is disabled');
    if (!configuration.simulationSafe) throw new ForbiddenException('Inbound revenue demonstration requires simulation mode');
    if (!configuration.aiConfigured) throw new ServiceUnavailableException('A hosted AI provider is required for the inbound revenue demonstration');
    if (this.demoActive) throw new ConflictException('Another inbound revenue demonstration is already running');
    const runId = `rev_demo_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const retryDelaySeconds = Number.parseInt(process.env.DEMO_RETRY_DELAY_SECONDS || '5', 10);
    const ids: string[] = [];
    const duplicateReplayVerified: Record<string, boolean> = {};
    this.demoActive = true;
    try {
      for (const scenario of REVENUE_DEMO_SCENARIOS) {
        const context = { runId, actorId, retryDelaySeconds, scenario };
        const first = await this.createDemoIncident(context);
        const replay = await this.createDemoIncident(context);
        ids.push(first.incidentId);
        duplicateReplayVerified[scenario.key] = replay.duplicate && replay.incidentId === first.incidentId;
      }
      await this.waitForActions(ids, retryDelaySeconds * 1_000 + 15_000);
      const experiment = await this.createExperiment(`Inbound revenue controlled cohort ${runId}`, ids);
      const incidents = await Promise.all(ids.map(id => this.detail(id)));
      return { runId, retryDelaySeconds, duplicateReplayVerified, experiment, incidents };
    } finally { this.demoActive = false; }
  }

  async ingestPaymentWebhook(externalEventId: string, eventType: string, payload: any) {
    const entity = payload?.payload?.payment?.entity;
    if (!entity?.id) throw new BadRequestException('Payment webhook does not contain a payment id');
    if (eventType === 'payment.captured') {
      const incidentReference = entity?.notes?.recoveryos_incident_id ?? entity?.notes?.original_payment_id;
      const incident = incidentReference
        ? await this.prisma.revenueIncident.findFirst({ where: { OR: [{ id: String(incidentReference) }, { sourcePaymentId: String(incidentReference) }] } })
        : await this.prisma.revenueIncident.findUnique({ where: { sourcePaymentId: String(entity.id) } });
      if (!incident) return { accepted: true, ignored: true, reason: 'No matching revenue incident' };
      return this.recordCapture(incident.id, externalEventId, eventType, entity, false);
    }
    if (eventType !== 'payment.failed') return { accepted: true, ignored: true, reason: 'Payment event is not a failed or captured terminal event' };
    const createdAt = Number(entity.created_at) ? new Date(Number(entity.created_at) * 1_000) : new Date();
    return this.ingestFailure({
      externalEventId, sourcePaymentId: String(entity.id), amountPaise: Number(entity.amount || 0), currency: String(entity.currency || 'INR'),
      customerRef: String(entity.customer_id || entity?.notes?.customer_ref || 'anonymous'), paymentMethod: String(entity.method || 'unknown'),
      failureCode: String(entity.error_code || entity.error_reason || 'UNKNOWN'), failureDescription: String(entity.error_description || entity.error_reason || 'Payment failed without provider detail'),
      consentToContact: entity?.notes?.consent_to_contact === true || entity?.notes?.consent_to_contact === 'true', occurredAt: createdAt,
      eventType, eventSummary: String(entity.error_description || entity.error_reason || 'Provider reported a failed inbound payment'), raw: payload,
    });
  }

  async list(query: RevenueListQuery = {}) {
    const page = Math.max(1, Math.floor(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)));
    const search = query.search?.trim().slice(0, 100);
    const status = Object.values(RevenueIncidentStatus).includes(query.status as RevenueIncidentStatus) ? query.status as RevenueIncidentStatus : undefined;
    const where: Prisma.RevenueIncidentWhereInput = {
      ...(status ? { status } : {}),
      ...(search ? { OR: [{ sourcePaymentId: { contains: search, mode: 'insensitive' } }, { failureCode: { contains: search, mode: 'insensitive' } }, { failureDescription: { contains: search, mode: 'insensitive' } }] } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.revenueIncident.count({ where }),
      this.prisma.revenueIncident.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 }, policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  detail(id: string) {
    return this.prisma.revenueIncident.findUniqueOrThrow({ where: { id }, include: {
      events: { orderBy: { occurredAt: 'asc' } }, analyses: { orderBy: { createdAt: 'asc' } },
      policyDecisions: { orderBy: { createdAt: 'asc' } }, actions: { orderBy: { createdAt: 'asc' } }, auditEvents: { orderBy: { createdAt: 'asc' } },
    } });
  }

  async approve(id: string, actorId = 'operator') {
    const incident = await this.prisma.revenueIncident.findUniqueOrThrow({ where: { id }, include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (incident.status !== RevenueIncidentStatus.APPROVAL_REQUIRED) throw new ConflictException('Only approval-required revenue incidents can be approved');
    const proposal = revenueProposalSchema.parse(incident.analyses[0]?.outputJson);
    await this.prisma.revenueIncident.update({ where: { id }, data: { status: RevenueIncidentStatus.AUTO_ACTION } });
    await this.audit(id, 'REVENUE_HUMAN_APPROVED', 'HUMAN', 'A human approved the bounded first playbook action.', { action: proposal.recommendedAction }, actorId);
    await this.schedule(id, proposal.recommendedAction, 0, { actorId });
    return this.detail(id);
  }

  async reject(id: string, actorId = 'operator') {
    const changed = await this.prisma.revenueIncident.updateMany({ where: { id, status: RevenueIncidentStatus.APPROVAL_REQUIRED }, data: { status: RevenueIncidentStatus.STOPPED } });
    if (!changed.count) throw new ConflictException('Only approval-required revenue incidents can be rejected');
    await this.audit(id, 'REVENUE_HUMAN_REJECTED', 'HUMAN', 'A human rejected the proposed revenue action.', {}, actorId);
    return this.detail(id);
  }

  async executeAction(actionId: string) {
    if (process.env.SIMULATION_MODE === 'false') throw new ForbiddenException('Live inbound payment collection is not implemented');
    const action = await this.prisma.revenueAction.findUniqueOrThrow({ where: { id: actionId }, include: { incident: { include: { events: { orderBy: { occurredAt: 'desc' } } } } } });
    if (action.outcome !== RevenueActionOutcome.PENDING || action.incident.status !== RevenueIncidentStatus.AUTO_ACTION) return { executed: false };
    const source = action.incident.events.find(event => {
      const data = event.dataJson as { simulatedOutcome?: unknown };
      return typeof data?.simulatedOutcome === 'string';
    });
    const data = source?.dataJson as { simulatedOutcome?: unknown; scenarioKey?: unknown } | undefined;
    if (data?.simulatedOutcome !== 'CAPTURED') {
      await this.prisma.$transaction(async db => {
        await db.revenueAction.update({ where: { id: action.id }, data: { outcome: RevenueActionOutcome.BLOCKED, executedAt: new Date(), resultJson: { simulation: true, outcome: 'NO_CAPTURE' } } });
        await db.revenueIncident.update({ where: { id: action.incidentId }, data: { status: RevenueIncidentStatus.STOPPED, attemptCount: { increment: 1 } } });
        await db.revenueAuditEvent.create({ data: { incidentId: action.incidentId, eventType: 'REVENUE_ACTION_BLOCKED', actorType: 'SYSTEM', policyVersion: REVENUE_POLICY.version, rationale: 'The controlled outcome did not permit an attributed capture.', dataJson: { actionId: action.id, scenarioKey: data?.scenarioKey ?? null } } });
      });
      return { executed: true, recovered: false };
    }
    const captureId = `sim_capture_${action.id}`;
    await this.recordCapture(action.incidentId, `evt_${captureId}`, 'payment.captured', { id: captureId, amount: action.incident.amountPaise, currency: action.incident.currency, notes: { recoveryos_incident_id: action.incidentId }, simulation: true }, true, action.id);
    return { executed: true, recovered: true };
  }

  async recoverPendingActions() {
    const actions = await this.prisma.revenueAction.findMany({ where: { outcome: RevenueActionOutcome.PENDING }, include: { incident: true } });
    let requeued = 0;
    for (const action of actions) {
      if (action.incident.status !== RevenueIncidentStatus.AUTO_ACTION) continue;
      await this.enqueue(action.id, action.scheduledFor);
      requeued += 1;
    }
    return { scanned: actions.length, requeued };
  }

  async listExperiments() {
    const rows = await this.prisma.revenueExperiment.findMany({ orderBy: { startedAt: 'desc' }, include: { results: true } });
    return rows.map(row => ({ ...row, baseline: row.baselineJson, metrics: row.metricsJson, immutable: true }));
  }

  async experiment(id: string) {
    const row = await this.prisma.revenueExperiment.findUniqueOrThrow({ where: { id }, include: { results: true } });
    return { ...row, baseline: row.baselineJson, metrics: row.metricsJson, immutable: true };
  }

  private async createDemoIncident(context: DemoContext) {
    const externalEventId = `evt_${context.runId}_${context.scenario.key.toLowerCase()}_failed`;
    const sourcePaymentId = `pay_${context.runId}_${context.scenario.key.toLowerCase()}`;
    return this.ingestFailure({
      externalEventId, sourcePaymentId, amountPaise: context.scenario.amountPaise, currency: 'INR',
      customerRef: `customer_${createHash('sha256').update(`${context.runId}:${context.scenario.key}`).digest('hex').slice(0, 12)}`,
      paymentMethod: context.scenario.paymentMethod, failureCode: context.scenario.failureCode,
      failureDescription: context.scenario.failureDescription, consentToContact: context.scenario.consentToContact,
      occurredAt: new Date(), eventType: 'payment.failed', eventSummary: context.scenario.failureDescription,
      raw: { simulation: true, runId: context.runId, scenarioKey: context.scenario.key, simulatedOutcome: context.scenario.simulatedOutcome, rulesBaselineEligible: context.scenario.rulesBaselineEligible, expectedCategory: context.scenario.expectedCategory, expectedPolicyAction: context.scenario.expectedPolicyAction },
      demoContext: context,
    });
  }

  private async ingestFailure(input: {
    externalEventId: string; sourcePaymentId: string; amountPaise: number; currency: string; customerRef: string; paymentMethod: string;
    failureCode: string; failureDescription: string; consentToContact: boolean; occurredAt: Date; eventType: string; eventSummary: string; raw: unknown; demoContext?: DemoContext;
  }) {
    const existing = await this.prisma.revenueEvent.findUnique({ where: { externalEventId: input.externalEventId } });
    if (existing) return { duplicate: true, incidentId: existing.incidentId };
    const incident = await this.prisma.$transaction(async db => {
      const record = await db.revenueIncident.upsert({
        where: { sourcePaymentId: input.sourcePaymentId },
        update: { status: RevenueIncidentStatus.DETECTED, failureCode: input.failureCode, failureDescription: input.failureDescription },
        create: { sourcePaymentId: input.sourcePaymentId, status: RevenueIncidentStatus.DETECTED, amountPaise: input.amountPaise, currency: input.currency, customerRef: input.customerRef, paymentMethod: input.paymentMethod, failureCode: input.failureCode, failureDescription: input.failureDescription, consentToContact: input.consentToContact, expiresAt: new Date(input.occurredAt.getTime() + 7 * 24 * 60 * 60 * 1_000) },
      });
      if (input.demoContext) {
        for (const [index, prior] of input.demoContext.scenario.priorEvents.entries()) {
          const priorExternalId = `evt_${input.demoContext.runId}_${input.demoContext.scenario.key.toLowerCase()}_prior_${index}`;
          await db.revenueEvent.upsert({ where: { externalEventId: priorExternalId }, update: {}, create: { externalEventId: priorExternalId, incidentId: record.id, eventType: prior.eventType, occurredAt: new Date(input.occurredAt.getTime() - prior.minutesAgo * 60_000), dataJson: { summary: prior.summary, simulation: true, scenarioKey: input.demoContext.scenario.key } } });
        }
      }
      await db.revenueEvent.create({ data: { externalEventId: input.externalEventId, incidentId: record.id, eventType: input.eventType, occurredAt: input.occurredAt, dataJson: this.jsonValue({ summary: input.eventSummary, ...this.safeRaw(input.raw) }) } });
      await db.revenueAuditEvent.create({ data: { incidentId: record.id, eventType: input.demoContext ? 'REVENUE_DEMO_FAILURE_SEEDED' : 'REVENUE_FAILURE_DETECTED', actorType: 'SYSTEM', rationale: input.demoContext ? 'A controlled failed inbound payment was added to the reproducible cohort.' : 'A signed provider webhook reported failed inbound revenue.', dataJson: { externalEventId: input.externalEventId, eventType: input.eventType } } });
      return record;
    });
    await this.analyze(incident.id, input.demoContext);
    return { duplicate: false, incidentId: incident.id };
  }

  private async analyze(incidentId: string, demoContext?: DemoContext) {
    await this.prisma.revenueIncident.update({ where: { id: incidentId }, data: { status: RevenueIncidentStatus.ANALYZING } });
    const incident = await this.prisma.revenueIncident.findUniqueOrThrow({ where: { id: incidentId }, include: { events: { orderBy: { occurredAt: 'asc' } } } });
    const context = revenueIncidentContextSchema.parse({
      incidentId: incident.id, sourcePaymentId: incident.sourcePaymentId, amountPaise: incident.amountPaise, currency: incident.currency,
      paymentMethod: incident.paymentMethod, failureCode: incident.failureCode, failureDescription: incident.failureDescription,
      attemptCount: incident.attemptCount, consentToContact: incident.consentToContact,
      timeline: incident.events.map(event => ({ eventId: event.externalEventId, eventType: event.eventType, occurredAt: event.occurredAt.toISOString(), summary: String((event.dataJson as { summary?: unknown })?.summary || event.eventType) })),
    }) satisfies RevenueIncidentContext;
    await this.paceRevenueAnalysis();
    const analysis = await this.ai.analyzeRevenue(context);
    const proposal = revenueProposalSchema.parse(analysis.proposal);
    const policy = evaluateRevenuePolicy(context, proposal, REVENUE_POLICY);
    const status = policy.finalAction === 'AUTO_RETRY' ? RevenueIncidentStatus.AUTO_ACTION
      : policy.finalAction === 'APPROVAL_REQUIRED' ? RevenueIncidentStatus.APPROVAL_REQUIRED
        : policy.finalAction === 'ESCALATE' ? RevenueIncidentStatus.ESCALATED : RevenueIncidentStatus.STOPPED;
    const timelineDigest = createHash('sha256').update(JSON.stringify(context.timeline)).digest('hex');
    await this.prisma.$transaction(async db => {
      await db.revenueAnalysis.create({ data: { incidentId, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, timelineDigest, outputJson: proposal, confidence: proposal.confidence } });
      await db.revenuePolicyDecision.create({ data: { incidentId, policyVersion: REVENUE_POLICY.version, proposedAction: proposal.recommendedAction, finalAction: policy.finalAction, authorized: policy.authorized, reasonsJson: policy.reasons } });
      await db.revenueIncident.update({ where: { id: incidentId }, data: { status } });
      await db.revenueAuditEvent.create({ data: { incidentId, eventType: 'REVENUE_POLICY_DECISION', actorType: 'POLICY', policyVersion: REVENUE_POLICY.version, rationale: policy.reasons.join('; '), dataJson: this.jsonValue({ proposal, policy, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, timelineDigest }) } });
    });
    if (policy.finalAction === 'AUTO_RETRY') await this.schedule(incidentId, proposal.recommendedAction, policy.delayMinutes ?? REVENUE_POLICY.minimumRetryDelayMinutes, demoContext ? { actorId: demoContext.actorId, retryDelaySeconds: demoContext.retryDelaySeconds } : undefined);
    return policy;
  }

  private async paceRevenueAnalysis() {
    const status = this.ai.status() as { configured?: boolean; provider?: string };
    if (!status.configured || status.provider !== 'groq') return;
    const requested = Number.parseInt(process.env.AI_REVENUE_REQUEST_INTERVAL_MS || String(DEFAULT_GROQ_EVALUATION_INTERVAL_MS), 10);
    const intervalMs = Number.isFinite(requested) && requested >= 0 && requested <= 60_000 ? requested : DEFAULT_GROQ_EVALUATION_INTERVAL_MS;
    await wait(evaluationPacingDelayMs(this.lastRevenueAnalysisStartedAt, Date.now(), intervalMs));
    this.lastRevenueAnalysisStartedAt = Date.now();
  }

  private async schedule(incidentId: string, actionType: string, delayMinutes: number, demo?: { actorId: string; retryDelaySeconds?: number }) {
    const incident = await this.prisma.revenueIncident.findUniqueOrThrow({ where: { id: incidentId } });
    const idempotencyKey = createHash('sha256').update(`revenue:${incident.id}:${incident.attemptCount + 1}:${actionType}`).digest('hex').slice(0, 40);
    const scheduledFor = new Date(Date.now() + (demo?.retryDelaySeconds !== undefined ? demo.retryDelaySeconds * 1_000 : delayMinutes * 60_000));
    const action = await this.prisma.revenueAction.upsert({ where: { idempotencyKey }, update: {}, create: { incidentId, actionType, idempotencyKey, scheduledFor } });
    await this.enqueue(action.id, scheduledFor);
    await this.audit(incidentId, 'REVENUE_ACTION_REQUESTED', 'SYSTEM', 'The policy-authorized first playbook action was durably scheduled.', { actionId: action.id, actionType, policyDelayMinutes: delayMinutes, effectiveDemoDelaySeconds: demo?.retryDelaySeconds ?? null }, demo?.actorId);
    return action;
  }

  private enqueue(actionId: string, scheduledFor: Date) {
    return this.queue.add('execute-revenue-action', { actionId }, { jobId: actionId, delay: Math.max(0, scheduledFor.getTime() - Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 }, removeOnFail: { age: 30 * 24 * 60 * 60, count: 1000 } });
  }

  private async recordCapture(incidentId: string, externalEventId: string, eventType: string, entity: any, simulation: boolean, actionId?: string) {
    const existing = await this.prisma.revenueEvent.findUnique({ where: { externalEventId } });
    if (existing) return { duplicate: true, incidentId };
    await this.prisma.$transaction(async db => {
      const incident = await db.revenueIncident.findUniqueOrThrow({ where: { id: incidentId } });
      await db.revenueEvent.create({ data: { externalEventId, incidentId, eventType, occurredAt: new Date(), dataJson: this.jsonValue({ summary: simulation ? 'Controlled recovery payment captured after the policy-authorized action.' : 'Provider confirmed that the recovery payment was captured.', paymentStatus: 'captured', simulation }) } });
      await db.revenueIncident.update({ where: { id: incidentId }, data: { status: RevenueIncidentStatus.RECOVERED, recoveredAt: new Date(), attemptCount: { increment: 1 } } });
      const action = actionId ? await db.revenueAction.findUnique({ where: { id: actionId } }) : await db.revenueAction.findFirst({ where: { incidentId, outcome: RevenueActionOutcome.PENDING }, orderBy: { createdAt: 'desc' } });
      if (action) await db.revenueAction.update({ where: { id: action.id }, data: { outcome: RevenueActionOutcome.SUCCEEDED, executedAt: new Date(), attributedRevenuePaise: incident.amountPaise, resultJson: this.jsonValue({ providerPaymentStatus: 'captured', providerPaymentIdHash: createHash('sha256').update(String(entity?.id || externalEventId)).digest('hex'), simulation }) } });
      await db.revenueAuditEvent.create({ data: { incidentId, eventType: 'REVENUE_ATTRIBUTED', actorType: 'SYSTEM', policyVersion: REVENUE_POLICY.version, rationale: 'Captured revenue was attributed to the bounded recovery action through the persisted incident reference.', dataJson: { externalEventId, actionId: action?.id ?? null, amountPaise: incident.amountPaise, simulation } } });
    });
    return { duplicate: false, incidentId, recovered: true };
  }

  private async waitForActions(incidentIds: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = await this.prisma.revenueAction.count({ where: { incidentId: { in: incidentIds }, outcome: RevenueActionOutcome.PENDING } });
      if (!pending) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new ServiceUnavailableException('Revenue demonstration actions did not settle before the evidence snapshot deadline');
  }

  private async createExperiment(name: string, incidentIds: string[]) {
    const incidents = await this.prisma.revenueIncident.findMany({ where: { id: { in: incidentIds } }, include: {
      events: { orderBy: { occurredAt: 'asc' } }, analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
      policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 }, actions: true, auditEvents: true,
    } });
    const results = incidents.map(incident => {
      const analysis = incident.analyses[0]; const decision = incident.policyDecisions[0];
      const seedData = findRevenueDemoSeed(incident.events);
      const snapshot = {
        incident: { id: incident.id, sourcePaymentId: incident.sourcePaymentId, status: incident.status, amountPaise: incident.amountPaise, currency: incident.currency, paymentMethod: incident.paymentMethod, failureCode: incident.failureCode, failureDescription: incident.failureDescription, consentToContact: incident.consentToContact, attemptCount: incident.attemptCount, detectedAt: incident.detectedAt.toISOString(), recoveredAt: incident.recoveredAt?.toISOString() ?? null },
        scenarioKey: seedData?.scenarioKey ?? null,
        rulesBaselineEligible: seedData?.rulesBaselineEligible === true,
        expectedCategory: seedData?.expectedCategory ?? null,
        expectedPolicyAction: seedData?.expectedPolicyAction ?? null,
        analysis: analysis ? { modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, timelineDigest: analysis.timelineDigest, outputJson: analysis.outputJson, confidence: analysis.confidence } : null,
        policyDecision: decision ? { policyVersion: decision.policyVersion, proposedAction: decision.proposedAction, finalAction: decision.finalAction, authorized: decision.authorized, reasonsJson: decision.reasonsJson } : null,
        actionOutcomes: incident.actions.map(action => ({ actionType: action.actionType, outcome: action.outcome, attributedRevenuePaise: action.attributedRevenuePaise })),
      };
      return {
        incidentId: incident.id, finalState: incident.status, recoveredValuePaise: incident.status === RevenueIncidentStatus.RECOVERED ? incident.amountPaise : 0,
        interventionCount: incident.auditEvents.filter(event => ['REVENUE_HUMAN_APPROVED', 'REVENUE_HUMAN_REJECTED'].includes(event.eventType)).length,
        unsafeActionsPrevented: !decision?.authorized && ([RevenueIncidentStatus.STOPPED, RevenueIncidentStatus.ESCALATED] as RevenueIncidentStatus[]).includes(incident.status) ? 1 : 0,
        snapshot,
      };
    });
    const totalValueAtRiskPaise = incidents.reduce((sum, incident) => sum + incident.amountPaise, 0);
    const recoveredValuePaise = results.reduce((sum, result) => sum + result.recoveredValuePaise, 0);
    const rulesOnlyRecoveredValuePaise = results.filter(result => result.snapshot.rulesBaselineEligible).reduce((sum, result) => sum + result.recoveredValuePaise, 0);
    const metrics = {
      valueAtRiskPaise: totalValueAtRiskPaise, recoveredValuePaise, recoveryRate: totalValueAtRiskPaise ? recoveredValuePaise / totalValueAtRiskPaise : 0,
      recoveredIncidentCount: results.filter(result => result.finalState === RevenueIncidentStatus.RECOVERED).length,
      manualReviewRequired: results.filter(result => ([RevenueIncidentStatus.APPROVAL_REQUIRED, RevenueIncidentStatus.ESCALATED] as RevenueIncidentStatus[]).includes(result.finalState)).length,
      interventions: results.reduce((sum, result) => sum + result.interventionCount, 0),
      unsafeActionsPrevented: results.reduce((sum, result) => sum + result.unsafeActionsPrevented, 0),
      statusDistribution: results.reduce<Record<string, number>>((acc, result) => { acc[result.finalState] = (acc[result.finalState] || 0) + 1; return acc; }, {}),
      evidenceCompleteness: results.every(result => Boolean(result.snapshot.analysis?.timelineDigest && result.snapshot.policyDecision?.policyVersion)) ? 1 : 0,
    };
    const baseline = {
      controlledExperiment: true,
      disclaimer: 'Synthetic outcomes declared before execution; these measure system behavior, not production causal lift.',
      noAction: { recoveredValuePaise: 0, recoveryRate: 0 },
      rulesOnly: { definition: 'Conservative keyword rule authorizes only explicit transient gateway/provider failures within the amount cap.', recoveredValuePaise: rulesOnlyRecoveredValuePaise, recoveryRate: totalValueAtRiskPaise ? rulesOnlyRecoveredValuePaise / totalValueAtRiskPaise : 0 },
      aiPolicy: { recoveredValuePaise, recoveryRate: totalValueAtRiskPaise ? recoveredValuePaise / totalValueAtRiskPaise : 0, incrementalVsRulesPaise: Math.max(0, recoveredValuePaise - rulesOnlyRecoveredValuePaise) },
    };
    const modelRefs = [...new Set(results.map(result => result.snapshot.analysis?.modelRef).filter((value): value is string => Boolean(value)))];
    const promptVersions = [...new Set(results.map(result => result.snapshot.analysis?.promptVersion).filter((value): value is string => Boolean(value)))];
    const fingerprintInput = results.map(result => ({ scenarioKey: result.snapshot.scenarioKey, amountPaise: result.snapshot.incident.amountPaise, paymentMethod: result.snapshot.incident.paymentMethod, failureCode: result.snapshot.incident.failureCode, failureDescription: result.snapshot.incident.failureDescription, consentToContact: result.snapshot.incident.consentToContact })).sort((a, b) => String(a.scenarioKey).localeCompare(String(b.scenarioKey)));
    const cohortFingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
    const completedAt = new Date();
    const experiment = await this.prisma.$transaction(async db => {
      const created = await db.revenueExperiment.create({ data: { name, cohortSize: results.length, totalValueAtRiskPaise, policyVersion: REVENUE_POLICY.version, modelRef: modelRefs.length === 1 ? modelRefs[0] : 'mixed', promptVersion: promptVersions.length === 1 ? promptVersions[0] : 'mixed', cohortFingerprint, baselineJson: this.jsonValue(baseline), metricsJson: this.jsonValue(metrics), completedAt } });
      await db.revenueExperimentResult.createMany({ data: results.map(result => ({ experimentId: created.id, incidentId: result.incidentId, finalState: result.finalState, recoveredValuePaise: result.recoveredValuePaise, interventionCount: result.interventionCount, unsafeActionsPrevented: result.unsafeActionsPrevented, snapshotJson: this.jsonValue(result.snapshot) })) });
      return created;
    });
    return this.experiment(experiment.id);
  }

  private audit(incidentId: string, eventType: string, actorType: string, rationale: string, data: unknown, actorId?: string) {
    return this.prisma.revenueAuditEvent.create({ data: { incidentId, eventType, actorType, actorId, policyVersion: REVENUE_POLICY.version, rationale, dataJson: this.jsonValue(data) } });
  }

  private safeRaw(raw: unknown) {
    if (!raw || typeof raw !== 'object') return { source: 'provider' };
    const value = raw as Record<string, unknown>;
    return {
      simulation: value.simulation === true,
      runId: typeof value.runId === 'string' ? value.runId : undefined,
      scenarioKey: typeof value.scenarioKey === 'string' ? value.scenarioKey : undefined,
      simulatedOutcome: value.simulatedOutcome === 'CAPTURED' ? 'CAPTURED' : value.simulatedOutcome === 'NOT_ACTIONABLE' ? 'NOT_ACTIONABLE' : undefined,
      rulesBaselineEligible: value.rulesBaselineEligible === true,
      expectedCategory: typeof value.expectedCategory === 'string' ? value.expectedCategory : undefined,
      expectedPolicyAction: typeof value.expectedPolicyAction === 'string' ? value.expectedPolicyAction : undefined,
    };
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue; }
}
