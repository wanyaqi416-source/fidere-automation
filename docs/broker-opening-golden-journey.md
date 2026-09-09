# Existing User Broker Opening

## Scope

- Reuse source Journey `REGP-20260904020924`, TEST SANDBOX AH, `yhd***@mowan666.com`.
- Do not register another user, submit a Client deposit, or repeat a broker application.
- Admin manual deposit is an independent Sandbox balance bootstrap case, not the Client bank-wire Deposit E2E.
- Wealth redemption remains paused; no redemption Admin tab is used.

## Observed On 2026-09-08

| Item | Actual page result |
| --- | --- |
| Client Hong Kong USD | Available 7.65; frozen 0; total 7.65 |
| Admin authentication | Active; fiat assets and broker review accessible |
| Existing broker applications for this email | 0 |
| Tiger | 待开户; 100.00 USD; no documents; 确认缴费并开户 then SecurityKeyDialog |
| Webull | 待开户; 100.00 USD; fee acknowledgement then 上传开户资料 |
| Webull documents | W-8BEN 表格; CRS 控制人表格; each has 去签署 |
| Webull next step | 下一步：提交审核 disabled until documents are complete |

The fee confirmation currently describes the debit account as 信托账户. Do not infer an unobserved payment-account selector or treat a final click as completed business creation.

## Admin Manual Deposit

Case: `ADMIN-MD-001`; registry: `admin-manual-fiat-deposit`.

Page: `/zh-CN/operation/fiatAssets` -> 手动入金.

- Customer search uses ONLY the exact existing user's email. No display-name search.
- Require a unique email option, then verify its displayed name/email without logging full identity.
- Wait for accounts to load after selecting the customer; select 香港账户.
- Currency: USD. Actual channel options: LOCAL PAYMENT, FPS, SWIFT, Others.
- For this explicit test-balance fixture use Others and an audit note identifying Sandbox bootstrap.
- Required inputs: customer, account, currency, amount, audit note. Proof is optional, images accepted.
- Two distinct actions: form 确认入金 opens the 确认手动入金 dialog; its 确认入金 is the actual final money action. Validate customer, USD amount and Run note in that dialog. Persist the final attempt before clicking it; never retry a final attempt.
- Primary: original user/account; exact authorized amount; one final submit; actual Client USD increase equals amount (Decimal).
- Any returned transaction reference is stored separately; HTTP success or drawer closure alone is insufficient.

State:

`PREPARED -> BOOTSTRAP_CONFIRMATION_REQUIRED -> BOOTSTRAP_SUBMISSION_ATTEMPTED -> BOOTSTRAP_SUBMITTED -> BOOTSTRAP_COMPLETED`

An attempted or completed Run cannot execute another deposit. Ambiguous outcomes require read-only reconciliation, never a replacement deposit.

Commands:

```powershell
npm run test:broker-opening:preflight -- --headed
npm run test:admin:manual-deposit
npm run test:admin:manual-deposit:reconciliation
```

The preflight requires `BROKER_SOURCE_RUN_ID`. Real manual deposit additionally requires a user-authorized named `MANUAL_DEPOSIT_RUN_ID`, `MANUAL_DEPOSIT_AUTHORIZED_AMOUNT`, and temporary `ALLOW_MONEY_TESTS`/`ALLOW_ADMIN_MUTATION_TESTS`.

## Current Execution Boundary

`MD001-AH-20260908` completed after explicit named authorization. Admin selected AH by email, 香港账户, USD, Others, amount 1000, audit note `AUTO_SANDBOX_BROKER_BOOTSTRAP_MD001-AH-20260908`.

- Original form click only opened the confirmation dialog. No final click/request occurred; read-only balance remained 7.65 and Run ledger query returned 0. This deterministic pre-submit issue was recovered within the same named Run.
- Final confirmation: exactly 1; `POST /admin-api/operation/fiat/manual-deposit` HTTP 200 at 2026-09-08 15:59:43 Asia/Shanghai.
- Actual Client Hong Kong USD: 7.65 -> 1007.65; frozen 0; observed increase exactly 1000 (Decimal).
- State: `BOOTSTRAP_COMPLETED`. No second deposit, new user, Client deposit, broker application or fee debit.
- Original form-confirmation opens: 2 across the initial session and recovery session; actual money-confirmation clicks: 1. These counts must not be conflated.
- Admin Run-note ledger query still returned 0. This is a non-scoring Diagnostic, not evidence against the confirmed balance increase and not a manual-review condition.
- Historical failing executions remain preserved. Final read-only reconciliation PASS: [report](../reports/business/history/2026-09-08_16-02-39-92725f7c/report.html).

Tiger opening completed in `OPEN-TIGER-AH-20260908`, as recorded below. Webull independently completed in `OPEN-WEBULL-AH-20260909`; its readiness is based on its own two-document and application evidence, not Tiger's result.

Verification: `typecheck` passed; existing Journey/Bootstrap plus new two-stage/no-double-credit tests 6/6 passed; final read-only reconciliation 1/1 passed. Process permissions were restored and all `.env` mutation switches remain false.

Next intended progression after authorized bootstrap:

`BALANCE_READY -> BROKER_DOCUMENTS_READY (Webull only) -> FEE_CONFIRMATION -> SECURITY_VERIFIED -> CLIENT_APPLICATION_CREATED -> ADMIN_CANDIDATE_UNIQUE -> ADMIN_APPROVED -> CLIENT_BROKER_OPENED`

Each broker keeps its own original application and single-click counters. Webull's two documents have separate lifecycle evidence. Do not assume Personal, Corporate, or US document locators are compatible until the actual embedded broker document DOM is verified.

## Webull Preflight

Webull独立用例与双文档预检已建立，详见[微牛开户Flow](./webull-broker-opening.md)。OPEN-WEBULL-001已通过；原AH的OPEN-WEBULL-003恢复原W-8BEN与CRS结果后完整PASS，申请30，Admin已开户、Client已开通。未重签，费用确认/安全验证/审批各1次；香港USD894.62降至794.62，费用100USD，无额外入金。微牛使用独立WebullDocumentSigner；个人、企业和US具体签署组件不变。原Run已COMPLETED，禁止重复申请。

## Tiger Execution Completed

- Run: `OPEN-TIGER-AH-20260908`; original source Journey unchanged; Admin application reference `29`.
- Client: one application and one Security Key verification at approximately 2026-09-08 16:37 Asia/Shanghai. No documents are required for Tiger.
- Fee: actual page 100.00 USD. Before application, Hong Kong available/total = 1007.65/1007.65. While pending, available/frozen/total = 907.65/100/1007.65. Do not confuse freezing with final debit.
- Admin list broker text is `TIGER（老虎证券）`, while Client uses `老虎证券`. Match explicit domain semantics, original email/name, personal account type, minute-precision submission window and pinned reference. All candidate stages returned 1.
- First detail lookup hit both the 申请概览 tab and heading. Corrected to the heading role; no approval occurred at this point. Historical failed report is preserved.
- Actual approval has TWO actions: `保存处理结果` opens the `审核通过` dialog; its `确认通过` performs the final submission. The dialog requires 账户名称, 券商账户号码 and 开户时间 (`input[type=date]`). Opening it caused zero Admin write requests.
- User explicitly allowed a Sandbox test broker account number. Account holder remained TEST SANDBOX AH; a deterministic SBX-prefixed number for this Run was supplied through process configuration, not a real broker identity. Opening date was the execution date.
- Final Admin `确认通过`: exactly 1. Client was NOT resubmitted during either Admin continuation. Historical form-open attempts were not final approvals and were not erased from prior reports.
- Final Admin state: 已开户. Final Client state: 已开通. Final Hong Kong available USD: 907.65; the Admin-only continuation did not charge another fee.
- Final Resume state: `COMPLETED`. Result: PASS; total 1 / pass 1 / fail 0 / manual review 0. No second application, deposit, Webull operation, or repeated Security Key verification.
- [Final Chinese report](../reports/business/history/2026-09-08_16-53-22-a138d0dd/report.html). Original failed historical reports remain unchanged.
- `.env` money, Admin and Client mutation switches all remained false. Temporary execution flags were restored.

Corrected approval states:

`ADMIN_LOCATED -> ADMIN_APPROVAL_CONFIRMATION_REQUIRED -> ADMIN_APPROVAL_SUBMISSION_ATTEMPTED -> ADMIN_ACTION_DONE -> CLIENT_FINALIZED -> COMPLETED`

Only a known form-open legacy attempt may be reconciled forward into confirmation-required after verifying the same pending application and zero write requests while opening the dialog. An actual final submission attempt is never reset or repeated.

Configuration (process-only for an explicitly authorized Run): `BROKER_SOURCE_RUN_ID`, `BROKER_OPENING_RUN_ID`, `BROKER_AUTHORIZED_FEE`, `BROKER_OPENING_ACCOUNT_NUMBER`, `BROKER_OPENING_DATE`. All required final-approval data is checked before any future Client fee operation. `BROKER_OPENING_MODE=resume-admin` forbids Client money operations and requires `ALLOW_MONEY_TESTS=false`; only the original uniquely located application may continue before its final approval attempt.

Safe commands: `npm run test:broker-opening:tiger:preflight`, `npm run test:broker-opening:tiger:reconciliation`. Mutation command: `npm run test:broker-opening:tiger`. Never run the completed AH application again.

Post-completion verification: TypeScript typecheck passed; Tiger matcher/confirmation/state tests 5/5 and shared Flow Engine tests 10/10 passed. These local tests did not execute any Sandbox mutation.
