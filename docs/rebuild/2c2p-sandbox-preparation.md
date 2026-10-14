# 2C2P Sandbox integration preparation

Source checkpoint: `ff19b854608e8167416d0a6a84e159803d9cfaec`,
`origin/rebuild-p0-p8`. This prepares a disabled provider adapter; it does not
deploy, provision credentials, create a provider plan or perform a payment.

## Prepared implementation

The dedicated staging checkout route verifies the Firebase signature, staging
project and current token expiry before binding a pending invoice to the UID.
The server generates the invoice and recurring prefix, fixes the price at
50 THB, and persists the request identity, expiry and first calendar period.
Clients cannot select UID, price, currency, period or redirect destinations.
Concurrent or retried checkout requests can claim the provider call only once.
An ambiguous token request is fenced rather than blindly retried.

Only the fixed Sandbox PaymentToken endpoint is used. Request and response
envelopes use compact HS256 JWTs. Responses are verified before selecting a
Hosted Payment Page URL, whose scheme, host, versioned path and fragment are
restricted to the documented sandbox page. The game never handles card input.
Provider tokens and URLs are not written to the invoice ledger or logs.
Only the authenticated checkout owner may receive the hosted URL.

Native backend notifications use their own verified JWT boundary, not the
generic webhook's signing format. Merchant, persisted invoice, exact price,
currency, transaction identities, status, date format and recurring identifiers
are checked. UID comes only from the invoice ledger. Card/customer metadata is
discarded. Receipts, transaction ownership, paid invoice and the first VIP
entitlement commit together in the same SQLite transaction.

Only documented payment success can grant access. Pending, failed, cancelled,
expired and unsupported responses do not grant it. Exact repeats are harmless;
conflicting transaction identity or metadata is rejected. Late non-success
notifications cannot erase a paid entitlement. Refund/chargeback codes are not
treated as a verified revocation contract.

The provider-specific first calendar entitlement uses the existing persistent
VIP tables and admission rules. The generic payment-event validator still
requires its original exact 30-day period. Its assertions, the 100-seat limit,
and all Free/Zone/movement/coin/Lucky Box behavior remain unchanged.

## Calendar scheduling and explicit limitations

The official request reference documents monthly scheduling through
`chargeOnDate`, with an explicit next-charge date. `recurringInterval` represents
days and is omitted. This preparation uses a restricted application calendar
policy: UTC anniversaries on days 1 through 28, with one civil calendar-month
increment. February, leap years and year rollover are tested. Days 29 through
31 fail closed; no provider rollover rule is invented.

Merchant billing timezone and callback date timezone are not inferred from
the documentation. Provider transaction dates are validated as civil date
strings, not used to invent a UTC payment timestamp. Freshness instead uses
the persisted short-lived invoice, immutable price/UID, token-attempt fence,
transaction ownership and receipts. JWT standard time claims are checked when
present but are not invented as mandatory provider fields.

The merchant must explicitly confirm its initial recurring sequence and invoice
correlation. The prepared initial path accepts only the stored initial invoice
and configured initial sequence. Unmatched renewal invoices cannot grant or
extend access. No native renewal billing engine, subscription replacement,
maintenance cancellation or refund operation is enabled. Expiration remains
enforced by the existing authoritative VIP checks.

The prepared request describes an indefinite RPP plan. Therefore it must remain
disabled until the merchant's renewal notifications, cleanup/cancellation path
and end-to-end sandbox lifecycle are verified. A local mock test or a public
demo merchant is not evidence of those capabilities.

## Activation requirements — variable names only

Existing staging bindings are retained. New server-only configuration names:

- `TWOC2P_SANDBOX_MERCHANT_ID`
- `TWOC2P_SANDBOX_SECRET_KEY`
- `TWOC2P_SANDBOX_ENABLED`
- `TWOC2P_SANDBOX_CHECKOUT_ENABLED`
- `TWOC2P_SANDBOX_BACKEND_ENABLED`
- `TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED`
- `TWOC2P_SANDBOX_E2E_VERIFIED`
- `TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED`
- `TWOC2P_SANDBOX_BILLING_TIMEZONE`
- `TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO`

These names are not added to deployment configuration by this change. Missing
or incomplete configuration disables mutation routes before any provider call.
Credentials must be provisioned privately on the staging Worker; they never
belong in browser assets, public manifests, Git, logs or chat. Activation flags
are operator attestations, not automatic capability detection or permission
to perform a payment. The existing browser purchase controls remain disabled.

Routes prepared: authenticated checkout/status, native backend notification,
and a non-authoritative browser return. The lifecycle route explicitly rejects
unsupported operations. Public requests cannot reach private coordinator paths.

## Remaining provider blockers

1. A dedicated Sandbox merchant and private credentials; confirmation of THB,
   Hosted Payment Page, current API version and monthly RPP capabilities.
2. Signed sandbox fixtures confirming initial invoice/sequence correlation
   (including exact sequence formatting), timezone, callback identities,
   reference-number uniqueness/reuse, notification retries and renewal ordering.
3. A verified renewal policy and native recurring maintenance/cancellation and
   refund integration, including exchanged keys and settlement requirements.
4. Sandbox end-to-end and cleanup verification, followed by explicit authority
   to configure/deploy staging and perform its first simulated transaction.

No payment actions may be enabled by this checkpoint. Neither a production
endpoint nor an actual Sandbox merchant was called during preparation.

## Verification of this preparation

- Full `npm test`: 489 active behavior/security tests plus 120 unchanged
  checkpoint/static tests passed; no failures, skips or cancellations.
  Both unchanged legacy multiplayer scenarios passed.
- The 86 new provider tests comprise 15 JWT, 41 persistent-store and 30 HTTP
  integration cases. They cover staging authentication and expiry across
  asynchronous calls, default-off gates, native signatures, immutable price
  and invoice ownership, transaction replay, rollback/restart, calendar expiry
  and rejection of the 101st VIP player.
- All 30 existing browser checks passed: eight default-client, eleven staging
  compatibility, six gameplay and five Zone-transition scenarios. No client,
  movement, Zone, coin or Lucky Box source was changed.
- Syntax, static checks, generated-client consistency, credential scanning,
  staging/Firebase structural validation and `git diff --check` passed.
- Pinned Wrangler 4.149.0 staging dry-run passed with credentials removed.
  No deployment was performed.
- Read-only Cloudflare inspection confirmed unchanged production metadata,
  deployed staging version and staging namespaces. No adapter configuration
  or credentials were added to live staging.

Provider requests and transactions in automated tests are local synthetic
fixtures. They are not evidence of an actual merchant's Sandbox capabilities.
The first provider-hosted Sandbox payment remains blocked by the requirements
above.

## Official references

- [Sandbox setup](https://developer.2c2p.com/docs/sandbox-setup)
- [PaymentToken API](https://developer.2c2p.com/docs/api-payment-token)
- [JWT signing and verification](https://developer.2c2p.com/docs/json-web-tokens-jwt)
- [PaymentToken request parameters](https://developer.2c2p.com/docs/api-payment-token-request-parameter)
- [PaymentToken response parameters](https://developer.2c2p.com/docs/api-payment-token-response-parameter)
- [Hosted redirect flow](https://developer.2c2p.com/docs/redirect-api-how-it-works)
- [Native backend notification](https://developer.2c2p.com/docs/api-payment-response-backend)
- [Backend parameters](https://developer.2c2p.com/docs/api-payment-response-back-end-parameter)
- [Recurring Payment Plan](https://developer.2c2p.com/docs/direct-api-rpp-recurring-payment-plan)
- [Payment status codes](https://developer.2c2p.com/docs/response-code-payment)
- [Recurring maintenance](https://developer.2c2p.com/docs/payment-maintenance-recurring-payment-guide)
- [Refund maintenance](https://developer.2c2p.com/docs/payment-maintenance-refund-guide)
