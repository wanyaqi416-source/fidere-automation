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
