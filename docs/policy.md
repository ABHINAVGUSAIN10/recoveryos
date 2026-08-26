# Recovery policy v1.0.0

| Condition | Decision |
| --- | --- |
| Payout is processing, ambiguous, unknown, duplicate-suspected, or retry-exhausted | Block a new payout; retain it for reconciliation or human review |
| Original provider payout is not confirmed `failed` | Do not create a recovery payout; active, reversed, rejected, cancelled, and unknown states remain blocked |
| Invalid, closed, frozen, or dormant beneficiary | Escalate |
| Amount is above ₹10,000 | Require human approval |
| Bounded transient technical failure | Auto-retry after at least 30 minutes |
| Already processed payout | No action |

The policy is versioned in PostgreSQL. Its default is intentionally conservative: two automatic attempts and an autonomous amount limit of 1,000,000 paise. If the policy cannot be evaluated, the system fails closed.

Razorpay recovery uses a deterministic 35-character idempotency key and repeats the identical body after an ambiguous response. A new payout is created only after the original is confirmed `failed`. Recovery references link signed provider webhooks to the original incident timeline, and low-balance queueing is explicitly disabled.
