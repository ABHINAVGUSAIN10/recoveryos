# EC2 hosted-demo deployment

## Example deployment target

- Domain: `recovery.example.com`
- Public address: an Elastic IP allocated to your EC2 instance
- Public URL: `https://recovery.example.com`

The DNS A record must point to the Elastic IP, and the EC2 security group must allow inbound TCP traffic on ports 80 and 443 before Caddy can issue and renew the TLS certificate.

This procedure deploys the simulator-first application to one Ubuntu EC2 instance while continuing to use hosted Neon PostgreSQL and Upstash Redis. Only Caddy exposes host ports; the API and web containers are reachable through the private Compose network. Caddy obtains and renews TLS certificates after the domain resolves to the instance.

## Required accounts and values

- An AWS account with permission to create EC2, a security group, and an Elastic IP.
- A domain or subdomain whose DNS `A` record you can edit.
- The existing Neon PostgreSQL TLS URL and Upstash Redis `rediss://` URL.
- Three independent random bearer tokens and a random Razorpay webhook secret.
- A supported OpenAI-compatible provider key only when live advisory evaluation is desired. It is not required for deployment.

Keep `SIMULATION_MODE=true`. Razorpay live payout credentials are deliberately unnecessary for the hosted demonstration.

## 1. Create the host

1. Launch a current Ubuntu LTS EC2 instance in a public subnet. A small general-purpose instance is sufficient for the single-user demo; resize after observing memory and CPU.
2. Allocate and associate an Elastic IP, then point the domain `A` record to it. AWS charges for public IPv4 addresses, including associated Elastic IPs, so release it when the deployment is retired.
3. Configure the security group with TCP 80 and 443 from the internet. Allow TCP 22 only from your current public IP; do not expose 3000, 3001, 5432, or 6379.
4. Connect through SSH using the instance key pair.

AWS references: [Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html) and [web-server security-group rules](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html).

## 2. Install Docker

Install Docker Engine and the Compose plugin from Docker's official Ubuntu apt repository, then verify `sudo docker run hello-world`. Follow the current [Docker Engine on Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) rather than a copied convenience script. Optionally add the deployment user to the `docker` group, sign out, and sign in again; membership is effectively root-equivalent and should be limited.

## 3. Transfer and configure the application

Transfer a reviewed Git commit or release archive to `/opt/recoveryos`; do not deploy an untracked working directory. In that directory:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Edit `.env.production` privately:

- Set `RECOVERYOS_DOMAIN` and the matching `https://...` value in `ALLOWED_ORIGINS`.
- Set the Neon `DATABASE_URL` and Upstash `REDIS_URL`.
- Generate each token and the webhook secret independently, for example with `openssl rand -hex 32`.
- Leave `SIMULATION_MODE=true`.
- Leave `AI_API_KEY` empty until a live advisory evaluation is scheduled.

Startup validation fails the API if production authentication, explicit origins, or webhook signing is unsafe. It also refuses live payout execution without Razorpay credentials and token authentication.

## 4. Apply the database migration

Prefer a fresh Neon production branch/database. Build the API image and apply committed migrations before starting services:

```bash
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml run --rm api pnpm --filter @recoveryos/api prisma:migrate:deploy
```

The existing development Neon database was originally created with `db push`. Do not run `migrate deploy` against a populated unbaselined database. Either deploy to a fresh branch or compare the schema, take a backup, and explicitly baseline the initial migration before using it.

## 5. Start and verify

```bash
docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=200 api caddy
```

Verify:

1. `https://<domain>/health` returns API health.
2. `https://<domain>/api/v1/ready` reports `ready`.
3. The dashboard requires a bearer token and displays the simulation banner.
4. The Operations tab reports PostgreSQL, Redis, queue counts, simulation enabled, and the configured advisory mode.
5. Ports 3000 and 3001 are not reachable directly from the internet.

Caddy's reverse-proxy behavior is documented in the official [reverse_proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## 6. Seed only when needed

For an empty demonstration database, seed the fixed cohort once:

```bash
docker compose -f docker-compose.production.yml run --rm api pnpm --filter @recoveryos/api simulate:prod
```

Re-running the simulator is deterministic and updates its known synthetic IDs, but do not mix the cohort with real payout data.

## 7. Update, rollback, and retire

Before an update, export batch evidence and take a Neon restore point/branch. Deploy only a reviewed commit, rebuild, apply migrations, and restart. If application behavior regresses, restore the previous commit/image; never reverse a database migration without a tested corrective migration or database restore.

On application startup, RecoveryOS scans durable pending action intents. An unclaimed intent is restored to BullMQ with its persisted execution time. An intent found in progress is treated as execution-unknown and routed to provider reconciliation rather than submitted again.

When retiring the demo, stop the Compose stack, archive required audit evidence, remove secrets from the host, terminate the EC2 instance, and release the Elastic IP if it is no longer required.
