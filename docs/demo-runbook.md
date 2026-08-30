# Demo runbook

1. Copy `.env.example` to `.env` and keep `SIMULATION_MODE=true`.
   Keep `AUTH_MODE=disabled` for the local demo, or set it to `token` and configure viewer/operator/admin bearer tokens for an authorization demonstration.
2. Start PostgreSQL and Redis with `docker compose up -d postgres redis`.
3. Install packages, generate the Prisma client, and push the schema.
4. Run `pnpm simulate` to create the fixed 100-case cohort.
5. Start both applications using `pnpm dev`.
6. In **Incidents**, inspect a transient incident, a beneficiary escalation, and a processing stop. Each case exposes the AI advisory, policy rationale, and audit chain.
7. In **Batch evidence**, select the seeded cohort, verify that the displayed totals trace to its cases, and download both CSV and JSON evidence.
8. In **Policy controls**, review the active thresholds. Do not activate a change during the demonstration unless the version identifier is also changed.

## Interactive live-AI demonstration

Set `ENABLE_LIVE_DEMO=true`, keep `SIMULATION_MODE=true`, configure the hosted AI provider, and restart the API. In the dashboard **Live demo** page, confirm that simulation, Groq, PostgreSQL, and Redis all report ready. An operator or administrator can run an individual scenario or the complete four-case set:

- A ₹5,000 temporary technical failure produces an AI retry proposal and an autonomous policy-authorized recovery.
- A ₹25,000 temporary technical failure receives the same AI proposal but is held for approval by the amount cap.
- A closed beneficiary account is escalated with an open review task and no payout action.
- A processing payout is blocked from retry and kept on the reconciliation path.

Each scenario uses a unique synthetic payout/event identifier, replays the same event to prove webhook-ledger deduplication, and appears in the normal incident queue. The run also creates a `Live AI Demo <run-id>` batch for evidence export. The presenter page polls normal incident and batch endpoints, so it renders only persisted database/audit state.

For the autonomous case, `DEMO_RETRY_DELAY_SECONDS` compresses the execution wait only in simulation mode. The policy's original delay remains unchanged and both values are written to `ACTION_REQUESTED`. Never describe the simulated provider execution as a real-money payout; the live elements are the hosted AI call, deterministic policy, PostgreSQL transaction, Redis/BullMQ scheduling, worker processing, and dashboard updates.

For an ambiguous or timed-out execution, call `POST /api/v1/reconcile`. RecoveryOS queries the provider and records a terminal outcome when one is confirmed; it never creates another payout while the provider remains uncertain.

Batch metrics are derived from the current incident outcomes rather than the original batch snapshots. This ensures a retry that later succeeds is reflected in recovered value while preserving the original cohort and value-at-risk denominator.

For a webhook demonstration, HMAC-SHA256-sign the exact JSON request body with `RAZORPAY_WEBHOOK_SECRET`, POST it to `/api/v1/webhooks/razorpay`, and then resend the event to demonstrate idempotency.

Run `pnpm acceptance:webhook` while the API is available to automate that signed delivery, duplicate replay, incident-ledger, and JSON/CSV batch-export check. The command is guarded to simulation mode. In token-auth mode it uses the configured viewer and operator tokens; `ACCEPTANCE_BASE_URL` selects the target API. The 100-case `pnpm simulate` command uses the deterministic classifier by default so it cannot consume hosted-model quota; pass `-- --live-ai` only for an intentional model experiment.

The provider-signed RazorpayX Test Mode gate was completed on 2026-08-26 with one ₹1 dummy payout. Razorpay returned `processing`, delivered `payout.initiated`, and returned the same payout ID when the identical idempotent request was replayed. After the payout was manually advanced in Test Mode, Razorpay delivered `payout.processed` and RecoveryOS updated the same incident to `RECOVERED`. Across both events it created no recovery attempt or execution. The redacted machine-readable record is in `docs/evidence/razorpayx-test-webhook-20260826.json`.

Do not disable simulation mode for a presentation. Production execution requires a separate review, complete payout-create context, Razorpay credentials, IP allowlisting, operator authentication, and audit-retention controls.
