# Operations and fault verification

## Readiness and queue evidence

- `GET /health` proves that the API process is serving requests.
- `GET /api/v1/ready` checks PostgreSQL and Redis without returning connection information.
- Authenticated `GET /api/v1/operations` adds BullMQ counts, simulation state, and the advisory provider/model/prompt identifiers used for audit evidence.
- Authenticated `GET /api/v1/revenue/operations` reports the inbound recovery guard, policy, hosted-model requirement, and fixed scenario catalogue.
- The dashboard **Operations** tab renders these same values; `ready` requires both PostgreSQL and Redis.

## Structured logs

Every completed API request emits a structured JSON payload containing `event`, `requestId`, `method`, `path`, `statusCode`, `durationMs`, `actorRole`, and `simulationMode`. The API accepts a safe `x-request-id` value or generates a UUID and echoes it in the response. It never logs the query string, request body, authorization header, database URL, Redis URL, or model/provider credentials. Provider failures pass through the shared redactor, and Razorpay response bodies are not copied into thrown errors.

The payout event ledger, payout audit log, inbound revenue event ledger, inbound audit log, payout batch results, and revenue experiment results have database triggers that reject updates and deletes. Treat schema-owner access as a break-glass privilege and monitor migration activity separately.

Production Compose rotates API, web, and proxy logs at five 10 MB files per container. Caddy access logs use JSON on standard output. Inspect the current deployment with:

```bash
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=200 api caddy
```

## Razorpay sandbox readiness

Keep `SIMULATION_MODE=true` while validating credentials and network access. Run `pnpm razorpay:readiness` locally or `pnpm --filter @recoveryos/api razorpay:readiness:prod` in the production API image. The command has an explicit read-only guard and calls only Razorpay's `GET /v1/banking_balances`; it discards the response body and prints only the HTTP status and readiness booleans. It never creates a payout or prints account balances or credentials.

Do not change to sandbox execution merely because credentials are present. Require a successful read-only authentication result, confirm the EC2 public IP is allowlisted in RazorpayX, and use a dedicated test-mode fund account plus a deliberately failed test payout for the first isolated recovery.

RazorpayX's documented test-mode rehearsal is:

1. Switch the RazorpayX Dashboard to **Test Mode** and add dummy test balance. Never transfer real money to the displayed test account.
2. Create a test contact and a fund account linked to that contact. Test-mode contacts, fund accounts, payouts, and balances are isolated from live mode.
3. Configure the test-mode webhook URL as `https://<your-domain>/api/v1/webhooks/razorpay`, use the deployment's existing webhook secret, and enable the payout lifecycle events available to the account (`payout.queued`, `payout.initiated`, `payout.processed`, and `payout.reversed`).
4. Keep RecoveryOS simulation enabled while confirming a provider-signed webhook is accepted and traceable. RazorpayX test payouts normally start in `processing`; move the payout to its next state manually in the Test Mode Dashboard.
5. Treat a `reversed` payout as terminal and non-retryable. An eligible recovery rehearsal requires Razorpay to confirm the original payout as `failed` with a transient retryable reason. Never fabricate that provider state or use a fresh idempotency key to bypass this guard.
6. Before the one-incident execution rehearsal, require an empty waiting/active/delayed/failed recovery queue, no incidents in `AUTO_RETRY`, `EXECUTING`, or `EXECUTION_UNKNOWN`, and save the original test payout and fund-account identifiers securely. Disable simulation only for the isolated rehearsal window, then restore it immediately afterward.

After the funded Test Mode preflight passes, `pnpm razorpay:sandbox-exercise` creates one ₹1 payout against an existing active VPA or bank fund account. The command refuses Live keys, requires `SIMULATION_MODE=true`, requires sufficient dummy balance, sets `queue_if_low_balance=false`, and uses a deterministic idempotency key. The expected Test Mode provider state is `processing`; this validates provider-signed webhook delivery and the non-terminal duplicate-prevention path without enabling RecoveryOS execution. Re-running the command repeats the identical request rather than creating a fresh-key duplicate.

The first provider-signed run, idempotent replay, and terminal `payout.processed` transition completed successfully on 2026-08-26. The same incident advanced from `PROCESSING` to `RECOVERED` with no RecoveryOS action execution. The redacted acceptance record is stored in `docs/evidence/razorpayx-test-webhook-20260826.json`.


Reference: [RazorpayX Test Mode](https://razorpay.com/docs/x/dashboard/test-mode/) and [RazorpayX Payout APIs](https://razorpay.com/docs/api/x/).

## Incident query contract

`GET /api/v1/incidents` returns `{ items, total, page, pageSize, totalPages }`. Supported parameters are:

- `page`: positive page number.
- `pageSize`: 1–100; defaults to 20.
- `search`: case-insensitive payout ID or failure-reason search.
- `status`: a valid incident status.
- `reviewRequired=true`: incidents with an open review task only.

## Automated fault coverage

The regression suite proves the following fail-closed behavior:

- AI timeout or malformed structured output receives one bounded retry, then produces `UNKNOWN / STOP` and no financial authorization.
- Provider network uncertainty becomes `EXECUTION_UNKNOWN`; the worker does not submit an additional payout.
- A worker restart requeues a durable unclaimed action intent. An action found in progress becomes `EXECUTION_UNKNOWN` and is reconciled without another provider submission.
- Concurrent workers atomically claim an incident, and execution-result recording is idempotent.
- Concurrent duplicate webhook deliveries converge on the unique event ledger and return the original incident without a second analysis.
- A provider-confirmed terminal retry failure is recorded, increments the attempt count, and enters a fresh AI + deterministic-policy evaluation before any new delayed action intent can exist. A request-level failure is recorded once and the worker job fails visibly; BullMQ never blindly repeats the financial call.
- Reconciliation keeps provider `processing` cases blocked until a terminal status is confirmed.
- Database or Redis readiness failure produces `degraded` operational state without leaking a credential.
- Provider error bodies and recognized secrets are excluded or redacted from errors and logs.
- Missing or invalid Razorpay webhook signatures return unauthorized semantics; a valid exact-body HMAC is accepted.

Run all checks with `pnpm test`, `pnpm build`, and `pnpm ai:evaluate`. The ordinary evaluation command always disables provider access so it remains reproducible and cost-free even when a key exists. A live model gate additionally requires `pnpm ai:evaluate -- --require-live`.
Use `--case=<case-name>` only for a focused diagnostic probe; acceptance still requires the complete six-case run.

The production classifier uses Groq GPT-OSS 120B with low reasoning effort and strict JSON Schema. `AI_THINKING_MODE=disabled` remains explicit for provider portability. This bounded classification task benefits from lower latency, lower reasoning-token use, and schema-constrained output. Any future reasoning-mode experiment must use a separate evaluation cohort and must not change the deterministic authorization boundary.

Run the six-case smoke evaluation with `pnpm ai:evaluate -- --require-live`. Run the fixed 50-case safety cohort with `pnpm ai:evaluate -- --require-live --cohort=full --summary-only`; compact output retains aggregate counts and any failed cases. Live Groq evaluations default to a nine-second minimum interval between request starts and honor bounded `Retry-After` delays on HTTP 429 responses. Override the pacing only for a verified account limit with `--request-interval-ms=<milliseconds>`.

## Operator response

1. If PostgreSQL is degraded, stop approvals and retries, check Neon status and connection limits, and preserve the existing incident/action state.
2. If Redis is degraded, the API remains the system of record but delayed execution pauses; inspect the private `redis` container and volume, restore Redis, then inspect waiting, delayed, and failed counts before resuming. Application startup requeues durable pending action intents from PostgreSQL.
3. If AI is unavailable, accept the fail-closed advisory and route the incident to human review. Do not weaken policy to compensate.
4. If Razorpay execution is uncertain, leave the incident `EXECUTION_UNKNOWN` and run authenticated reconciliation. Never create a fresh-key payout to test the connection. Reconciliation fetches a known recovery payout or repeats the identical create request with its original idempotency key.
5. Correlate proxy and API logs using `x-request-id`, then record any manual decision in the incident audit trail.

## Live demo controls

`POST /api/v1/demo-runs` requires an operator role, `ENABLE_LIVE_DEMO=true`, `SIMULATION_MODE=true`, a configured hosted AI provider, PostgreSQL, and Redis. The API accepts only the fixed scenario allowlist and permits one run at a time per API process. It generates all payout and event identifiers server-side, never accepts fund-account details, never invokes live Razorpay execution, and verifies an immediate duplicate replay against the event ledger.

Disable `ENABLE_LIVE_DEMO` after the presentation if interactive scenario generation is no longer required. Existing demo incidents, analyses, decisions, actions, batches, and audit events remain available as evidence.

CI additionally validates the production Compose and Caddy configurations and builds both runtime images on Ubuntu. Local Windows development does not need Docker; the deployment-package job provides the Linux/container gate once the repository is pushed.
