import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'crypto';
import { Decision, ExecutionOutcome, IncidentStatus, Prisma, ReviewKind, ReviewStatus } from '@prisma/client';
import { aiProposalSchema, beneficiaryRemediationSchema, evaluatePolicy, incidentSchema, policyConfigSchema, type Incident, type PolicyConfig } from '@recoveryos/domain';
import { PrismaService } from './prisma.service';
import { AiService } from './ai.service';
import {
  incidentIdFromRecoveryReference,
  RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
  RAZORPAYX_TEST_DEMO_CONFIRMATION,
  RazorpayExecutionUncertainError,
  RazorpayService,
  recoveryIdempotencyKey,
} from './razorpay.service';
import { safeErrorMessage } from './redaction';
import { DEMO_SCENARIOS, demoScenarioSchema } from './demo-scenarios';

const DEFAULT_POLICY: PolicyConfig = { version: 'v1.0.0', maxAutoRetryAttempts: 2, maxAutonomousAmountPaise: 1_000_000, minimumRetryDelayMinutes: 30 };
type BatchWithIncidents = Prisma.BatchRunGetPayload<{ include: { results: { include: { incident: { include: { auditEvents: true; executions: true } } } } } }>;
type IncidentListQuery = { page?: number; pageSize?: number; search?: string; status?: string; reviewRequired?: boolean };
type DemoAnalysisContext = { runId: string; actorId: string; retryDelaySeconds: number; executionMode?: 'SIMULATED' | 'RAZORPAYX_TEST' };
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);
  private demoRunActive = false;
  private razorpayTestDemoActive = false;
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
    const providerConfiguration = this.razorpay.testDemoConfiguration();
    let providerPolicyAllowsAmount = false;
    if (services.database) {
      try { providerPolicyAllowsAmount = (await this.getPolicy()).maxAutonomousAmountPaise >= RAZORPAYX_TEST_DEMO_AMOUNT_PAISE; }
      catch {}
    }
    return {
      status: services.database && services.redis ? 'ready' : 'degraded',
      simulationMode, services, queue, ai,
      demo: {
        enabled: demoEnabled,
        ready: demoEnabled && simulationMode && services.database && services.redis && ai.configured,
        retryDelaySeconds: Number.parseInt(process.env.DEMO_RETRY_DELAY_SECONDS || '5', 10),
        scenarios: DEMO_SCENARIOS.map(({ key, title, description, amountPaise, expectedAiAction, expectedPolicyDecision, humanRequired }) => ({ key, title, description, amountPaise, expectedAiAction, expectedPolicyDecision, humanRequired })),
      },
      razorpayTestDemo: {
        ...providerConfiguration,
        policyAllowsAmount: providerPolicyAllowsAmount,
        cooldownSeconds: Number.parseInt(process.env.RAZORPAYX_TEST_DEMO_COOLDOWN_SECONDS || '300', 10),
        ready: providerConfiguration.ready && providerPolicyAllowsAmount && services.database && services.redis && ai.configured,
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

  async runRazorpayTestDemo(confirmation: string, actorId = 'admin') {
    if (confirmation !== RAZORPAYX_TEST_DEMO_CONFIRMATION) throw new BadRequestException('Explicit ₹10,000 Test Mode payout confirmation is required');
    const configuration = this.razorpay.testDemoConfiguration();
    if (!configuration.enabled) throw new ForbiddenException('RazorpayX Test Mode demonstration is disabled');
    if (!configuration.ready) throw new ServiceUnavailableException('RazorpayX Test Mode demonstration is not safely configured');
    if (!this.ai.status().configured) throw new ServiceUnavailableException('A hosted AI provider must be configured for the RazorpayX demonstration');
    if (this.razorpayTestDemoActive) throw new ConflictException('Another RazorpayX Test Mode demonstration is already running');

    const policy = await this.getPolicy();
    if (policy.maxAutonomousAmountPaise < RAZORPAYX_TEST_DEMO_AMOUNT_PAISE) {
      throw new ConflictException('The active policy amount cap does not authorize an autonomous ₹10,000 retry');
    }
    if (policy.maxAutoRetryAttempts < 1) throw new ConflictException('The active policy does not authorize automatic retries');

    const cooldownSeconds = Number.parseInt(process.env.RAZORPAYX_TEST_DEMO_COOLDOWN_SECONDS || '300', 10);
    const [openExecution, recent] = await Promise.all([
      this.prisma.actionExecution.findFirst({
        where: { actionType: 'RAZORPAYX_TEST_PAYOUT', outcome: { in: [ExecutionOutcome.PENDING, ExecutionOutcome.UNKNOWN] } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.actionExecution.findFirst({
        where: {
          actionType: 'RAZORPAYX_TEST_PAYOUT',
          createdAt: { gte: new Date(Date.now() - cooldownSeconds * 1_000) },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    if (openExecution) throw new ConflictException('A RazorpayX Test Mode payout is still pending provider confirmation; reconcile it before another run');
    if (recent) throw new ConflictException(`A RazorpayX Test Mode payout was already requested within the ${cooldownSeconds}-second safety window`);

    const runId = `rx_demo_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const retryDelaySeconds = Number.parseInt(process.env.DEMO_RETRY_DELAY_SECONDS || '5', 10);
    const eventId = `evt_${runId}_temporary_failure`;
    const payoutId = `pout_seed_${runId}`;
    const payload = {
      event_id: eventId,
      event: 'recoveryos.demo.payout.failed',
      payload: { payout: { entity: {
        id: payoutId,
        amount: RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
        currency: 'INR',
        status: 'failed',
        reference_id: `recoveryos-test-${runId}`,
        status_details: { description: 'Temporary beneficiary bank technical failure' },
        notes: { recoveryos_demo_run: runId, recoveryos_demo_scenario: 'RAZORPAYX_TEST_RETRY' },
      } } },
    };

    this.razorpayTestDemoActive = true;
    try {
      const context: DemoAnalysisContext = { runId, actorId, retryDelaySeconds, executionMode: 'RAZORPAYX_TEST' };
      const first = await this.ingestWebhook(eventId, payload.event, payload, context);
      const replay = await this.ingestWebhook(eventId, payload.event, payload);
      if (!first.incidentId) throw new Error('RazorpayX Test Mode demonstration did not create an incident');
      const batch = await this.createBatch(`RazorpayX Test Demo ${runId}`, [first.incidentId]);
      const incident = await this.incidentDetail(first.incidentId);
      return {
        runId,
        amountPaise: RAZORPAYX_TEST_DEMO_AMOUNT_PAISE,
        retryDelaySeconds,
        duplicateReplayVerified: replay.duplicate && replay.incidentId === first.incidentId,
        batch,
        incident,
      };
    } finally {
      this.razorpayTestDemoActive = false;
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
  async updatePolicy(config: unknown, actorId = 'admin') {
    const result = policyConfigSchema.safeParse(config);
    if (!result.success) throw new BadRequestException(`Invalid policy configuration: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    const parsed = result.data;
    const existing = await this.prisma.policyConfig.findUnique({ where: { version: parsed.version } });
    if (existing) {
      const stored = policyConfigSchema.parse(existing.rulesJson);
      if (JSON.stringify(stored) !== JSON.stringify(parsed)) {
        throw new ConflictException(`Policy version ${parsed.version} is immutable; publish changed rules under a new version`);
      }
    }
    await this.prisma.$transaction(async db => {
      await db.policyConfig.updateMany({ where: { active: true }, data: { active: false } });
      if (existing) await db.policyConfig.update({ where: { version: parsed.version }, data: { active: true } });
      else await db.policyConfig.create({ data: { version: parsed.version, rulesJson: parsed, createdBy: actorId } });
    });
    return parsed;
  }
  async ingestWebhook(externalEventId: string, eventType: string, payload: any, demoContext?: DemoAnalysisContext) {
    const existing = await this.prisma.payoutEvent.findUnique({ where: { externalEventId } });
    if (existing) return { duplicate: true, incidentId: existing.payoutIncidentId };
    const entity = payload?.payload?.payout?.entity ?? payload?.payout ?? payload;
    const payoutId = entity?.id ?? entity?.payout_id;
    if (typeof payoutId !== 'string' || !payoutId.trim()) throw new BadRequestException('Webhook payload does not contain a valid payout id');
    const providerStatus = String(entity.status ?? 'failed').toUpperCase();
    const status = this.incidentStatusFromProvider(providerStatus);
    const amountPaise = Number(entity.amount ?? 0);
    const currency = String(entity.currency ?? 'INR').toUpperCase();
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new BadRequestException('Webhook payout amount must be a positive integer in paise');
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('Webhook payout currency must be a three-letter code');
    const reason = entity?.status_details?.description ?? entity?.status_details?.reason ?? entity?.failure_reason ?? null;
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
          return (execution.outcome === ExecutionOutcome.PENDING || execution.outcome === ExecutionOutcome.UNKNOWN) && typeof response?.id !== 'string';
        }) ?? null;
        const linkedRecovery = Boolean(recoveryIncidentId && recoveryExecution);
        const existingIncident = linkedRecovery
          ? await db.payoutIncident.findUniqueOrThrow({ where: { id: recoveryIncidentId! } })
          : await db.payoutIncident.findUnique({ where: { razorpayPayoutId: payoutId } });
        const transition = this.providerTransition(existingIncident?.status ?? null, status, linkedRecovery);
        const providerDataMismatch = Boolean(existingIncident && (
          (typeof existingIncident.amountPaise === 'number' && existingIncident.amountPaise !== amountPaise)
          || (typeof existingIncident.currency === 'string' && existingIncident.currency !== currency)
        ));
        const duplicateRecoveryDetected = Boolean(
          linkedRecovery
          && recoveryExecution
          && status === IncidentStatus.RECOVERED
          && existingIncident?.status === IncidentStatus.RECOVERED
          && recoveryExecution.outcome !== ExecutionOutcome.SUCCEEDED,
        );
        const incident = existingIncident
          ? await db.payoutIncident.update({ where: { id: existingIncident.id }, data: {
              status: transition.status,
              ...(transition.applied ? { currentReason: reason } : {}),
              ...(duplicateRecoveryDetected ? { duplicateSuspected: true } : {}),
            } })
          : await db.payoutIncident.create({ data: { razorpayPayoutId: payoutId, status, amountPaise, currency, currentReason: reason, beneficiaryRef: entity.fund_account_id ?? entity.reference_id ?? null } });
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
        const seededProviderDemo = demoContext?.executionMode === 'RAZORPAYX_TEST';
        await this.audit(
          db,
          incident.id,
          seededProviderDemo ? 'DEMO_FAILURE_SEEDED' : 'WEBHOOK_RECEIVED',
          'SYSTEM',
          seededProviderDemo ? 'Controlled temporary-failure seed persisted for a RazorpayX Test Mode recovery demonstration.' : `Provider event ${eventType} persisted`,
          { externalEventId, eventId: event.id },
        );
        if (!transition.applied) await this.audit(db, incident.id, 'WEBHOOK_STATE_IGNORED', 'SYSTEM', `Provider event ${eventType} was recorded without regressing the incident workflow state.`, { externalEventId, currentStatus: existingIncident?.status, providerStatus, mappedStatus: status });
        if (providerDataMismatch) await this.audit(db, incident.id, 'PROVIDER_DATA_MISMATCH', 'SYSTEM', 'A later event reported different financial identity fields; the incident retained its original amount and currency.', { externalEventId, reportedAmountPaise: amountPaise, reportedCurrency: currency, storedAmountPaise: existingIncident!.amountPaise, storedCurrency: existingIncident!.currency });
        if (duplicateRecoveryDetected) await this.audit(db, incident.id, 'DUPLICATE_PAYOUT_CONFIRMED', 'SYSTEM', 'The original payout and its linked recovery payout both reached a successful provider state; recovered-value attribution is blocked.', { externalEventId, recoveryExecutionId: recoveryExecution!.id, recoveryPayoutId: payoutId });
        if (demoContext) await this.audit(db, incident.id, 'DEMO_SCENARIO_STARTED', 'HUMAN', `${seededProviderDemo ? 'RazorpayX Test Mode' : 'Live'} demonstration ${demoContext.runId} started by ${demoContext.actorId}`, { runId: demoContext.runId, executionMode: demoContext.executionMode || 'SIMULATED' }, undefined, undefined, demoContext.actorId);
        return { incident, linkedRecovery, shouldAnalyze: transition.shouldAnalyze };
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const duplicate = await this.prisma.payoutEvent.findUnique({ where: { externalEventId } });
        if (duplicate) return { duplicate: true, incidentId: duplicate.payoutIncidentId };
      }
      throw error;
    }
    if (result.shouldAnalyze) await this.analyze(result.incident.id, demoContext);
    return { duplicate: false, incidentId: result.incident.id };
  }
  async analyze(incidentId: string, demoContext?: DemoAnalysisContext) {
    const record = await this.prisma.payoutIncident.findUniqueOrThrow({ where: { id: incidentId } });
    // Capture one immutable policy snapshot for the advisory context, decision, and
    // audit evidence. A concurrent policy activation must not split one decision
    // across two versions.
    const config = await this.getPolicy();
    const incident = incidentSchema.parse({ id: record.id, razorpayPayoutId: record.razorpayPayoutId, status: record.status, amountPaise: record.amountPaise, currency: record.currency, reason: record.currentReason, beneficiaryRef: record.beneficiaryRef, attempts: record.attempts, duplicateSuspected: record.duplicateSuspected, policyVersion: config.version });
    const analysis = await this.ai.classify(incident);
    const proposal = aiProposalSchema.parse(analysis.proposal); const result = evaluatePolicy(incident, proposal, config);
    const applied = await this.prisma.$transaction(async db => {
      const status = record.status === IncidentStatus.PROCESSING ? IncidentStatus.PROCESSING : result.decision as IncidentStatus;
      const claimed = await db.payoutIncident.updateMany({ where: { id: incidentId, status: record.status }, data: { status } });
      if (!claimed.count) return false;
      await db.aiAnalysis.create({ data: { incidentId, modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, outputJson: proposal, confidence: proposal.confidence } });
      await db.policyDecision.create({ data: { incidentId, policyVersion: config.version, proposedAction: proposal.recommendedAction, finalDecision: result.decision as Decision, reasonsJson: result.reasons } });
      // A processing payout has an ambiguous external outcome. Keep that state visible so
      // reconciliation, rather than a new payout request, is the only possible next step.
      await this.audit(db, incidentId, 'POLICY_DECISION', 'POLICY', result.reasons.join('; '), { proposal, result }, config.version, result.decision);
      if (result.decision === 'ESCALATE' || result.decision === 'APPROVAL_REQUIRED') await db.reviewTask.create({ data: {
        incidentId,
        kind: result.decision === 'ESCALATE' ? ReviewKind.REMEDIATION : ReviewKind.RETRY_APPROVAL,
        severity: incident.amountPaise > config.maxAutonomousAmountPaise ? 'HIGH' : 'MEDIUM',
      } });
      return true;
    });
    if (applied && result.decision === 'AUTO_RETRY') await this.scheduleRetry(incidentId, result.delayMinutes ?? config.minimumRetryDelayMinutes, demoContext);
    return result;
  }
  private async scheduleRetry(incidentId: string, delayMinutes: number, demoContext?: DemoAnalysisContext) {
    const incident = await this.prisma.payoutIncident.findUniqueOrThrow({ where: { id: incidentId } });
    const key = recoveryIdempotencyKey(incident.id, incident.attempts + 1);
    const scheduledFor = new Date(Date.now() + (demoContext ? demoContext.retryDelaySeconds * 1_000 : delayMinutes * 60_000));
    const actionType = demoContext?.executionMode === 'RAZORPAYX_TEST' ? 'RAZORPAYX_TEST_PAYOUT' : 'RETRY_PAYOUT';
    const rationale = demoContext?.executionMode === 'RAZORPAYX_TEST'
      ? `Policy-authorized ₹10,000 RazorpayX Test Mode retry scheduled after a ${demoContext.retryDelaySeconds}-second presentation delay; the policy delay remains ${delayMinutes} minutes.`
      : demoContext
        ? `Policy delay ${delayMinutes} minutes compressed to ${demoContext.retryDelaySeconds} seconds for simulation demo ${demoContext.runId}`
      : `Retry scheduled in ${delayMinutes} minutes`;
    const execution = await this.prisma.$transaction(async db => {
      const durableExecution = await db.actionExecution.upsert({ where: { idempotencyKey: key }, update: {}, create: { incidentId, actionType, idempotencyKey: key, requestHash: createHash('sha256').update(`${incident.razorpayPayoutId}:${key}:${actionType}`).digest('hex'), scheduledFor } });
      await db.auditEvent.create({ data: { incidentId, eventType: 'ACTION_REQUESTED', actorType: 'SYSTEM', rationale, amountPaise: incident.amountPaise, dataJson: { executionId: durableExecution.id, actionType, idempotencyKey: key, policyDelayMinutes: delayMinutes, effectiveDelaySeconds: demoContext?.retryDelaySeconds, demoRunId: demoContext?.runId } } });
      return durableExecution;
    });
    await this.enqueueExecution(execution.id, execution.scheduledFor);
  }
  private async enqueueExecution(executionId: string, scheduledFor: Date) {
    const delay = Math.max(0, scheduledFor.getTime() - Date.now());
    await this.queue.add('execute-retry', { executionId }, {
      jobId: executionId,
      delay,
      // A failed financial provider call is reconciled or reviewed; BullMQ must not
      // blindly invoke the provider a second time, even with the same worker job.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1_000 },
    });
  }
  async decideReview(incidentId: string, approved: boolean, actorId = 'operator') {
    const task = await this.prisma.reviewTask.findFirst({ where: { incidentId, status: ReviewStatus.OPEN }, include: { incident: true }, orderBy: { createdAt: 'desc' } });
    if (!task) throw new BadRequestException('No open review task');
    if (approved && task.kind === ReviewKind.REMEDIATION) throw new ConflictException('Escalated incidents require recorded remediation and revalidation; they cannot be approved directly for retry');
    if (approved && task.incident.status !== IncidentStatus.APPROVAL_REQUIRED) throw new ConflictException('Only an approval-required incident can be authorized for retry');
    const remediation = task.remediationJson as { remediatedBy?: unknown } | null;
    if (approved && typeof remediation?.remediatedBy === 'string' && remediation.remediatedBy === actorId) {
      throw new ConflictException('Maker-checker control requires a different actor to approve the remediated retry');
    }
    const policy = approved ? await this.getPolicy() : null;
    await this.prisma.$transaction(async db => {
      const claimedTask = await db.reviewTask.updateMany({ where: { id: task.id, status: ReviewStatus.OPEN }, data: { status: approved ? ReviewStatus.APPROVED : ReviewStatus.REJECTED, decision: approved ? 'APPROVE_RETRY' : 'REJECT', decidedAt: new Date(), actorId } });
      if (!claimedTask.count) throw new ConflictException('This review task has already been decided');
      const claimedIncident = await db.payoutIncident.updateMany({ where: { id: incidentId, status: task.incident.status }, data: { status: approved ? IncidentStatus.AUTO_RETRY : IncidentStatus.STOPPED } });
      if (!claimedIncident.count) throw new ConflictException('The incident changed while this review was being decided');
      await this.audit(db, incidentId, approved ? 'HUMAN_APPROVED_RETRY' : 'HUMAN_REJECTED', 'HUMAN', `Review task ${approved ? 'approved for retry' : 'rejected'} by ${actorId}`, { reviewTaskId: task.id, reviewKind: task.kind }, undefined, approved ? 'AUTO_RETRY' : 'STOPPED', actorId);
    });
    if (approved) await this.scheduleRetry(incidentId, policy!.minimumRetryDelayMinutes);
  }
  async remediateIncident(incidentId: string, input: unknown, actorId = 'operator') {
    const result = beneficiaryRemediationSchema.safeParse(input);
    if (!result.success) throw new BadRequestException(`Invalid remediation: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    const remediation = result.data;
    const task = await this.prisma.reviewTask.findFirst({
      where: { incidentId, status: ReviewStatus.OPEN, kind: ReviewKind.REMEDIATION },
      include: { incident: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!task) throw new BadRequestException('No open remediation task');
    if (task.incident.status !== IncidentStatus.ESCALATE) throw new ConflictException('Only an escalated incident can be remediated');
    if (task.incident.beneficiaryRef === remediation.beneficiaryRef) throw new BadRequestException('Remediation must provide a different beneficiary reference');
    const policy = await this.getPolicy();
    const beneficiaryRefHash = createHash('sha256').update(remediation.beneficiaryRef).digest('hex');
    await this.prisma.$transaction(async db => {
      const claimedTask = await db.reviewTask.updateMany({ where: { id: task.id, status: ReviewStatus.OPEN, kind: ReviewKind.REMEDIATION }, data: {
        status: ReviewStatus.APPROVED,
        decision: 'REMEDIATED',
        remediationJson: { beneficiaryRefHash, note: remediation.note },
        decidedAt: new Date(),
        actorId,
      } });
      if (!claimedTask.count) throw new ConflictException('This remediation task has already been completed');
      const claimedIncident = await db.payoutIncident.updateMany({ where: { id: incidentId, status: IncidentStatus.ESCALATE }, data: {
        status: IncidentStatus.APPROVAL_REQUIRED,
        beneficiaryRef: remediation.beneficiaryRef,
        currentReason: 'Beneficiary remediation recorded; a separate actor must approve the retry.',
      } });
      if (!claimedIncident.count) throw new ConflictException('The incident changed while remediation was being recorded');
      await db.policyDecision.create({ data: {
        incidentId,
        policyVersion: policy.version,
        proposedAction: 'RETRY_AFTER_REMEDIATION',
        finalDecision: Decision.APPROVAL_REQUIRED,
        reasonsJson: ['POL-08: beneficiary remediation recorded', 'POL-09: maker-checker approval required before retry'],
      } });
      await db.reviewTask.create({ data: {
        incidentId,
        kind: ReviewKind.RETRY_APPROVAL,
        severity: 'HIGH',
        remediationJson: { remediatedBy: actorId, sourceTaskId: task.id, beneficiaryRefHash },
      } });
      await this.audit(db, incidentId, 'BENEFICIARY_REMEDIATED', 'HUMAN', 'Beneficiary remediation evidence recorded; retry remains blocked pending separate approval.', { sourceTaskId: task.id, beneficiaryRefHash, note: remediation.note }, policy.version, 'APPROVAL_REQUIRED', actorId);
    });
    return this.incidentDetail(incidentId);
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
  async operationalMetrics() {
    const incidents = await this.prisma.payoutIncident.findMany({
      include: {
        analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
        policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 },
        executions: true,
        auditEvents: { where: { eventType: { in: ['HUMAN_APPROVED', 'HUMAN_APPROVED_RETRY', 'HUMAN_REJECTED', 'BENEFICIARY_REMEDIATED'] } } },
      },
    });
    const results = incidents.map(incident => {
      const proposal = aiProposalSchema.safeParse(incident.analyses[0]?.outputJson);
      const decision = incident.policyDecisions[0];
      const eligibleForRecovery = proposal.success
        ? proposal.data.category === 'TRANSIENT_TECHNICAL' && proposal.data.recommendedAction === 'RETRY'
        : decision?.finalDecision === Decision.AUTO_RETRY;
      return {
        finalState: incident.status,
        recoveredValuePaise: this.attributedPayoutValue(incident),
        eligibleForRecovery,
        humanInterventions: incident.auditEvents.length,
        unsafeActionsPrevented: this.unsafeActionPrevented(incident.analyses[0]?.outputJson, decision?.finalDecision) ? 1 : 0,
        snapshot: { incident: { amountPaise: incident.amountPaise } },
      };
    });
    return this.calculateBatchMetrics(results, incidents.reduce((sum, incident) => sum + incident.amountPaise, 0));
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
            ? execution.actionType === 'RAZORPAYX_TEST_PAYOUT'
              ? await this.razorpay.fetchTestDemoPayout(recoveryPayoutId)
              : await this.razorpay.fetchPayout(recoveryPayoutId)
            : execution.actionType === 'RAZORPAYX_TEST_PAYOUT'
              ? await this.razorpay.executeTestDemoPayout(execution.idempotencyKey, incident.id)
              : await this.razorpay.executeRecovery(execution.idempotencyKey, incident.razorpayPayoutId, incident.id, incident.beneficiaryRef)
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
          const reason = (providerPayout as any)?.status_details?.description ?? (providerPayout as any)?.status_details?.reason ?? (providerPayout as any)?.failure_reason ?? incident.currentReason;
          await db.payoutIncident.update({ where: { id: incident.id }, data: { status, currentReason: reason } });
          if (execution) await db.actionExecution.update({ where: { id: execution.id }, data: { outcome: executionOutcome, responseJson: providerJson } });
          else await db.actionExecution.updateMany({ where: { incidentId: incident.id, outcome: ExecutionOutcome.UNKNOWN }, data: { outcome: executionOutcome, responseJson: providerJson } });
          await this.audit(db, incident.id, 'RECONCILIATION_COMPLETED', 'SYSTEM', `Provider confirmed payout status ${providerStatus}`, { providerPayout, providerStatus }, undefined, status);
        });
        if (status === IncidentStatus.FAILED || status === IncidentStatus.REVERSED) await this.analyze(incident.id);
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
  async createBatch(name: string, incidentIds: string[]) {
    const normalizedIds = [...new Set(Array.isArray(incidentIds) ? incidentIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()) : [])];
    if (!normalizedIds.length) throw new BadRequestException('A batch requires at least one incident from the current page');
    const normalizedName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : `Batch ${new Date().toISOString()}`;
    const incidents = await this.prisma.payoutIncident.findMany({
      where: { id: { in: normalizedIds } },
      include: {
        events: { orderBy: { receivedAt: 'asc' } },
        analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
        policyDecisions: { orderBy: { createdAt: 'desc' }, take: 1 },
        executions: true,
        auditEvents: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (incidents.length !== normalizedIds.length) throw new BadRequestException('One or more selected incidents no longer exist; refresh the queue before creating evidence');
    const snapshots = incidents.map(incident => {
      const analysis = incident.analyses[0];
      const proposal = aiProposalSchema.safeParse(analysis?.outputJson);
      const decision = incident.policyDecisions[0];
      const eligibleForRecovery = proposal.success
        ? proposal.data.category === 'TRANSIENT_TECHNICAL' && proposal.data.recommendedAction === 'RETRY'
        : decision?.finalDecision === Decision.AUTO_RETRY;
      const humanInterventions = incident.auditEvents.filter(event => ['HUMAN_APPROVED', 'HUMAN_APPROVED_RETRY', 'HUMAN_REJECTED', 'BENEFICIARY_REMEDIATED'].includes(event.eventType)).length;
      const firstPayload = incident.events[0]?.payloadJson as { payload?: { payout?: { entity?: { status?: unknown } } } } | null;
      const originalProviderStatus = String(firstPayload?.payload?.payout?.entity?.status ?? '').toUpperCase();
      const snapshot = {
        incident: {
          id: incident.id, razorpayPayoutId: incident.razorpayPayoutId, status: incident.status,
          amountPaise: incident.amountPaise, currency: incident.currency, currentReason: incident.currentReason,
          beneficiaryRef: incident.beneficiaryRef, attempts: incident.attempts, duplicateSuspected: incident.duplicateSuspected,
          createdAt: incident.createdAt.toISOString(), updatedAt: incident.updatedAt.toISOString(),
        },
        analysis: analysis ? { modelRef: analysis.modelRef, promptVersion: analysis.promptVersion, outputJson: analysis.outputJson, confidence: analysis.confidence } : null,
        policyDecision: decision ? { policyVersion: decision.policyVersion, proposedAction: decision.proposedAction, finalDecision: decision.finalDecision, reasonsJson: decision.reasonsJson } : null,
        actionOutcomes: incident.executions.map(execution => ({ actionType: execution.actionType, outcome: execution.outcome, responseJson: execution.responseJson })),
        originalProviderStatus,
      };
      return {
        incidentId: incident.id,
        finalState: incident.status,
        recoveredValuePaise: this.attributedPayoutValue(incident),
        eligibleForRecovery,
        humanInterventions,
        unsafeActionsPrevented: this.unsafeActionPrevented(analysis?.outputJson, decision?.finalDecision) ? 1 : 0,
        snapshot,
      };
    });
    const totalValueAtRiskPaise = incidents.reduce((sum, item) => sum + item.amountPaise, 0);
    const metrics = this.calculateBatchMetrics(snapshots, totalValueAtRiskPaise);
    const policyVersions = [...new Set(snapshots.map(item => item.snapshot.policyDecision?.policyVersion).filter((value): value is string => Boolean(value)))];
    const modelRefs = [...new Set(snapshots.map(item => item.snapshot.analysis?.modelRef).filter((value): value is string => Boolean(value)))];
    const promptVersions = [...new Set(snapshots.map(item => item.snapshot.analysis?.promptVersion).filter((value): value is string => Boolean(value)))];
    const ruleOnly = snapshots.filter(item => {
      const reason = item.snapshot.incident.currentReason?.toLowerCase() ?? '';
      return item.snapshot.originalProviderStatus === 'FAILED' && /technical|temporary|unavailable|network|connectivity|gateway|bank/.test(reason);
    });
    const baseline = {
      methodology: {
        noAction: 'Frozen cohort incidents already terminal-success at ingestion; no causal recovery is attributed.',
        rulesOnly: 'Frozen keyword-rule eligibility with the observed terminal outcomes; reported separately from AI-policy eligibility.',
      },
      noAction: {
        recoveredValuePaise: snapshots.filter(item => ['PROCESSED', 'SUCCESS', 'COMPLETED'].includes(item.snapshot.originalProviderStatus)).reduce((sum, item) => sum + item.snapshot.incident.amountPaise, 0),
      },
      rulesOnly: {
        eligibleCount: ruleOnly.length,
        eligibleValuePaise: ruleOnly.reduce((sum, item) => sum + item.snapshot.incident.amountPaise, 0),
        observedRecoveredValuePaise: ruleOnly.reduce((sum, item) => sum + item.recoveredValuePaise, 0),
      },
    };
    const cohortFingerprint = createHash('sha256').update(JSON.stringify(snapshots.map(item => item.snapshot).sort((a, b) => a.incident.id.localeCompare(b.incident.id)))).digest('hex');
    const batch = await this.prisma.$transaction(async db => {
      const created = await db.batchRun.create({ data: {
        name: normalizedName,
        cohortSize: incidents.length,
        totalValueAtRiskPaise,
        policyVersion: policyVersions.length === 1 ? policyVersions[0] : policyVersions.length ? 'mixed' : null,
        modelRef: modelRefs.length === 1 ? modelRefs[0] : modelRefs.length ? 'mixed' : null,
        promptVersion: promptVersions.length === 1 ? promptVersions[0] : promptVersions.length ? 'mixed' : null,
        cohortFingerprint,
        baselineJson: this.jsonValue(baseline),
        metricsJson: this.jsonValue(metrics),
        completedAt: new Date(),
      } });
      if (snapshots.length) await db.batchResult.createMany({ data: snapshots.map(item => ({
        batchRunId: created.id,
        incidentId: item.incidentId,
        finalState: item.finalState,
        recoveredValuePaise: item.recoveredValuePaise,
        eligibleForRecovery: item.eligibleForRecovery,
        humanInterventions: item.humanInterventions,
        unsafeActionsPrevented: item.unsafeActionsPrevented,
        snapshotJson: this.jsonValue(item.snapshot),
      })) });
      return created;
    });
    return this.batchResults(batch.id);
  }
  async listBatches() {
    const batches = await this.prisma.batchRun.findMany({ orderBy: { startedAt: 'desc' }, include: { results: { include: { incident: { include: { auditEvents: true, executions: true } } } } } });
    return batches.map(batch => this.toBatchView(batch));
  }
  async batchResults(id: string) {
    const batch = await this.prisma.batchRun.findUniqueOrThrow({ where: { id }, include: { results: { include: { incident: { include: { auditEvents: true, executions: true } } } } } });
    return this.toBatchView(batch);
  }
  async batchExportCsv(id: string) {
    const batch = await this.batchResults(id);
    const header = ['incident_id', 'razorpay_payout_id', 'amount_paise', 'currency', 'final_state', 'recovered_value_paise', 'attempts', 'reason', 'updated_at'];
    const rows = batch.results.map(result => [result.incidentId, result.incident.razorpayPayoutId, result.incident.amountPaise, result.incident.currency, result.finalState, result.recoveredValuePaise, result.incident.attempts, result.incident.currentReason ?? '', new Date(result.incident.updatedAt).toISOString()]);
    return [header, ...rows].map(row => row.map(value => this.csvValue(value)).join(',')).join('\n');
  }
  async batchExportJson(id: string) {
    const { liveMetrics: _liveMetrics, ...snapshot } = await this.batchResults(id);
    return snapshot;
  }
  async recordExecutionResult(executionId: string, outcome: ExecutionOutcome, response: unknown) {
    return this.prisma.$transaction(async db => {
      const execution = await db.actionExecution.findUniqueOrThrow({ where: { id: executionId } });
      const responseJson = this.jsonValue(response);
      const claimed = await db.actionExecution.updateMany({ where: { id: executionId, outcome: ExecutionOutcome.PENDING }, data: { outcome, responseJson } });
      if (!claimed.count) return { recorded: false, incidentId: execution.incidentId };
      if (outcome === ExecutionOutcome.SUCCEEDED) {
        const incident = await db.payoutIncident.findUniqueOrThrow({ where: { id: execution.incidentId } });
        const duplicateRecoveryDetected = incident.status === IncidentStatus.RECOVERED;
        await db.payoutIncident.update({ where: { id: execution.incidentId }, data: {
          status: IncidentStatus.RECOVERED,
          attempts: { increment: 1 },
          ...(duplicateRecoveryDetected ? { duplicateSuspected: true } : {}),
        } });
        if (duplicateRecoveryDetected) await this.audit(db, execution.incidentId, 'DUPLICATE_PAYOUT_CONFIRMED', 'SYSTEM', 'The original payout recovered before the linked recovery action returned success; recovered-value attribution is blocked.', { executionId });
      } else {
        const provider = response && typeof response === 'object' ? response as Record<string, any> : {};
        const providerReason = provider?.status_details?.description ?? provider?.status_details?.reason ?? provider?.failure_reason ?? (typeof provider?.error === 'string' ? provider.error : undefined);
        await db.payoutIncident.update({ where: { id: execution.incidentId }, data: { attempts: { increment: 1 }, ...(typeof providerReason === 'string' && providerReason ? { currentReason: providerReason } : {}) } });
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
  private providerTransition(current: IncidentStatus | null, incoming: IncidentStatus, linkedRecovery: boolean) {
    if (!current) return { status: incoming, applied: true, shouldAnalyze: incoming !== IncidentStatus.RECOVERED };
    if (current === IncidentStatus.RECOVERED) return { status: current, applied: false, shouldAnalyze: false };
    if (incoming === IncidentStatus.RECOVERED) return { status: incoming, applied: true, shouldAnalyze: false };
    if (linkedRecovery) {
      if (incoming === current) return { status: current, applied: true, shouldAnalyze: false };
      return {
        status: incoming,
        applied: true,
        shouldAnalyze: incoming === IncidentStatus.FAILED || incoming === IncidentStatus.REVERSED,
      };
    }
    if (current === IncidentStatus.PROCESSING) {
      if (incoming === IncidentStatus.FAILED || incoming === IncidentStatus.REVERSED) return { status: incoming, applied: true, shouldAnalyze: true };
      return { status: current, applied: incoming === IncidentStatus.PROCESSING, shouldAnalyze: false };
    }
    if (current === IncidentStatus.RECEIVED) return { status: incoming, applied: true, shouldAnalyze: true };
    // Once policy or an operator owns the workflow, repeated/late provider failure
    // events are evidence only. They cannot move the state machine backwards.
    return { status: current, applied: false, shouldAnalyze: false };
  }
  private unsafeActionPrevented(output: unknown, finalDecision?: Decision | null) {
    const proposal = aiProposalSchema.safeParse(output);
    return proposal.success
      && proposal.data.recommendedAction === 'RETRY'
      && Boolean(finalDecision)
      && finalDecision !== Decision.AUTO_RETRY;
  }
  private attributedPayoutValue(incident: { status: IncidentStatus; amountPaise: number; duplicateSuspected?: boolean; executions?: Array<{ outcome: ExecutionOutcome; responseJson: Prisma.JsonValue | null }> }) {
    if (incident.status !== IncidentStatus.RECOVERED || incident.duplicateSuspected) return 0;
    const attributed = incident.executions?.some(execution => {
      const response = execution.responseJson as { recovery_original_processed?: unknown } | null;
      return execution.outcome === ExecutionOutcome.SUCCEEDED && response?.recovery_original_processed !== true;
    });
    return attributed ? incident.amountPaise : 0;
  }
  private toBatchView(batch: BatchWithIncidents) {
    const resultViews = batch.results.map(result => {
      const snapshot = result.snapshotJson as { incident?: Record<string, unknown> } | null;
      const { auditEvents = [], executions = [], ...liveIncident } = result.incident;
      const snapshotAnalysis = snapshot as { analysis?: { outputJson?: unknown }; policyDecision?: { finalDecision?: Decision } } | null;
      return {
        view: {
          ...result,
          finalState: result.finalState,
          eligibleForRecovery: Boolean(result.eligibleForRecovery),
          recoveredValuePaise: result.recoveredValuePaise,
          humanInterventions: result.humanInterventions ?? 0,
          unsafeActionsPrevented: result.unsafeActionsPrevented ?? 0,
          incident: snapshot?.incident ? { ...liveIncident, ...snapshot.incident } : liveIncident,
        },
        liveMetric: {
          finalState: result.incident.status,
          recoveredValuePaise: this.attributedPayoutValue({ ...result.incident, executions }),
          eligibleForRecovery: Boolean(result.eligibleForRecovery),
          humanInterventions: auditEvents.filter(event => ['HUMAN_APPROVED', 'HUMAN_APPROVED_RETRY', 'HUMAN_REJECTED', 'BENEFICIARY_REMEDIATED'].includes(event.eventType)).length,
          unsafeActionsPrevented: this.unsafeActionPrevented(snapshotAnalysis?.analysis?.outputJson, snapshotAnalysis?.policyDecision?.finalDecision) ? 1 : 0,
          snapshot: { incident: { amountPaise: result.incident.amountPaise } },
        },
      };
    });
    const results = resultViews.map(result => result.view);
    const storedMetrics = batch.metricsJson as ReturnType<RecoveryService['calculateBatchMetrics']> | null;
    const metrics = storedMetrics ?? this.calculateBatchMetrics(results.map(result => ({
      finalState: result.finalState,
      recoveredValuePaise: result.recoveredValuePaise,
      eligibleForRecovery: result.eligibleForRecovery,
      humanInterventions: result.humanInterventions,
      unsafeActionsPrevented: result.unsafeActionsPrevented,
      snapshot: { incident: { amountPaise: result.incident.amountPaise } },
    })), batch.totalValueAtRiskPaise);
    const liveMetrics = this.calculateBatchMetrics(resultViews.map(result => result.liveMetric), batch.totalValueAtRiskPaise);
    return { ...batch, results, baseline: batch.baselineJson, metrics, liveMetrics, immutable: Boolean(batch.completedAt && batch.metricsJson && batch.cohortFingerprint) };
  }
  private calculateBatchMetrics(results: Array<{ finalState: string; recoveredValuePaise: number; eligibleForRecovery: boolean; humanInterventions: number; unsafeActionsPrevented: number; snapshot: { incident: { amountPaise: number } } }>, valueAtRiskPaise: number) {
    const recoveredValuePaise = results.reduce((sum, result) => sum + result.recoveredValuePaise, 0);
    const eligible = results.filter(result => result.eligibleForRecovery);
    const eligibleValuePaise = eligible.reduce((sum, result) => sum + result.snapshot.incident.amountPaise, 0);
    const recoveredEligibleValuePaise = eligible.reduce((sum, result) => sum + result.recoveredValuePaise, 0);
    const statusDistribution = results.reduce<Record<string, number>>((counts, result) => { counts[result.finalState] = (counts[result.finalState] ?? 0) + 1; return counts; }, {});
    const manualStates = ['APPROVAL_REQUIRED', 'ESCALATE'];
    const protectedStates = ['STOPPED', 'PROCESSING', 'EXECUTION_UNKNOWN'];
    const unresolvedStates = ['RECEIVED', 'ANALYZING', 'POLICY_PENDING', 'AUTO_RETRY', 'APPROVAL_REQUIRED', 'EXECUTING', 'PROCESSING', 'ESCALATE', 'EXECUTION_UNKNOWN'];
    const unresolved = results.filter(result => unresolvedStates.includes(result.finalState));
    return {
      valueAtRiskPaise,
      openValueAtRiskPaise: unresolved.reduce((sum, result) => sum + result.snapshot.incident.amountPaise, 0),
      recoveredValuePaise,
      recoveryRate: valueAtRiskPaise ? recoveredValuePaise / valueAtRiskPaise : 0,
      eligibleCount: eligible.length,
      eligibleValuePaise,
      recoveredEligibleValuePaise,
      eligibleRecoveryRate: eligibleValuePaise ? recoveredEligibleValuePaise / eligibleValuePaise : 0,
      pendingRecoveryValuePaise: eligible.filter(result => unresolvedStates.includes(result.finalState)).reduce((sum, result) => sum + result.snapshot.incident.amountPaise, 0),
      manualReviewValuePaise: results.filter(result => manualStates.includes(result.finalState)).reduce((sum, result) => sum + result.snapshot.incident.amountPaise, 0),
      protectedValuePaise: results.filter(result => protectedStates.includes(result.finalState)).reduce((sum, result) => sum + result.snapshot.incident.amountPaise, 0),
      manualInterventions: results.reduce((sum, result) => sum + result.humanInterventions, 0),
      unsafeActionsPrevented: results.reduce((sum, result) => sum + result.unsafeActionsPrevented, 0),
      unresolvedIncidents: unresolved.length,
      statusDistribution,
    };
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
