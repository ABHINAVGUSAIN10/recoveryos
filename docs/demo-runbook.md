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

## RazorpayX Test Mode automatic-retry demonstration

This is a separate, administrator-only path on the same presenter page. It deliberately leaves global `SIMULATION_MODE=true` while permitting one narrowly scoped provider call:

1. Configure a RazorpayX Test Mode key pair, the webhook secret, and the exact dedicated dummy fund account in `RAZORPAYX_TEST_DEMO_FUND_ACCOUNT_ID`.
2. Keep token authentication enabled and ensure the active autonomous amount cap is at least 1,000,000 paise.
3. Set `ENABLE_RAZORPAYX_TEST_DEMO=true` and restart the API.
4. Sign in to RecoveryOS with the administrator token and click **Run ₹10,000 RazorpayX test retry**.
5. Confirm the warning. RecoveryOS persists a clearly labelled controlled-failure seed, calls the hosted model, applies deterministic policy, and schedules a durable action.
6. The dedicated worker action locates a Test Mode balance with at least ₹10,000, verifies the configured fund account is active, and submits exactly 1,000,000 paise with an idempotency key.
7. Open RazorpayX in Test Mode. The payout appears there against the dummy balance and configured fund account. If Razorpay leaves it in `processing`, advance it to `processed` in the Test Mode dashboard.
8. The signed Razorpay webhook links the provider payout back to the original RecoveryOS incident. The presenter card changes to `RECOVERED` only after the terminal provider confirmation.

Be precise during the presentation: the initial temporary failure is a controlled demonstration seed; the recovery payout, its RazorpayX lifecycle, webhook, and dashboard/account-statement evidence are genuine Test Mode provider interactions. No real money moves. The endpoint refuses live credentials and applies an administrator gate, fixed amount, exact destination, cooldown, policy cap, duplicate controls, and durable idempotency.

For an ambiguous or timed-out execution, call `POST /api/v1/reconcile`. RecoveryOS queries the provider and records a terminal outcome when one is confirmed; it never creates another payout while the provider remains uncertain.

New batch metrics are immutable snapshots. Outcomes, intervention counts, safety decisions, policy/model/prompt versions, and cohort fingerprints are frozen when the batch completes. A retry that succeeds later belongs in a new outcome snapshot; it cannot rewrite prior evidence.

## Inbound revenue recovery demonstration

Set `ENABLE_REVENUE_DEMO=true`, keep simulation enabled, and configure the hosted model. After signing in, open **Revenue recovery** and click **Run inbound revenue experiment**.

The fixed eight-case cohort covers transient gateway failure, issuer soft decline, insufficient funds, high value, customer authentication, expired payment method, processing ambiguity, and fraud review. For every case, the model must cite persisted event IDs and propose a maximum three-step playbook. Deterministic policy authorizes only a bounded first action and blocks invented evidence, duplicate risk, consent violations, excessive attempts, and compliance signals.

The controlled worker creates a simulated `payment.captured` event only for scenarios whose outcome was declared `CAPTURED` in the fixed library before execution. Revenue is attributed only from that capture event. The resulting immutable experiment compares no action, a conservative rules-only baseline, and AI plus policy. The dashboard labels these as synthetic controlled outcomes; do not present them as production causal lift.

For a webhook demonstration, HMAC-SHA256-sign the exact JSON request body with `RAZORPAY_WEBHOOK_SECRET`, POST it to `/api/v1/webhooks/razorpay`, and then resend the event to demonstrate idempotency.

Run `pnpm acceptance:webhook` while the API is available to automate that signed delivery, duplicate replay, incident-ledger, and JSON/CSV batch-export check. The command is guarded to simulation mode. In token-auth mode it uses the configured viewer and operator tokens; `ACCEPTANCE_BASE_URL` selects the target API. The 100-case `pnpm simulate` command uses the deterministic classifier by default so it cannot consume hosted-model quota; pass `-- --live-ai` only for an intentional model experiment.

The provider-signed RazorpayX Test Mode gate was completed on 2026-08-26 with one ₹1 dummy payout. Razorpay returned `processing`, delivered `payout.initiated`, and returned the same payout ID when the identical idempotent request was replayed. After the payout was manually advanced in Test Mode, Razorpay delivered `payout.processed` and RecoveryOS updated the same incident to `RECOVERED`. Across both events it created no recovery attempt or execution. The redacted machine-readable record is in `docs/evidence/razorpayx-test-webhook-20260826.json`.

Do not disable simulation mode for a presentation. Production execution requires a separate review, complete payout-create context, Razorpay credentials, IP allowlisting, operator authentication, and audit-retention controls.
