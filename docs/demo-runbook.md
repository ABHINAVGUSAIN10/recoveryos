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

For an ambiguous or timed-out execution, call `POST /api/v1/reconcile`. RecoveryOS queries the provider and records a terminal outcome when one is confirmed; it never creates another payout while the provider remains uncertain.

Batch metrics are derived from the current incident outcomes rather than the original batch snapshots. This ensures a retry that later succeeds is reflected in recovered value while preserving the original cohort and value-at-risk denominator.

For a webhook demonstration, HMAC-SHA256-sign the exact JSON request body with `RAZORPAY_WEBHOOK_SECRET`, POST it to `/api/v1/webhooks/razorpay`, and then resend the event to demonstrate idempotency.

Run `pnpm acceptance:webhook` while the API is available to automate that signed delivery, duplicate replay, incident-ledger, and JSON/CSV batch-export check. The command is guarded to simulation mode. In token-auth mode it uses the configured viewer and operator tokens; `ACCEPTANCE_BASE_URL` selects the target API. The 100-case `pnpm simulate` command uses the deterministic classifier by default so it cannot consume hosted-model quota; pass `-- --live-ai` only for an intentional model experiment.

The provider-signed RazorpayX Test Mode gate was completed on 2026-08-26 with one ₹1 dummy payout. Razorpay returned `processing`, delivered `payout.initiated`, and returned the same payout ID when the identical idempotent request was replayed. After the payout was manually advanced in Test Mode, Razorpay delivered `payout.processed` and RecoveryOS updated the same incident to `RECOVERED`. Across both events it created no recovery attempt or execution. The redacted machine-readable record is in `docs/evidence/razorpayx-test-webhook-20260826.json`.

Do not disable simulation mode for a presentation. Production execution requires a separate review, complete payout-create context, Razorpay credentials, IP allowlisting, operator authentication, and audit-retention controls.
