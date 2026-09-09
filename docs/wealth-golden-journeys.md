# Wealth Golden Journeys

## Scope

- WS-003: existing Client account -> one subscription -> unique Admin subscription approval -> clean Client login -> original INV, position and payment balance verification.
- WR-003 is independent of WS-003. As of 2026-09-08 the user has paused redemption because the Admin redemption list has a product bug. Do not visit that Admin tab, submit a redemption, or assume a new subscription is immediately redeemable.
- No registration, deposit, balance bootstrap or replacement order is included.

## Subscription Safety

- `npm run test:wealth:subscribe:approve` uses Playwright Runner, workers=1, retries=0, repeatEach=1. Mutation requires an authorized named `WEALTH_RUN_ID`, `WEALTH_AUTHORIZED_AMOUNT`, the configured `WEALTH_TEST_USERNAME` matching `CLIENT_USERNAME`, and temporary money/Admin switches. The actual amount must equal the authorized amount before any submission. The command never edits `.env`.
- Persist separate `.flow-state/wealth-subscription` and future redemption state. An attempted submission blocks another fresh order. `WEALTH_RESUME=true` only resumes the named existing Run; attempted Client/security/Admin actions are never repeated.
- Shared `SecurityKeyDialog` reads only `CLIENT_SECURITY_KEY`. Trace/video are disabled in the money case to avoid retaining credential-bearing traffic. Reports retain masked business fields and safe network metadata, never bodies or headers.
- Admin list search waits for the real `/admin-api/operation/invest/subscription/list` response. The original INV must be unique; detail rechecks customer, product, complete currency, exact amount, purchase account, fee and creation window before approval.
- Admin `批准认购` is a final action and may have no second confirmation. Never click it as Recon.

## Oracles

Primary: one real Client INV; exact Admin candidate and detail; Admin approval; same Client order in a success state; matching purchase account/product/amount/currency; observable position principal increase; payment balance change matching the real summary and fee.

Keep available, frozen and total balances as separate snapshots before submission, after submission and after approval. Existing frozen funds must not be mistaken for this order's debit. Use Decimal without tolerance or an assumed debit time.

Secondary: nonessential notification and yield presentation only. Missing product or order evidence is not replaced by HTTP 200 or a toast.

## Recon Corrections

- Holdings are cards and are loaded by `/api/invest/positions-list`, not table rows. Wait for the response before counting.
- Parse the complete asset code: USDT must not be truncated to USD.
- Admin USD detail values use `US$`; amounts must be parsed numerically rather than compared to display strings.
- Never treat the Admin list `main` element as the order detail.

## Execution

2026-09-08: subscription read-only preflight passed (history Run 661). Named proposed Run `WS003-20260908-143500` selects a deterministic 1.43 USD amount above the observed 1 USD minimum. The execution permission reviewer rejected launching the money command pending explicit named-Run authorization. The command did not start: subscription/security/Admin actions remain zero and no Run state or order was created. Do not present this as a completed E2E. Redemption is paused by the user; no redemption mutation performed.

Typecheck passed. `npm run test:wealth:unit`: 4/4 passed (Run 662), covering full asset codes, reproducible amount selection, original-order exclusion, detail identity and candidate uniqueness. These are not money E2E results.

### Authorized Execution: Passed

The user subsequently explicitly authorized `WS003-20260908-143500`: one 1.43 USD subscription and one matching Admin approval. It ran once on 2026-09-08, without a retry or redemption action.

- Existing user: `per***@mediaholy.com`; no new user, deposit or balance bootstrap.
- Product: Galaxy Digital Lending, ID 1; purchase account: 香港账户; amount 1.43 USD; fee 0 USD.
- Client business reference: `INV-****714a`; created 2026-09-08 14:51:27 (Asia/Shanghai).
- Confirmation/security verification/Admin approval: 1/1/1. Admin candidateCount=1 and all detail fingerprint stages matched.
- Admin final state: 已通过; clean-login Client final state: 持有中. Position principal increased by 1.43 USD.

| Snapshot (USD) | Available | Frozen | Total |
| --- | --- | --- | --- |
| Before submission | 98980.06 | 192.82 | 99172.88 |
| Submitted, before approval | 98978.63 | 194.25 | 99172.88 |
| After approval | 98978.63 | 192.82 | 99171.45 |

Actual rule observed: submission freezes 1.43 USD; approval debits the same 1.43 USD and releases this order's freeze. Existing frozen funds remain unchanged. Decimal balance and position assertions passed.

- Business result: PASS; all 5 Primary Oracles passed, no warning/manual review.
- Resume stage: COMPLETED; safe rerun: No. The original transaction already succeeded.
- WS-003 capability: Ready / Real E2E Verified; default regression excluded.
- Money/Admin process permissions were removed in `finally`; `.env` money/Admin/Client mutation defaults remain false.
- Immutable report: [Run 663](../reports/business/history/2026-09-08_14-52-03-bf1134f3/report.html). Runner result 2/2 includes authentication setup plus WS-003.
- WR remains paused. No redemption was submitted or approved.

## Files Changed

### WS-002 Subscription Rejection (2026-09-09)

This independent Negative Journey does not replace or rerun the completed WS-003 approval. After the explicitly authorized execution below, capability is **Ready / Real E2E Verified: Yes / Business Result: Passed / Automation Result: Passed**. Default regression remains excluded.

- Proposed Run: `WS002-20260909-173401`; existing user `per***@mediaholy.com`.
- Actual read-only preflight: Client KYC approved, Client/Admin authenticated, Galaxy Digital Lending / product 1 purchasable; Hong Kong USD minimum 1, planned deterministic amount **1.60 USD**, displayed fee **0 USD**.
- Before snapshot: available **98978.63**, frozen **192.82**, total **99171.45 USD**. These are preflight observations, not an immutable future execution baseline: the real Run reads them again immediately before submitting.
- Eight rendered position cards matched the read-only positions response total. Existing Galaxy principal is **1.43 USD**, active count 1. Rejection must preserve this holding, not remove it or require zero historical holdings.
- At preflight there was no pending sample for a live rejection-form Dry Run. Loaded Admin UI code confirmed: `拒绝` only opens a local reason form; a nonempty reason enables `确认拒绝`, which calls the reject action. Local DOM tests verified this contract and the pre-click persistence guard; the later authorized Run also verified it on the real new order.
- Read-only historical INV matching was already verified by WS-003. Preflight created no INV; the authorized WS-002 then independently passed every candidate/detail check on its own INV below.
- Reason: `AUTOMATION INVESTMENT SUBSCRIPTION REJECTION TEST <runId>`; check the actual field length, never silently change the reason after submission.
- Preflight report: [Read-only evidence](../reports/business/history/2026-09-09_17-41-10-3e4077ad/report.html). Earlier failed inspection reports remain intact; no money mutation occurred in any inspection.

State machine:

```text
INVESTMENT_READY -> SUBSCRIPTION_SUBMITTED -> FUNDS_RESERVED_OR_DEDUCTED
-> ADMIN_SUBSCRIPTION_FOUND -> ADMIN_REJECTION_ATTEMPTED -> ADMIN_SUBSCRIPTION_REJECTED
-> CLIENT_SUBSCRIPTION_REJECTED -> FUNDS_RESTORED -> NO_ACTIVE_HOLDING_VERIFIED
```

Primary Oracles: unique original INV; exact Admin customer/product/account/currency/amount/fee/time match; one confirmed rejection; same Client INV rejected (matching reason when displayed); available/frozen/total each restored; no additional effective holding count or principal; no duplicate subscription. A known non-restored balance or rejected-but-active investment is a failure, not a mere display warning. An unknown outcome after a final click requires read-only reconciliation and no repeated click.

The three financial columns are actually present on this account. Read actual values at before/after-submit/after-reject without inferring whether submission freezes or deducts; historical frozen funds must not be released. Position comparisons use principal, not changing market value/yield, and reject incomplete position coverage.

Commands:

- Safe: `npm run test:wealth:subscribe:reject:preflight` with `WEALTH_RUN_ID`, selected `WEALTH_TEST_USERNAME` and matching process `CLIENT_USERNAME`; money/Admin switches false.
- Real, only after explicit named-Run authorization: `npm run test:wealth:subscribe:reject`, with the same identity/Run, `WEALTH_AUTHORIZED_PRODUCT`, exact `WEALTH_AUTHORIZED_AMOUNT`, `WEALTH_AUTHORIZED_ACTION=reject` and temporary money/Admin switches true. Keep `.env` false and restore process switches in `finally`. Use shared Live Monitor for the interactive L4 invocation.
- Resume: same command and original Run with `WEALTH_RESUME=true`; never allocate another order. Approve/reject decisions cannot Resume each other's context. The exclusive `.reject-attempt` marker forbids a second final Admin click even after a crash.
- Each invocation: workers=1, retries=0, repeatEach=1. This case is excluded from default regression. No subscription approval, redemption, registration or deposit is invoked.

Implementation: `wealth-subscribe-reject.spec.ts`, `wealth-subscribe-reject.preflight.spec.ts`, `wealth-subscription-rejection.ts`; existing Wealth store, Client/Admin Page Objects, SecurityKeyDialog, reporter, candidate guards and Decimal calculations are reused.

#### Authorized WS-002 Execution: PASS

The user explicitly authorized `WS002-20260909-173401`: Hong Kong account, Galaxy Digital Lending, one 1.60 USD subscription and one Admin rejection, no rerun. The Flow ran once in a headed browser with the shared Live Monitor, workers=1, retries=0, repeatEach=1.

- Original Client/Admin reference: `INV-****e3bd`, created **2026-09-09 17:57:15 Asia/Shanghai**; fee **0 USD**.
- Client confirmation/security verification/Admin final rejection: **1 / 1 / 1**; Admin approvals **0**; candidateCount **1**, detail fingerprint passed every stage.
- Reason: `AUTOMATION INVESTMENT SUBSCRIPTION REJECTION TEST WS002-20260909-173401`.
- Admin final state: **已拒绝**; clean-login Client same INV final state: **已拒绝**; no duplicate subscription.

| Snapshot (USD) | Available | Frozen | Total |
| --- | --- | --- | --- |
| Before subscription | 98978.63 | 192.82 | 99171.45 |
| After subscription, before rejection | 98977.03 | 194.42 | 99171.45 |
| After rejection | 98978.63 | 192.82 | 99171.45 |

Observed actual behavior: submission reserved/froze **1.60 USD**; rejection released exactly that **1.60 USD**, restoring available funds without releasing the previous **192.82 USD** freeze. Total balance did not change. Exact Decimal comparisons passed.

- Product principal: **1.43 USD before and after**, active holding count **1 before and after**. The prior valid holding remains; this rejected subscription did not create an effective holding or add principal.
- All **6 Primary Oracles passed**, no warning or manual review. Runner **2/2 passed** includes Client authentication setup plus the single WS-002 case.
- Resume state **COMPLETED**, business stage **NO_ACTIVE_HOLDING_VERIFIED**; safe rerun **No**. Do not create a replacement or reject again.
- Immutable Chinese business report: [Run 791](../reports/business/history/2026-09-09_17-57-54-cb2b1bce/report.html). No historical report was rewritten.
- Money/Admin/Client mutation process switches restored to **false** in `finally`; `.env` was not changed. No registration, deposit, approval or redemption was performed.

### Original WS-003 Files

- `pages/client/FundTradingPage.ts`: actual holdings cards, response completion, history pagination and full currency parsing.
- `pages/client/FundSubscribePage.ts`: one confirmation and shared SecurityKeyDialog.
- `pages/client/AccountBalanceReader.ts`, `pages/client/AccountDetailPage.ts`: available/frozen/total snapshots from actual headers.
- `pages/admin/WealthOrderListPage.ts`: exact INV response synchronization, scoped details, full money parsing and once-only approval.
- `src/wealth/wealth-journey.ts`: independent evidence, Resume, identity, reproducible amount and matching helpers.
- `src/wealth/wealth-money.ts`: observed Client/Admin money formats.
- `tests/e2e/wealth/wealth-journey.preflight.spec.ts`: headed subscription read-only check; no Admin redemption tab.
- `tests/e2e/wealth/wealth-subscribe.happy-path.spec.ts`: one authorized subscription, approval and clean-login balance/position checks.
- `tests/reporting/wealth-journey.spec.ts`: local regression coverage for parsing and matching.
- `src/reporting/sensitive-data-mask.ts`: separate purchase/settlement fields and balance snapshots.
- `config/flow-registry.ts`, `package.json`: WS-003 command; Ready only after the authorized real success above.
- `docs/automation-status.md`, `docs/e2e-flow-map.md`: WS-003 verified status and independent paused redemption.
- `docs/wealth-golden-journeys.md`: current scope, oracles, paused redemption and execution limitation.
