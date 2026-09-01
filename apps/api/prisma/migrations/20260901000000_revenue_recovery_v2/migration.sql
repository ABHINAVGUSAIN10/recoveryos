-- Safety review semantics
CREATE TYPE "ReviewKind" AS ENUM ('RETRY_APPROVAL', 'REMEDIATION');
ALTER TABLE "ReviewTask" ADD COLUMN "kind" "ReviewKind" NOT NULL DEFAULT 'RETRY_APPROVAL';
ALTER TABLE "ReviewTask" ADD COLUMN "remediationJson" JSONB;

UPDATE "ReviewTask" AS review
SET "kind" = 'REMEDIATION'
WHERE EXISTS (
  SELECT 1
  FROM "PolicyDecision" AS decision
  WHERE decision."incidentId" = review."incidentId"
    AND decision."finalDecision" = 'ESCALATE'
    AND decision."createdAt" <= review."createdAt"
);

-- Immutable payout batch evidence
ALTER TABLE "BatchRun" ADD COLUMN "policyVersion" TEXT;
ALTER TABLE "BatchRun" ADD COLUMN "modelRef" TEXT;
ALTER TABLE "BatchRun" ADD COLUMN "promptVersion" TEXT;
ALTER TABLE "BatchRun" ADD COLUMN "cohortFingerprint" TEXT;
ALTER TABLE "BatchRun" ADD COLUMN "baselineJson" JSONB;
ALTER TABLE "BatchRun" ADD COLUMN "metricsJson" JSONB;

ALTER TABLE "BatchResult" ADD COLUMN "eligibleForRecovery" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BatchResult" ADD COLUMN "humanInterventions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BatchResult" ADD COLUMN "unsafeActionsPrevented" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BatchResult" ADD COLUMN "snapshotJson" JSONB;
ALTER TABLE "BatchResult" ADD COLUMN "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "BatchResult" AS result
SET "eligibleForRecovery" = COALESCE((
  SELECT analysis."outputJson"->>'category' = 'TRANSIENT_TECHNICAL'
    AND analysis."outputJson"->>'recommendedAction' = 'RETRY'
  FROM "AiAnalysis" AS analysis
  JOIN "BatchRun" AS batch ON batch."id" = result."batchRunId"
  WHERE analysis."incidentId" = result."incidentId"
    AND analysis."createdAt" <= batch."startedAt"
  ORDER BY analysis."createdAt" DESC
  LIMIT 1
), false);

UPDATE "BatchResult" AS result
SET "humanInterventions" = (
  SELECT COUNT(*)::INTEGER
  FROM "AuditEvent" AS audit
  JOIN "BatchRun" AS batch ON batch."id" = result."batchRunId"
  WHERE audit."incidentId" = result."incidentId"
    AND audit."createdAt" <= batch."startedAt"
    AND audit."eventType" IN ('HUMAN_APPROVED', 'HUMAN_APPROVED_RETRY', 'HUMAN_REJECTED', 'BENEFICIARY_REMEDIATED')
),
"unsafeActionsPrevented" = CASE WHEN result."finalState" IN ('STOPPED', 'PROCESSING', 'EXECUTION_UNKNOWN') THEN 1 ELSE 0 END;

UPDATE "BatchResult" AS result
SET "snapshotJson" = jsonb_build_object(
  'incident', jsonb_build_object(
    'id', incident."id", 'razorpayPayoutId', incident."razorpayPayoutId", 'status', result."finalState",
    'amountPaise', incident."amountPaise", 'currency', incident."currency", 'currentReason', incident."currentReason",
    'beneficiaryRef', incident."beneficiaryRef", 'attempts', incident."attempts",
    'duplicateSuspected', incident."duplicateSuspected", 'createdAt', incident."createdAt", 'updatedAt', incident."updatedAt"
  ),
  'legacySnapshot', true
)
FROM "PayoutIncident" AS incident
WHERE incident."id" = result."incidentId";

UPDATE "BatchRun" SET "completedAt" = COALESCE("completedAt", "startedAt");

-- Inbound revenue recovery domain
CREATE TYPE "RevenueIncidentStatus" AS ENUM ('DETECTED', 'ANALYZING', 'POLICY_PENDING', 'AUTO_ACTION', 'APPROVAL_REQUIRED', 'ESCALATED', 'STOPPED', 'RECOVERED', 'EXPIRED');
CREATE TYPE "RevenueActionOutcome" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'UNKNOWN');

CREATE TABLE "RevenueIncident" (
  "id" TEXT NOT NULL, "sourcePaymentId" TEXT NOT NULL, "status" "RevenueIncidentStatus" NOT NULL,
  "amountPaise" INTEGER NOT NULL, "currency" TEXT NOT NULL DEFAULT 'INR', "customerRef" TEXT NOT NULL,
  "paymentMethod" TEXT NOT NULL, "failureCode" TEXT NOT NULL, "failureDescription" TEXT NOT NULL,
  "consentToContact" BOOLEAN NOT NULL DEFAULT false, "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "recoveredAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RevenueIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueEvent" (
  "id" TEXT NOT NULL, "externalEventId" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL, "dataJson" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueAnalysis" (
  "id" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "modelRef" TEXT NOT NULL, "promptVersion" TEXT NOT NULL,
  "timelineDigest" TEXT NOT NULL, "outputJson" JSONB NOT NULL, "confidence" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RevenueAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenuePolicyDecision" (
  "id" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "policyVersion" TEXT NOT NULL, "proposedAction" TEXT NOT NULL,
  "finalAction" TEXT NOT NULL, "authorized" BOOLEAN NOT NULL, "reasonsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RevenuePolicyDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueAction" (
  "id" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "actionType" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "outcome" "RevenueActionOutcome" NOT NULL DEFAULT 'PENDING', "scheduledFor" TIMESTAMP(3) NOT NULL,
  "executedAt" TIMESTAMP(3), "resultJson" JSONB, "attributedRevenuePaise" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RevenueAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueAuditEvent" (
  "id" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "eventType" TEXT NOT NULL, "actorType" TEXT NOT NULL,
  "actorId" TEXT, "policyVersion" TEXT, "rationale" TEXT NOT NULL, "dataJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RevenueAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueExperiment" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "cohortSize" INTEGER NOT NULL, "totalValueAtRiskPaise" INTEGER NOT NULL,
  "policyVersion" TEXT NOT NULL, "modelRef" TEXT NOT NULL, "promptVersion" TEXT NOT NULL,
  "cohortFingerprint" TEXT NOT NULL, "baselineJson" JSONB NOT NULL, "metricsJson" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RevenueExperiment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RevenueExperimentResult" (
  "id" TEXT NOT NULL, "experimentId" TEXT NOT NULL, "incidentId" TEXT NOT NULL, "finalState" TEXT NOT NULL,
  "recoveredValuePaise" INTEGER NOT NULL DEFAULT 0, "interventionCount" INTEGER NOT NULL DEFAULT 0,
  "unsafeActionsPrevented" INTEGER NOT NULL DEFAULT 0, "snapshotJson" JSONB NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RevenueExperimentResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RevenueIncident_sourcePaymentId_key" ON "RevenueIncident"("sourcePaymentId");
CREATE UNIQUE INDEX "RevenueEvent_externalEventId_key" ON "RevenueEvent"("externalEventId");
CREATE UNIQUE INDEX "RevenueAction_idempotencyKey_key" ON "RevenueAction"("idempotencyKey");
CREATE INDEX "RevenueExperiment_cohortFingerprint_idx" ON "RevenueExperiment"("cohortFingerprint");
CREATE UNIQUE INDEX "RevenueExperimentResult_experimentId_incidentId_key" ON "RevenueExperimentResult"("experimentId", "incidentId");

ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueAnalysis" ADD CONSTRAINT "RevenueAnalysis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenuePolicyDecision" ADD CONSTRAINT "RevenuePolicyDecision_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueAction" ADD CONSTRAINT "RevenueAction_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueAuditEvent" ADD CONSTRAINT "RevenueAuditEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueExperimentResult" ADD CONSTRAINT "RevenueExperimentResult_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "RevenueExperiment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevenueExperimentResult" ADD CONSTRAINT "RevenueExperimentResult_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "RevenueIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-enforced immutability for event ledgers, audit trails, and completed experiment evidence.
CREATE OR REPLACE FUNCTION "recoveryos_reject_immutable_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RecoveryOS immutable evidence cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayoutEvent_immutable" BEFORE UPDATE OR DELETE ON "PayoutEvent" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "AuditEvent_immutable" BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "BatchResult_immutable" BEFORE UPDATE OR DELETE ON "BatchResult" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "RevenueEvent_immutable" BEFORE UPDATE OR DELETE ON "RevenueEvent" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "RevenueAuditEvent_immutable" BEFORE UPDATE OR DELETE ON "RevenueAuditEvent" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "RevenueExperiment_immutable" BEFORE UPDATE OR DELETE ON "RevenueExperiment" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
CREATE TRIGGER "RevenueExperimentResult_immutable" BEFORE UPDATE OR DELETE ON "RevenueExperimentResult" FOR EACH ROW EXECUTE FUNCTION "recoveryos_reject_immutable_mutation"();
