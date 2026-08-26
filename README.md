# RecoveryOS

Simulator-first recovery control plane for payout incidents. AI can classify and recommend; deterministic policy authorizes; execution is disabled by default unless explicitly configured.

## Local setup

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL and Redis: `docker compose up -d`.
3. Install packages: `pnpm install`.
4. Generate and apply the schema: `pnpm db:generate && pnpm db:push`.
5. Seed a reproducible demonstration batch: `pnpm simulate`.
6. Start applications: `pnpm dev`.

The dashboard is at `http://localhost:3000`; the API is at `http://localhost:3001`.

### Windows setup without Docker or WSL

The applications run natively on Windows. A hosted PostgreSQL database and an Upstash Redis database can replace the local infrastructure containers:

1. Create a hosted PostgreSQL development database and copy its TLS connection string into `DATABASE_URL`. For Neon, keep `sslmode=require` in the URL.
2. Create an Upstash Redis database and copy the TLS Redis URL—not the REST URL—into `REDIS_URL`. It has the form `rediss://default:<password>@<host>:6379`.
3. Keep only synthetic development data in these services and never commit `.env`.
4. Run `pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm db:push`, `pnpm simulate`, and `pnpm dev` from PowerShell.

Upstash supports BullMQ over its Redis protocol. BullMQ polls Redis while idle, so monitor command usage and pause the local API when it is not being used.

## Operator workflow

- **Incidents** shows the recovery queue, AI evidence, deterministic decisions, review controls, and the append-only audit timeline.
- **Batch evidence** creates or opens evaluation cohorts, recomputes metrics from current incident outcomes, and exports traceable CSV or JSON evidence.
- **Policy controls** activates a versioned retry limit, autonomous amount cap, and minimum delay. Use a new version identifier for each material change.
- **Operations** reports credential-free Neon and Upstash readiness, BullMQ job counts, simulation safety, and the configured advisory provider/model/prompt version.

Batch reporting separates gross recovery from policy-eligible recovery. The SRD recovery target is evaluated using `recovered eligible value / eligible value`; already-processed payouts are included in gross recovery but excluded from that eligible denominator. Pending recovery, protected, and manual-review values are also reported in integer paise.

Batch evidence endpoints are `GET /api/v1/batches`, `GET /api/v1/batches/:id`, and the `.csv` / `.json` export variants under `/api/v1/batches/:id/export`.
Operational endpoints are public `GET /api/v1/ready` for a minimal readiness result and authenticated `GET /api/v1/operations` for service, queue, simulation, and advisory metadata. Neither endpoint returns credentials or connection details.

Incident listing supports bounded server-side pagination and filtering: `page`, `pageSize` (maximum 100), `search`, `status`, and `reviewRequired=true` on `GET /api/v1/incidents`.

Structured request logs include a generated or caller-supplied `x-request-id`, method, path, response status, duration, actor role, and simulation state. Query strings, request bodies, authorization headers, and credentials are excluded. Set `LOG_REQUESTS=false` only when local noise needs to be reduced.

## Authentication modes

- `AUTH_MODE=disabled` is the default for local simulation. Requests receive a synthetic admin actor so the demo works without credentials.
- `AUTH_MODE=token` requires opaque bearer tokens. Configure `VIEWER_API_TOKEN`, `OPERATOR_API_TOKEN`, and `ADMIN_API_TOKEN` with long independently generated values.
- Viewers can read incidents, batches, exports, and policy. Operators can also approve/reject and create batches. Administrators can additionally activate policy and run reconciliation.

The dashboard stores a supplied token in browser session storage only. Keep token mode behind TLS and never put these values in source control.

## External setup checkpoints

- **Now:** PostgreSQL and Redis are required to run the complete app. Docker Compose is optional; hosted TLS connections work for Windows development without WSL.
- **AI integration:** `AI_API_KEY` is optional. Without it, the deterministic simulator classifier is used. Groq GPT-OSS 120B is the example hosted provider; other OpenAI-compatible endpoints remain configurable through environment variables.
- **Razorpay integration:** test credentials and a webhook secret are needed for sandbox webhook/API testing. Real execution remains fail-closed.
- **Deployment:** an AWS account and EC2/Elastic IP are not needed until P7 deployment hardening.

Run `pnpm ai:evaluate` for the fixed offline advisory suite; this command deliberately ignores a configured key and never contacts the provider. After privately adding `AI_API_KEY` to `.env`, run `pnpm ai:evaluate -- --require-live` to require live provider responses; never paste that key into chat, source control, screenshots, or logs.

The hardened hosted-demo procedure is documented in [docs/deployment.md](docs/deployment.md). Operational checks and fault coverage are documented in [docs/operations.md](docs/operations.md).

## Safety model

- All monetary values are integer paise.
- Duplicate webhooks are no-ops.
- `processing`, unknown, duplicate-suspected, and exhausted incidents cannot be auto-retried.
- A Razorpay timeout becomes `EXECUTION_UNKNOWN`; reconciliation must occur before any new payout request.
- Set `SIMULATION_MODE=false` only after credentials, allowlisting, roles, and an explicit production review are in place.
