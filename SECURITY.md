# Security policy

## Reporting a vulnerability

Do not open a public issue containing credentials, personal data, payout identifiers, or exploit details. Contact the repository owner privately through their GitHub profile with a concise description and reproduction steps.

## Deployment safety

RecoveryOS is simulator-first. Keep `SIMULATION_MODE=true` unless a separate production-readiness review has approved provider credentials, network allowlisting, operator authentication, reconciliation, monitoring, and incident response.

Never commit `.env` files, API keys, bearer tokens, webhook secrets, database URLs, Redis URLs, private keys, or unredacted provider evidence. The committed environment files are examples only.
