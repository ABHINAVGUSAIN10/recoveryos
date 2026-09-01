# Recovery policy v1.0.0

| Condition | Decision |
| --- | --- |
| Payout is processing, ambiguous, unknown, duplicate-suspected, or retry-exhausted | Block a new payout; retain it for reconciliation or human review |
| Original provider payout is not confirmed `failed` | Do not create a recovery payout; active, reversed, rejected, cancelled, and unknown states remain blocked |
| Invalid, closed, frozen, or dormant beneficiary | Escalate to remediation; direct retry approval is prohibited |
| Amount is above ₹10,000 | Require human approval |
| Bounded transient technical failure | Auto-retry after at least 30 minutes |
| Already processed payout | No action |

The policy is versioned in PostgreSQL. Its default is intentionally conservative: two automatic attempts and an autonomous amount limit of 1,000,000 paise. If the policy cannot be evaluated, the system fails closed.

Razorpay recovery uses a deterministic 35-character idempotency key and repeats the identical body after an ambiguous response. A new payout is created only after the original is confirmed `failed`. Recovery references link signed provider webhooks to the original incident timeline, and low-balance queueing is explicitly disabled.

An `ESCALATE` review is not an approval. A validated replacement beneficiary and remediation note must be recorded first. The system then opens a new `RETRY_APPROVAL` task, and maker-checker control requires a different actor to approve it.

## Inbound revenue policy v1.0.0

| Condition | Decision |
| --- | --- |
| Processing, pending, duplicate-prone, or AI-cited evidence not present in the persisted timeline | Stop |
| Fraud/compliance signal or invalid payment method | Escalate; no collection action |
| Unknown diagnosis or confidence below 70% | Stop |
| Missing customer-contact consent | Prohibit outreach and payment-link actions |
| Customer-facing action | Require human approval |
| More than two automatic attempts or amount above ₹10,000 | Stop or require approval |
| Timeline-grounded transient provider, soft decline, or insufficient-funds case | Authorize one smart retry after the policy delay |

The model may propose up to three playbook steps, but policy authorizes at most the first bounded action. Recovered revenue is recorded only after a later captured-payment event is linked to the incident.
