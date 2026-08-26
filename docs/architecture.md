# RecoveryOS architecture

The MVP is a modular TypeScript monolith. The API verifies and persists Razorpay events before any business processing. The worker executes delayed jobs from BullMQ. PostgreSQL contains the system-of-record state, raw events, decisions, action intents, reviews, batch outcomes, and append-only audit events.

```text
Razorpay webhook → signature verification → payout_event (deduplicated)
    → payout_incident → AI advisory → deterministic policy
    → stop / review task / durable action intent → BullMQ worker → Razorpay adapter
    → provider outcome or reconciliation → audit event and batch analytics
```

No OpenAI response can bypass `evaluatePolicy`. The worker re-checks the incident state before executing a pending intent.
