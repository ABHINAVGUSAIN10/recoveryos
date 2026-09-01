# Inbound revenue recovery

RecoveryOS separates incoming revenue from outbound payout operations. The inbound module accepts signed `payment.failed` and `payment.captured` events, stores a bounded timeline, asks the hosted model for a cited diagnosis and playbook, applies deterministic authorization, and attributes recovered revenue only after a linked capture.

## AI contract

The model receives amount, payment method, failure code, consent state, attempt count, and up to twenty persisted timeline events. Its strict output contains a category, confidence, diagnosis, exact event citations, a first recommended action, a delay, at most three playbook steps, and bounded risk flags. An invented event citation fails closed.

## Controlled experiment

`POST /api/v1/revenue/demo-runs` creates a fixed eight-case synthetic cohort. The scenario library declares outcomes before execution. The experiment stores immutable result snapshots and compares:

- no recovery action;
- a conservative rules-only baseline;
- AI recommendation plus deterministic policy.

The comparison demonstrates software behavior and attribution mechanics, not production causal lift. A production evaluation requires a consented holdout or randomized rollout, real captured-payment outcomes, confidence calibration, and statistical uncertainty.

## Endpoints

- `GET /api/v1/revenue/operations`
- `GET /api/v1/revenue/incidents`
- `GET /api/v1/revenue/incidents/:id`
- `POST /api/v1/revenue/incidents/:id/approve`
- `POST /api/v1/revenue/incidents/:id/reject`
- `POST /api/v1/revenue/demo-runs`
- `GET /api/v1/revenue/experiments`
- `GET /api/v1/revenue/experiments/:id`

Live customer charging and outbound messaging are deliberately not implemented. Those require mandate/token support, customer consent enforcement, provider-specific payment creation, communication templates, rate limits, and a separate production review.
