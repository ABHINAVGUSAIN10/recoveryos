# RecoveryOS architecture

The MVP is a modular TypeScript monolith. The API verifies and persists Razorpay events before any business processing. The worker executes delayed jobs from BullMQ. PostgreSQL contains the system-of-record state, raw events, decisions, action intents, reviews, batch outcomes, and append-only audit events.

```text
Signed Razorpay webhook
    ├─ payout.*  → payout incident → AI classification → payout policy
    │             → stop / remediation / approval / durable retry → RazorpayX
    └─ payment.* → inbound revenue incident + event timeline
                  → AI diagnosis + cited bounded playbook → revenue policy
                  → stop / human gate / durable first action
                  → captured-payment event → attributed recovered revenue
```

The payout and inbound-revenue modules use separate domain tables and queues because a successful outbound disbursement is not treated as recovered revenue. AI output is advisory in both modules. `evaluatePolicy` and `evaluateRevenuePolicy` are deterministic authorization boundaries, and workers re-check durable state before execution.

New payout batches and revenue experiments freeze incident outcomes, policy/model/prompt versions, cohort fingerprints, intervention counts, safety decisions, baselines, and metrics. PostgreSQL triggers reject updates or deletes to raw event ledgers, audit events, completed experiment records, and batch-result snapshots.
