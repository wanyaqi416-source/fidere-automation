# DP-004 Existing User Deposit Rejection

## Scope

New independent case: `DP-004`, registry `deposit-rejection-journey`.
Reuse the existing approved Personal Journey user and bank address. Do not register,
create an address, bootstrap balances, claim a deposit or approve a deposit.
The historical `DP-002` case and its evidence remain unchanged. The successful
deposit-claim/approval journeys are separate and must not be overwritten or executed here.

## Oracles

Primary:
- One new Client deposit record, located by original user session, account, currency,
  exact Decimal amount and the persisted submission window. Read the real TXN in detail.
  An explicitly authorized original-application Resume can instead use the unique
  Admin business fingerprint plus verified detail and the original submit marker as
  creation evidence. Pin its immutable fields by hash; never invent a Client TXN.
- Exactly one Admin candidate, with account, user, currency, amount, channel, time
  and pending state checked again before rejection. The claim list does not require a TXN.
- Original Admin record reaches its rejected terminal state.
- Same Client application becomes rejected, observed in transaction detail or original
  deposit history. Match the original amount, currency and time; compare TXN and rejection
  reason whenever displayed. Global ledger absence does not prohibit locating the Admin order.
- Only one new matching Client deposit; submission and rejection each attempted once.
- `Decimal(afterBalance).equals(beforeBalance)`; no tolerance or assumed credit.

Post-rejection buttons are a non-scoring Diagnostic. Never click them to test whether
a rejected order can be claimed again. Client rejected state and unchanged balance
are required, not optional ledger warnings.

## State And Resume

Business stages:
`DEPOSIT_READY -> DEPOSIT_SUBMITTED -> ADMIN_DEPOSIT_FOUND -> ADMIN_DEPOSIT_REJECTED
-> CLIENT_DEPOSIT_REJECTED -> BALANCE_UNCHANGED_VERIFIED`.

Shared persisted stages:
`PREPARED -> CLIENT_SUBMIT_ATTEMPTED -> CLIENT_CREATED -> ADMIN_LOCATED
-> ADMIN_ACTION_DONE -> CLIENT_FINALIZED -> COMPLETED`.

`.flow-state/deposit-rejection-journey/` holds the original state and exclusive
submit/reject attempt markers. The baseline contains only the before balance,
historical TXNs, submission time and channel. A hashed binding pins the original
Journey, account, currency and amount. Password, OTP, tokens and response bodies
are never stored there. State and local reports are Git-ignored.

Any observed or uncertain submission blocks fresh execution. Use the original Run
with `DEPOSIT_REJECT_RESUME=true`; an existing reject marker forbids another reject.
An unfinished source-user Run also blocks a replacement Run.
`DEPOSIT_SUBMISSION_UNCONFIRMED` means do not resubmit. Investigate the original
application read-only; Admin mutation requires creation evidence, detail matching,
strict candidate uniqueness and new explicit authorization to resume the same Run.

## Commands

- `npm run test:deposit:rejection:preflight`: safe, all mutation flags false.
- `npm run test:deposit:rejection:unit`: local fixtures and state/guard tests only.
- `npm run test:deposit:rejection-journey`: one explicitly authorized named Run only.
- `npm run test:deposit:rejection:readonly`: original submitted Run only, all flags false.

Configure `DEPOSIT_REJECT_SOURCE_RUN_ID`, `DEPOSIT_REJECT_RUN_ID`, and existing
`DEPOSIT_ACCOUNT_TYPE`, `DEPOSIT_CURRENCY`, `DEPOSIT_CURRENCY_LABEL` and form settings.
The amount is reproducibly derived from the Run ID and `DEPOSIT_UNIQUE_AMOUNT_BASE`.
Real execution additionally requires `DEPOSIT_REJECT_AUTHORIZED_RUN_ID` to exactly
match, and temporary process values of `ALLOW_CLIENT_MUTATION_TESTS`,
`ALLOW_MONEY_TESTS`, `ALLOW_ADMIN_MUTATION_TESTS` to be true. Never change `.env`.
All commands enforce workers=1, retries=0, repeatEach=1 and no automatic rerun.

## 2026-09-09 Preflight

- Proposed Run: `DP004-AH-20260909`; source: `REGP-20260904020924`.
- Existing user: TEST SANDBOX AH, KYC approved, original approved bank address suffix 0008.
- Hong Kong account, USD. Current available balance: 794.62. Proposed amount: 11.56.
- Client form, SWIFT selection, Admin session and approved bank-address lookup passed.
- Full filtered Admin scan: same user/account/currency/amount pending conflict count=0.
- Admin pagination initially treated transient empty rows as a new page. Fixed by
  atomic row snapshots, waiting for changed nonempty rows and validating visible pagination ranges.
- Passing safe preflight report: `reports/business/history/2026-09-09_15-28-26-241995b4/report.html`.
- Client submission=0, Admin rejection=0. Real DP-004 remains In Progress, awaiting
  explicit named-Run authorization at that time. This is not evidence that a real rejection has passed.

## Implementation And Verification

- New orchestration and persisted Run: `src/deposit/deposit-rejection-flow.ts`, `src/deposit/deposit-rejection-run.ts`.
- New E2E/preflight/readonly specs: `tests/e2e/deposit/deposit-rejection-journey.spec.ts`,
  `deposit-rejection-preflight.spec.ts`, `deposit-rejection-readonly.spec.ts`.
- Local coverage: `tests/reporting/deposit-rejection.spec.ts` (9 passing tests).
- Extended shared Page Objects: `DepositClaimListPage`, `DepositRejectDrawer`, `TransactionDetailDrawer`.
- Updated Registry, npm commands, `.env.example` placeholders and automation status.
- `npm run typecheck`: passed. Entire local `tests/reporting` suite: 144/144 passed.
- The preparation phase did not submit a Deposit or perform an Admin mutation.

## 2026-09-09 Authorized Execution

- Run: `DP004-AH-20260909`, original TEST SANDBOX AH, Hong Kong USD, amount 11.56.
- Original balance: 794.62 USD. Existing KYC/bank address and no-conflict preflight passed again.
- Client submit clicked exactly once; `POST /api/confirm-deposit` returned HTTP 200
  and the submission acknowledgement page was observed. These signals do not alone prove business creation.
- For 60 seconds the Client transaction matcher exposed zero new matching deposit records.
  No real detail TXN was obtained. This does not establish that the backend failed to create an application.
- Disposition: `DEPOSIT_SUBMISSION_UNCONFIRMED`; report outcome `MANUAL_REVIEW`.
- Persisted stage: `CLIENT_SUBMIT_ATTEMPTED`, original amount/time/balance and submit tombstone retained.
- Admin rejection count=0; no approval, second deposit, new address or new user.
- Final Client rejection status and final balance equality were not verified.
- Next action is read-only reconciliation of this original attempt. Never fresh-run or create a replacement deposit.
- All three process mutation flags restored to false; `.env` unchanged.
- Historical report: `reports/business/history/2026-09-09_15-41-37-d654e2bb/report.html`.

## 2026-09-09 Original Application Read-only Investigation

- Admin incoming claiming has no TXN column. Its bank reference is not a Client TXN;
  the original row actually displays `-` in that field. Never derive a mapping.
- The Admin matcher already used business fields, not TXN. The investigation path
  previously waited for a Client TXN before reaching Admin. Readonly mode now queries
  Admin independently; the authorized rejection path retains its creation-evidence gate.
- Original Run `DP004-AH-20260909`: Admin scan of 324 records produced staged counts:
  Hong Kong account 161 -> USD 104 -> exact amount 11.56: 1 -> pending status 1
  -> SWIFT channel 1 -> original submission window 1 -> original user 1.
- Exactly one original Admin record exists, status `待处理`, created at
  `2026-09-09 15:40:35` (Asia/Shanghai). Customer, account, amount, channel, reference
  and timestamp were checked in the real claim drawer, then the drawer was cancelled.
- Client deposit-type lookup still returned 0 matching records. Current USD balance
  remains 794.62. Admin evidence disproves that the original application is missing;
  Client record/TXN observation remains unresolved.
- Readonly case `DP-004-READONLY`: PASS. This is not a passed rejection journey.
  Original Run stage and historical failure report were not rewritten.
- No new submission, claim, approval or rejection. Rejection attempt count remains 0;
  all three mutation flags remained false. Continue only the original application.
- Typecheck and 9 focused unit tests passed, including candidates with no TXN or bank reference.
- Readonly report: `reports/business/history/2026-09-09_15-55-41-ff215b2e/report.html`.

## 2026-09-09 Authorized Original Rejection Resume

- User authorized rejecting the previously located original 11.56 USD application.
  No Client form submission, new address or new user was performed in this Resume.
- Revalidated dual authentication, original KYC/bank address, candidateCount=1 and
  pending-detail fields. Admin has no TXN; reference remains `-`.
- Confirm rejection clicked once at `2026-09-09T08:15:10.420Z`.
  Reason: `AUTOMATION DEPOSIT REJECTION TEST DP004-AH-20260909`.
- Admin original record reached `已拒绝`. Persistent stage: `ADMIN_ACTION_DONE`;
  the reject marker forbids another rejection. Resume immutable-field binding is
  confined to the rejection domain and does not change shared Flow Engine rules.
- USD balance assertion passed: `794.62 = 794.62`. No balance increase.
- Client deposit-history lookup returned `missing` for 60 seconds. Therefore the
  complete DP-004 test did not pass; this does not negate confirmed Admin rejection.
  Manual review was not assigned solely for the Client display lookup failure.
- Report: `reports/business/history/2026-09-09_16-16-51-70c01185/report.html`.
- workers=1, retries=0, repeatEach=1; no automatic mutation rerun. All three process
  switches restored to false and `.env` unchanged. Further investigation is read-only.
- Subsequent readonly evidence: `reports/business/history/2026-09-09_16-23-23-33c3bf13/report.html`.
  Admin original candidate=1 and status remains `已拒绝`; USD balance remains 794.62.
  Client global transaction matches=0; on the deposit page, bounded polling of the
  same loaded page still exposed zero history cards through the existing parser.
  This is missing automation evidence, not proof that no Client record exists.
- One intervening readonly scan collected 314 records and missed the candidate;
  the subsequent full scan collected 324 and found it. List/pagination consistency
  remains an investigation item. No mutation was repeated in response to that absence.
- Readonly success is not a rewrite of the mutation test's failed Client assertion;
  `DP-004` remains In Progress, at `ADMIN_ACTION_DONE`. Only readonly verification
  remains allowed for this original Run; do not reject again.
- Final local verification: typecheck passed; `tests/reporting` 145/145 passed,
  including 10 rejection-domain tests. No approval Journey was run or overwritten.

## Commit Review

- Added an explicit pagination completeness guard: collected ranges must start at
  the first record, remain contiguous with a stable displayed total, and finish
  with the same number of rows as that total. Missing pages or early termination
  must not be returned as a supposedly complete candidate set.
- Added local coverage for an early end, a missing first page and a genuinely
  empty list. Typecheck and the full local reporting/unit suite passed (148/148).
- These review checks do not rerun a live deposit or establish that the unresolved
  Client record lookup is fixed. Original approval cases and historical reports remain intact.
