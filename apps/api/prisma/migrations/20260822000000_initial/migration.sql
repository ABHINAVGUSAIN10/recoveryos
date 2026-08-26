-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('RECEIVED', 'ANALYZING', 'POLICY_PENDING', 'AUTO_RETRY', 'APPROVAL_REQUIRED', 'STOPPED', 'NO_ACTION', 'EXECUTING', 'PROCESSING', 'RECOVERED', 'FAILED', 'REVERSED', 'ESCALATE', 'EXECUTION_UNKNOWN');
CREATE TYPE "Decision" AS ENUM ('AUTO_RETRY', 'APPROVAL_REQUIRED', 'ESCALATE', 'STOPPED', 'NO_ACTION');
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED');
CREATE TYPE "ExecutionOutcome" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "PayoutIncident" (
    "id" TEXT NOT NULL,
    "razorpayPayoutId" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "currentReason" TEXT,
    "beneficiaryRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "duplicateSuspected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayoutIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayoutEvent" (
    "id" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutIncidentId" TEXT,
    CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiAnalysis" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "modelRef" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "outputJson" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyDecision" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "proposedAction" TEXT NOT NULL,
    "finalDecision" "Decision" NOT NULL,
    "reasonsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PolicyDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB,
    "outcome" "ExecutionOutcome" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewTask" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "policyVersion" TEXT,
    "decision" TEXT,
    "amountPaise" INTEGER,
    "rationale" TEXT NOT NULL,
    "dataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyConfig" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "PolicyConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BatchRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cohortSize" INTEGER NOT NULL,
    "totalValueAtRiskPaise" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "BatchRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BatchResult" (
    "id" TEXT NOT NULL,
    "batchRunId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "finalState" TEXT NOT NULL,
    "recoveredValuePaise" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BatchResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutIncident_razorpayPayoutId_key" ON "PayoutIncident"("razorpayPayoutId");
CREATE UNIQUE INDEX "PayoutEvent_externalEventId_key" ON "PayoutEvent"("externalEventId");
CREATE UNIQUE INDEX "ActionExecution_idempotencyKey_key" ON "ActionExecution"("idempotencyKey");
CREATE UNIQUE INDEX "PolicyConfig_version_key" ON "PolicyConfig"("version");
CREATE UNIQUE INDEX "BatchResult_batchRunId_incidentId_key" ON "BatchResult"("batchRunId", "incidentId");

-- AddForeignKey
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payoutIncidentId_fkey" FOREIGN KEY ("payoutIncidentId") REFERENCES "PayoutIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BatchResult" ADD CONSTRAINT "BatchResult_batchRunId_fkey" FOREIGN KEY ("batchRunId") REFERENCES "BatchRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BatchResult" ADD CONSTRAINT "BatchResult_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PayoutIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
