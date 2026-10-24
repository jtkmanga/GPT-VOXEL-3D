# Production release preparation

Status: **staging release gates passed; production deployment remains disabled**.

No account identifiers, tokens, merchant secrets, payment tokens, OTPs, or private
Firebase credentials belong in this file or Git history.

## Verified

- Development history reconciled with `main`.
- Gate 5 payment integration and manual 2C2P sandbox payment-to-entitlement path passed.
- Gate 6 bounded staging canary passed at 2 -> 5 -> 10 sessions.
- Gate 7 pre-review passed.
- P9 staging browser gate passed.
- Staging deployment is isolated from production.

## Production environment requirements

The `Production Readiness` workflow is check-only and contains no deploy command.

Set in the GitHub `production` environment:
- `PRODUCTION_PAYMENT_MODE`: use `disabled` until real merchant onboarding is complete.
- `PRODUCTION_TWOC2P_MERCHANT_ID`: secret.
- `PRODUCTION_TWOC2P_SECRET_KEY`: secret.
- `PRODUCTION_FIREBASE_PUBLIC_CONFIG`: variable.
- `PRODUCTION_APP_CHECK_SITE_KEY`: variable.
- `PRODUCTION_ALLOWED_ORIGIN`: variable.
- `PRODUCTION_WORKER_ORIGIN`: variable.

Never copy sandbox credentials into production.

## Release sequence

1. Configure production environment with payment mode `disabled`.
2. Run `Production Readiness` using `CHECK-PRODUCTION-ONLY`.
3. Resolve preflight failures without deploying.
4. Review release PR from `development/voxel-continuous` to `main`.
5. After merge, rerun Production Readiness on `main`.
6. Add real 2C2P production credentials only after merchant onboarding and approved callback URLs.
7. Production deploy requires a separate explicit owner-approved workflow.
