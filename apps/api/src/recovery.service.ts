import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import { Decision, ExecutionOutcome, IncidentStatus, Prisma, ReviewStatus } from '@prisma/client';
import { aiProposalSchema, evaluatePolicy, incidentSchema, policyConfigSchema, type Incident, type PolicyConfig } from '@recoveryos/domain';
import { PrismaService } from './prisma.service';
import { AiService } from './ai.service';
import { incidentIdFromRecoveryReference, RazorpayExecutionUncertainError, RazorpayService, recoveryIdempotencyKey } from './razorpay.service';
import { safeErrorMessage } from './redaction';
import { DEMO_SCENARIOS, demoScenarioSchema } from './demo-scenarios';

const DEFAULT_POLICY: PolicyConfig = { version: 'v1.0.0', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 };
type BatchWithIncidents = Prisma.BatchRunGetPayload<{ include: { results: { include: { incident: { include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 }, policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 } } } } } } }>;
type IncidentListQuery = { page?: number; pageSize?: number; search?: string; status?: string; reviewRequired?: boolean };
type DemoAnalysisContext = { runId: string; actorId: string; retryDelaySeconds: number };
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);
  private demoRunActive = false;
  constructor(private readonly prisma: PrismaService, private readonly ai: AiService, private readonly razorpay: RazorpayService, @InjectQueue('recovery') private readonly queue: Queue) {}
  async onApplicationBootstrap() {
    try {
      const summary = await this.recoverPendingExecutions();
      this.logger.log(JSON.stringify({ event: 'pending_execution_recovery', ...summary }));
    }
    catch (error) { this.logger.warn(`Pending execution recovery deferred: ${safeErrorMessage(error)}`); }
  }
  async health() { return { status: 'ok', simulationMode: process.env.SIMULATION_MODE !== 'false', authMode: process.env.AUTH_MODE || 'disabled', timestamp: new Date().toISOString() }; }
  async readiness() {
    const services = await this.serviceStatus();
    return { status: services.database && services.redis ? 'ready' : 'degraded', services, timestamp: new Date().toISOString() };
  }
  async operations() {
    const services = await this.serviceStatus();
    const emptyCounts = { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0, paused: 0 };
    let queue = emptyCounts;
    if (services.redis) {
      try { queue = { ...emptyCounts, ...(await this.withTimeout(this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'), 5_000)) }; }
      catch { services.redis = false; }
    }
    const ai = this.ai.status();
    const demoEnabled = process.env.ENABLE_LIVE_DEMO === 'true';
    const simulationMode = process.env.SIMULATION_MODE !== 'false';
    return {
      status: services.database && services.redis ? 'ready' : 'degraded',
      simulationMode, services, queue, ai,
      demo: {
        enabled: demoEnabled,
        ready: demoEnabled && simulationMode && services.database && services.redis && ai.configured,
        retryDelaySeconds: Number.parseInt(process.env.DEMO_RETRY_DELAY_SECONDS || '5', 10),
        scenarios: DEMO_SCENARIOS.map(({ key, title, description, amountPaise, expectedAiAction, expectedPolicyDecision, humanRequired }) => ({ key, title, description, amountPaise, expectedAiAction, expectedPolicyDecision, humanRequired })),
      },
      timestamp: new Date().toISOString(),
    };
  }

  async runLiveDemo(scenarioInput: string, actorId = 'operator') {
    if (process.env.ENABLE_LIVE_DEMO !== 'true') throw new ForbiddenException('Live demonstration mode is disabled');
    if (process.env.SIMULATION_MODE === 'false') throw new ForbiddenException('Live demonstrations require simulation mode');
    if (!this.ai.status().configured) throw new ServiceUnavailableException('A hosted AI provider must be configured for the live demonstration');
    const parsed = demoScenarioSchema.safeParse(scenarioInput);
    if (!parsed.success) throw new BadRequestException('Unknown live demonstration scenario');
    if (this.demoRunActive) throw new ConflictException('Another live demonstration is already running');

    const selected = parsed.data === 'ALL' ? DEMO_SCENARIOS : DEMO_SCENARIOS.filter(item => item.key === parsed.data);
    const runId = `demo_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const retryDelaySeconds = Number.parseInt(process.env.DEMO_RETRY_DELAY_SECONDS || '5', 10);
    const incidentIds: string[] = [];
    const duplicateReplayVerified: Record<string, boolean> = {};
    this.demoRunActive = true;
    try {
      for (const scenario of selected) {
        const eventId = `evt_${runId}_${scenario.key.toLowerCase()}`;
        const eventType = scenario.providerStatus === 'processing' ? 'payout.initiated' : 'payout.failed';
        const payoutId = `pout_${runId}_${scenario.key.toLowerCase()}`;
        const payload = {
          event_id: eventId,
          event: eventType,
          payload: { payout: { entity: {
            id: payoutId,
            amount: scenario.amountPaise,
            currency: 'INR',
            status: scenario.providerStatus,
            reference_id: `recoveryos-${runId}`,
            status_details: { description: scenario.reason },
            notes: { recoveryos_demo_run: runId, recoveryos_demo_scenario: scenario.key },
          } } },
        };
        const context: DemoAnalysisContext = { runId, actorId, retryDelaySeconds };
        const first = await this.ingestWebhook(eventId, eventType, payload, context);
        const replay = await this.ingestWebhook(eventId, eventType, payload);
        if (!first.incidentId) throw new Error(`Demo scenario ${scenario.key} did not create an incident`);
        incidentIds.push(first.incidentId);
        duplicateReplayVerified[scenario.key] = replay.duplicate && replay.incidentId === first.incidentId;
      }

      const batch = await this.createBatch(`Live AI Demo ${runId}`, incidentIds);
      const incidents = await Promise.all(incidentIds.map(id => this.incidentDetail(id)));
      return { runId, scenario: parsed.data, retryDelaySeconds, duplicateReplayVerified, batch, incidents };
    } finally {
      this.demoRunActive = false;
    }
  }
  async recoverPendingExecutions() {
    const executions = await this.prisma.actionExecution.findMany({ where: { outcome: ExecutionOutcome.PENDING }, include: { incident: true } });
    let requeued = 0; let uncertain = 0; let ignored = 0;
    for (const execution of executions) {
      if (execution.incident.status === IncidentStatus.EXECUTING) {
        await this.recordExecutionResult(execution.id, ExecutionOutcome.UNKNOWN, { error: 'Worker restarted while execution was in progress; provider reconciliation is required.' });
        uncertain += 1;
        continue;
      }
      if (execution.incident.status !== IncidentStatus.AUTO_RETRY) { ignored += 1; continue; }
      const existingJob = await this.queue.getJob(execution.id);
      if (existingJob) {
        const state = await existingJob.getState();
        if (state !== 'completed' && state !== 'failed') continue;
        await existingJob.remove();
      }
      await this.enqueueExecution(execution.id, execution.scheduledFor);
      await this.prisma.auditEvent.create({ data: { incidentId: execution.incidentId, eventType: 'ACTION_REQUEUED', actorType: 'SYSTEM', rationale: 'Pending durable action intent restored after worker startup.', dataJson: { executionId: execution.id } } });
      requeued += 1;
    }
    return { scanned: executions.length, requeued, uncertain, ignored };
  }
  async getPolicy(): Promise<PolicyConfig> {
    const stored = await this.prisma.policyConfig.findFirst({ where: { active: true }, orderBy: { effectiveAt: 'desc' } });
    return stored ? policyConfigSchema.parse(stored.rulesJson) : DEFAULT_POLICY;
  }
  async updatePolicy(config: PolicyConfig, actorId = 'admin') {
    const parsed = policyConfigSchema.parse(config);
    await this.prisma.$transaction(async db => { await db.policyConfig.updateMany({ where: { active: true }, data: { active: false } }); await db.policyConfig.upsert({ where: { version: parsed.version }, update: { rulesJson: parsed, active: true, createdBy: actorId }, create: { version: parsed.version, rulesJson: parsed, createdBy: actorId } }); });
    return parsed;
  }
  async ingestWebhook(externalEventId: string, eventType: string, payload: any, demoContext?: DemoAnalysisContext) {
    const existing = await this.prisma.payoutEvent.findUnique({ where: { externalEventId } });
    if (existing) return { duplicate: true, incidentId: existing.payoutIncidentId };
    const entity = payload?.payload?.payout?.entity ?? payload?.payout ?? payload;
    const payoutId = entity?.id ?? entity?.payout_id;
    if (!payoutId) throw new Error('Webhook payload does not contain payout id');
    const providerStatus = String(entity.status ?? 'failed').toUpperCase();
    const status = this.incidentStatusFromProvider(providerStatus);
    const amountPaise = Number(entity.amount ?? 0); const reason = entity?.status_details?.description ?? entity?.status_details?.reason ?? entity?.failure_reason ?? null;
    const recoveryIncidentId = incidentIdFromRecoveryReference(entity?.reference_id);
    let result;
    try {
      result = await this.prisma.$transaction(async db => {
        const recoveryExecutions = recoveryIncidentId
          ? await db.actionExecution.findMany({ where: { incidentId: recoveryIncidentId }, orderBy: { createdAt: 'desc' }, take: 10 })
          : [];
        const recoveryExecution = recoveryExecutions.find(execution => {
          const response = execution.responseJson as { id?: unknown } | null;
          return response?.id === payoutId;
        }) ?? recoveryExecutions.find(execution => {
          const response = execution.responseJson as { id?: unknown } | null;
          return execution.outcome === ExecutionOutcome.UNKNOWN && typeof response?.id !== 'string';
        }) ?? null;
        const linkedRecovery = Boolean(recoveryIncidentId && recoveryExecution);
        const incident = linkedRecovery
          ? await db.payoutIncident.update({ where: { id: recoveryIncidentId! }, data: { status, currentReason: reason, amountPaise: amountPaise || undefined } })
          : await db.payoutIncident.upsert({ where: { razorpayPayoutId: payoutId }, update: { status, currentReason: reason, amountPaise: amountPaise || undefined }, create: { razorpayPayoutId: payoutId, status, amountPaise, currency: entity.currency ?? 'INR', currentReason: reason, beneficiaryRef: entity.reference_id ?? null } });
        if (linkedRecovery && recoveryExecution) {
          const terminalOutcome = status === IncidentStatus.RECOVERED
            ? ExecutionOutcome.SUCCEEDED
            : status === IncidentStatus.FAILED || status === IncidentStatus.REVERSED
              ? ExecutionOutcome.FAILED
              : null;
          await db.actionExecution.update({
            where: { id: recoveryExecution.id },
            data: { responseJson: entity, ...(terminalOutcome ? { outcome: terminalOutcome } : {}) },
          });
        }
        const event = await db.payoutEvent.create({ data: { externalEventId, eventType, payloadJson: payload, payoutIncidentId: incident.id } });
        await this.audit(db, incident.id, 'WEBHOOK_RECEIVED', 'SYSTEM', `Provider event ${eventType} persisted`, { externalEventId, eventId: event.id });
        if (demoContext) await this.audit(db, incident.id, 'DEMO_SCENARIO_STARTED', 'HUMAN', `Live demonstration ${demoContext.runId} started by ${demoContext.actorId}`, { runId: demoContext.runId }, undefined, undefined, demoContext.actorId);
        return { incident, linkedRecovery };
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const duplicate = await this.prisma.payoutEvent.findUnique({ where: { externalEventId } });
        if (duplicate) return { duplicate: true, incidentId: duplicate.payoutIncidentId };
      }
      throw error;
    }
    if (result.incident.status !== IncidentStatus.RECOVERED && !(result.linkedRecovery && result.incident.status === IncidentStatus.PROCESSING)) await this.analyze(result.incident.id, demoContext);
    return { duplicate: false, incidentId: result.incident.id };
  }
  async analyze(incidentId: string, demoContext?: DemoAnalysisContext) {
    const record = await this.prisma.payoutIncident.findUniqueOrThrow({ where: { id: incidentId } });
    const incident = incidentSchema.parse({ id: record.id, razorpayPayoutId: record.razorpayPayoutId, status: record.status, amountPaise: record.amountPaise, currency: record.currency, reason: record.currentReason, beneficiaryRef: record.beneficiaryRef, attempts: record.attempts, duplicateSuspected: record.duplicateSuspected, policyVersion: (await this.getPolicy()).version });
    const [analysis, config] = await Promise.all([this.ai.classify(incident), this.getPolicy()]);
    const proposal = aiProposalSchema.parse(analysis.proposal); const result = evaluatePolicy(incident, proposal, config);
    await this.prisma.$transaction(async db => {
      await db.aiAnalysis.create({ data: { incidentId, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, outputJson: proposal, confidence: proposal.confidence } });
      await db.policyDecision.create({ data: { incidentId, policyVersion: config.version, proposedAction: proposal.recommendedAction, finalDecision: result.decision as Decision, reasonsJson: result.reasons } });
      // A processing payout has an ambiguous external outcome. Keep that state visible so
      // reconciliation, rather than a new payout request, is the only possible next step.
      const status = record.status === IncidentStatus.PROCESSING ? IncidentStatus.PROCESSING : result.decision as IncidentStatus;
      await db.payoutIncident.update({ where: { id: incidentId }, data: { status } });
      await this.audit(db, incidentId, 'POLICY_DECISION', 'POLICY', result.reasons.join('; '), { proposal, result }, config.version, result.decision);
      if (result.decision === 'ESCALATE' || result.decision === 'APPROVAL_REQUIRED') await db.reviewTask.create({ data: { incidentId, severity: incident.amountPaise > config.maxAutonomousAmountPaise ? 'HIGH' : 'MEDIUM' } });
    });
    if (result.decision === 'AUTO_RETRY') await this.scheduleRetry(incidentId, result.delayMinutes ?? config.minimumRetryDelayMinutes, demoContext);
    return result;
  }
  private async scheduleRetry(incidentId: string, delayMinutes: number, demoContext?: DemoAnalysisContext) {
    const incident = await this.prisma.payoutIncident.findUniqueOrThrow({ where: { id: incidentId } });
    const key = recoveryIdempotencyKey(incident.id, incident.attempts + 1);
    const scheduledFor = new Date(Date.now() + (demoContext ? demoContext.retryDelaySeconds * 1_000 : delayMinutes * 60_000));
    const execution = await this.prisma.actionExecution.upsert({ where: { idempotencyKey: key }, update: {}, create: { incidentId, actionType: 'RETRY_PAYOUT', idempotencyKey: key, requestHash: createHash('sha256').update(`${incident.razorpayPayoutId}:${key}`).digest('hex'), scheduledFor } });
    await this.enqueueExecution(execution.id, execution.scheduledFor);
    const rationale = demoContext
      ? `Policy delay ${delayMinutes} minutes compressed to ${demoContext.retryDelaySeconds} seconds for simulation demo ${demoContext.runId}`
      : `Retry scheduled in ${delayMinutes} minutes`;
    await this.prisma.auditEvent.create({ data: { incidentId, eventType: 'ACTION_REQUESTED', actorType: 'SYSTEM', rationale, dataJson: { executionId: execution.id, idempotencyKey: key, policyDelayMinutes: delayMinutes, effectiveDelaySeconds: demoContext?.retryDelaySeconds, demoRunId: demoContext?.runId } } });
  }
  private async enqueueExecution(executionId: string, scheduledFor: Date) {
    const delay = Math.max(0, scheduledFor.getTime() - Date.now());
    await this.queue.add('execute-retry', { executionId }, {
      jobId: executionId,
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
    });
  }
  async decideReview(incidentId: string, approved: boolean, actorId = 'operator') {
    const task = await this.prisma.reviewTask.findFirst({ where: { incidentId, status: ReviewStatus.OPEN }, orderBy: { createdAt: 'desc' } }); if (!task) throw new Error('No open review task');
    await this.prisma.$transaction(async db => { await db.reviewTask.update({ where: { id: task.id }, data: { status: approved ? ReviewStatus.APPROVED : ReviewStatus.REJECTED, decision: approved ? 'APPROVE' : 'REJECT', decidedAt: new Date(), actorId } }); await db.payoutIncident.update({ where: { id: incidentId }, data: { status: approved ? IncidentStatus.AUTO_RETRY : IncidentStatus.STOPPED } }); await this.audit(db, incidentId, approved ? 'HUMAN_APPROVED' : 'HUMAN_REJECTED', 'HUMAN', `Review task ${approved ? 'approved' : 'rejected'} by ${actorId}`, { reviewTaskId: task.id }, undefined, approved ? 'AUTO_RETRY' : 'STOPPED', actorId); });
    if (approved) await this.scheduleRetry(incidentId, 0);
  }
  async listIncidents(query: IncidentListQuery = {}) {
    const page = Math.max(1, Math.floor(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)));
    const search = query.search?.trim().slice(0, 100);
    const status = Object.values(IncidentStatus).includes(query.status as IncidentStatus) ? query.status as IncidentStatus : undefined;
    const where: Prisma.PayoutIncidentWhereInput = {
      ...(status ? { status } : {}),
      ...(search ? { OR: [{ razorpayPayoutId: { contains: search, mode: 'insensitive' } }, { currentReason: { contains: search, mode: 'insensitive' } }] } : {}),
      ...(query.reviewRequired ? { reviewTasks: { some: { status: ReviewStatus.OPEN } } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.payoutIncident.count({ where }),
      this.prisma.payoutIncident.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { reviewTasks: { where: { status: ReviewStatus.OPEN } }, policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
    ]);
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async incidentDetail(id: string) { return this.prisma.payoutIncident.findUniqueOrThrow({ where: { id }, include: { events: true, analyses: { orderBy: { createdAt: 'asc' } }, policyDecisions: { orderBy: { createdAt: 'asc' } }, executions: true, reviewTasks: true, auditEvents: { orderBy: { createdAt: 'asc' } } } }); }
  async reconcileOpen() {
    const open = await this.prisma.payoutIncident.findMany({
      where: { status: { in: [IncidentStatus.PROCESSING, IncidentStatus.EXECUTION_UNKNOWN] } },
      include: { executions: { where: { outcome: ExecutionOutcome.UNKNOWN }, orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    let reconciled = 0;
    let pending = 0;
    let failures = 0;

    for (const incident of open) {
      try {
        const execution = incident.status === IncidentStatus.EXECUTION_UNKNOWN ? incident.executions[0] : undefined;
        const previousResponse = execution?.responseJson as { id?: unknown } | null | undefined;
        const recoveryPayoutId = typeof previousResponse?.id === 'string' ? previousResponse.id : null;
        const providerPayout = execution
          ? recoveryPayoutId
            ? await this.razorpay.fetchPayout(recoveryPayoutId)
            : await this.razorpay.executeRecovery(execution.idempotencyKey, incident.razorpayPayoutId, incident.id)
          : await this.razorpay.fetchPayout(incident.razorpayPayoutId);
        const providerStatus = String(providerPayout?.status ?? '').toUpperCase();
        const status = this.incidentStatusFromProvider(providerStatus, IncidentStatus.EXECUTION_UNKNOWN);
        const providerJson = this.jsonValue(providerPayout);

        if (status === IncidentStatus.PROCESSING || status === IncidentStatus.EXECUTION_UNKNOWN) {
          pending += 1;
          if (execution) await this.prisma.actionExecution.update({ where: { id: execution.id }, data: { responseJson: providerJson } });
          await this.prisma.auditEvent.create({ data: { incidentId: incident.id, eventType: 'RECONCILIATION_PENDING', actorType: 'SYSTEM', rationale: 'Provider has not confirmed a terminal payout outcome.', dataJson: this.jsonValue({ providerPayout, providerStatus }) } });
          continue;
        }

        const executionOutcome = status === IncidentStatus.RECOVERED ? ExecutionOutcome.SUCCEEDED : ExecutionOutcome.FAILED;
        await this.prisma.$transaction(async db => {
          await db.payoutIncident.update({ where: { id: incident.id }, data: { status } });
          if (execution) await db.actionExecution.update({ where: { id: execution.id }, data: { outcome: executionOutcome, responseJson: providerJson } });
          else await db.actionExecution.updateMany({ where: { incidentId: incident.id, outcome: ExecutionOutcome.UNKNOWN }, data: { outcome: executionOutcome, responseJson: providerJson } });
          await this.audit(db, incident.id, 'RECONCILIATION_COMPLETED', 'SYSTEM', `Provider confirmed payout status ${providerStatus}`, { providerPayout, providerStatus }, undefined, status);
        });
        reconciled += 1;
      } catch (error) {
        const message = safeErrorMessage(error, 'Unknown reconciliation failure');
        if (error instanceof RazorpayExecutionUncertainError) {
          pending += 1;
          await this.prisma.auditEvent.create({ data: { incidentId: incident.id, eventType: 'RECONCILIATION_PENDING', actorType: 'SYSTEM', rationale: 'Provider outcome is still uncertain; execution remains blocked.', dataJson: { error: message } } });
        } else {
          failures += 1;
          await this.prisma.auditEvent.create({ data: { incidentId: incident.id, eventType: 'RECONCILIATION_FAILED', actorType: 'SYSTEM', rationale: 'Provider lookup failed; execution remains blocked.', dataJson: { error: message } } });
        }
      }
    }
    return { scanned: open.length, reconciled, pending, failures };
  }
  async createBatch(name: string, incidentIds: string[]) { const incidents = await this.prisma.payoutIncident.findMany({ where: { id: { in: incidentIds } } }); const batch = await this.prisma.batchRun.create({ data: { name, cohortSize: incidents.length, totalValueAtRiskPaise: incidents.reduce((sum, item) => sum + item.amountPaise, 0) } }); await this.prisma.batchResult.createMany({ data: incidents.map(i => ({ batchRunId: batch.id, incidentId: i.id, finalState: i.status, recoveredValuePaise: i.status === IncidentStatus.RECOVERED ? i.amountPaise : 0 })) }); return this.batchResults(batch.id); }
  async listBatches() {
    const batches = await this.prisma.batchRun.findMany({ orderBy: { startedAt: 'desc' }, include: { results: { include: { incident: { include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 }, policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 } } } } } } });
    return batches.map(batch => this.toBatchView(batch));
  }
  async batchResults(id: string) {
    const batch = await this.prisma.batchRun.findUniqueOrThrow({ where: { id }, include: { results: { include: { incident: { include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 }, policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 } } } } } } });
    return this.toBatchView(batch);
  }
  async batchExportCsv(id: string) {
    const batch = await this.batchResults(id);
    const header = ['incident_id', 'razorpay_payout_id', 'amount_paise', 'currency', 'final_state', 'recovered_value_paise', 'attempts', 'reason', 'updated_at'];
    const rows = batch.results.map(result => [result.incidentId, result.incident.razorpayPayoutId, result.incident.amountPaise, result.incident.currency, result.finalState, result.recoveredValuePaise, result.incident.attempts, result.incident.currentReason ?? '', result.incident.updatedAt.toISOString()]);
    return [header, ...rows].map(row => row.map(value => this.csvValue(value)).join(',')).join('\n');
  }
  async recordExecutionResult(executionId: string, outcome: ExecutionOutcome, response: unknown) {
    return this.prisma.$transaction(async db => {
      const execution = await db.actionExecution.findUniqueOrThrow({ where: { id: executionId } });
      const responseJson = this.jsonValue(response);
      const claimed = await db.actionExecution.updateMany({ where: { id: executionId, outcome: ExecutionOutcome.PENDING }, data: { outcome, responseJson } });
      if (!claimed.count) return { recorded: false, incidentId: execution.incidentId };
      if (outcome === ExecutionOutcome.SUCCEEDED) {
        await db.payoutIncident.update({ where: { id: execution.incidentId }, data: { status: IncidentStatus.RECOVERED, attempts: { increment: 1 } } });
      } else {
        await db.payoutIncident.update({ where: { id: execution.incidentId }, data: { attempts: { increment: 1 } } });
        await db.payoutIncident.updateMany({
          where: outcome === ExecutionOutcome.UNKNOWN
            ? { id: execution.incidentId, status: IncidentStatus.EXECUTING }
            : { id: execution.incidentId, status: { not: IncidentStatus.RECOVERED } },
          data: { status: outcome === ExecutionOutcome.UNKNOWN ? IncidentStatus.EXECUTION_UNKNOWN : IncidentStatus.FAILED },
        });
      }
      await this.audit(db, execution.incidentId, 'ACTION_RESULT', 'SYSTEM', `Action execution ${outcome}`, responseJson);
      return { recorded: true, incidentId: execution.incidentId };
    });
  }
  private incidentStatusFromProvider(providerStatus: string, fallback: IncidentStatus = IncidentStatus.RECEIVED): IncidentStatus {
    if (['PROCESSED', 'SUCCESS', 'COMPLETED'].includes(providerStatus)) return IncidentStatus.RECOVERED;
    if (['PROCESSING', 'PENDING', 'QUEUED', 'INITIATED', 'SCHEDULED'].includes(providerStatus)) return IncidentStatus.PROCESSING;
    if (['REVERSED', 'REVERTED'].includes(providerStatus)) return IncidentStatus.REVERSED;
    if (['FAILED', 'FAILURE', 'REJECTED', 'CANCELLED'].includes(providerStatus)) return IncidentStatus.FAILED;
    return fallback;
  }
  private toBatchView(batch: BatchWithIncidents) {
    const results = batch.results.map(result => {
      const finalState = result.incident.status;
      const eligibleForRecovery = this.isEligibleForRecovery(result.incident);
      return { ...result, finalState, eligibleForRecovery, recoveredValuePaise: finalState === IncidentStatus.RECOVERED ? result.incident.amountPaise : 0 };
    });
    const recoveredValuePaise = results.reduce((sum, result) => sum + result.recoveredValuePaise, 0);
    const eligible = results.filter(result => result.eligibleForRecovery);
    const eligibleValuePaise = eligible.reduce((sum, result) => sum + result.incident.amountPaise, 0);
    const recoveredEligibleValuePaise = eligible.filter(result => result.finalState === IncidentStatus.RECOVERED).reduce((sum, result) => sum + result.incident.amountPaise, 0);
    const statusDistribution = results.reduce<Record<string, number>>((counts, result) => { counts[result.finalState] = (counts[result.finalState] ?? 0) + 1; return counts; }, {});
    const manualStates: IncidentStatus[] = [IncidentStatus.APPROVAL_REQUIRED, IncidentStatus.ESCALATE];
    const protectedStates: IncidentStatus[] = [IncidentStatus.STOPPED, IncidentStatus.PROCESSING, IncidentStatus.EXECUTION_UNKNOWN];
    const unresolvedStates: IncidentStatus[] = [IncidentStatus.RECEIVED, IncidentStatus.ANALYZING, IncidentStatus.POLICY_PENDING, IncidentStatus.AUTO_RETRY, IncidentStatus.APPROVAL_REQUIRED, IncidentStatus.EXECUTING, IncidentStatus.PROCESSING, IncidentStatus.ESCALATE, IncidentStatus.EXECUTION_UNKNOWN];
    const manual = results.filter(result => manualStates.includes(result.finalState));
    const protectedResults = results.filter(result => protectedStates.includes(result.finalState));
    const pendingEligible = eligible.filter(result => result.finalState !== IncidentStatus.RECOVERED);
    return { ...batch, results, metrics: {
      valueAtRiskPaise: batch.totalValueAtRiskPaise, recoveredValuePaise,
      recoveryRate: batch.totalValueAtRiskPaise ? recoveredValuePaise / batch.totalValueAtRiskPaise : 0,
      eligibleCount: eligible.length, eligibleValuePaise, recoveredEligibleValuePaise,
      eligibleRecoveryRate: eligibleValuePaise ? recoveredEligibleValuePaise / eligibleValuePaise : 0,
      pendingRecoveryValuePaise: pendingEligible.reduce((sum, result) => sum + result.incident.amountPaise, 0),
      manualReviewValuePaise: manual.reduce((sum, result) => sum + result.incident.amountPaise, 0),
      protectedValuePaise: protectedResults.reduce((sum, result) => sum + result.incident.amountPaise, 0),
      manualInterventions: manual.length, unsafeActionsPrevented: protectedResults.length,
      unresolvedIncidents: results.filter(result => unresolvedStates.includes(result.finalState)).length, statusDistribution,
    } };
  }
  private isEligibleForRecovery(incident: BatchWithIncidents['results'][number]['incident']) {
    const analysis = incident.analyses[0]?.outputJson;
    const parsed = aiProposalSchema.safeParse(analysis);
    if (parsed.success) return parsed.data.category === 'TRANSIENT_TECHNICAL' && parsed.data.recommendedAction === 'RETRY';
    return incident.policyDecisions[0]?.finalDecision === Decision.AUTO_RETRY;
  }
  private async serviceStatus() {
    let database = false; let redis = false;
    try { await this.withTimeout(this.prisma.$queryRaw`SELECT 1`, 5_000); database = true; } catch {}
    try { await this.withTimeout(this.queue.getJobCounts('waiting'), 5_000); redis = true; } catch {}
    return { database, redis };
  }
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
  private jsonValue(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue; }
  private csvValue(value: unknown) { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
  private audit(db: any, incidentId: string, eventType: string, actorType: string, rationale: string, data: unknown, policyVersion?: string, decision?: string, actorId?: string) { return db.auditEvent.create({ data: { incidentId, eventType, actorType, actorId, policyVersion, decision, rationale, dataJson: data } }); }
}
