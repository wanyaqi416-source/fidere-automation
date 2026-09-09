# User-to-User Transfer

## Scope

- Current success contract (2026-09-07 user clarification): **Admin approval submission succeeds -> COMPLETED -> PASS**. This is the default endpoint, not a temporary per-run exception. Do not execute or score Sender/Recipient balance and ledger checks after approval, and do not emit warnings/manual-review requirements for those omitted checks. Pre-approval identity, unique original order and single-action safety remain unchanged. This does not claim independently verified settlement.

- U2U is the Client `用户转账` -> `转账给其他用户` flow at `/zh-CN/account/p2p-transfer`.
- It is not the broker/account Transfer flow and not Beneficiary Withdrawal.
- Correction on 2026-09-07: **User-to-User Transfer requires Admin approval** at `法币资产管理 -> 资金互转`. The list record type is `用户间互转`. The earlier direct-completion assumption was withdrawn by the user. Account-to-account transfer is a separate flow; its historical reports are not changed here.
- Latest instruction pins Sender to `CLIENT_USERNAME` (masked `826***@qq.com`). Do not automatically substitute a Golden Journey user.
- Recipient is configured through `U2U_RECIPIENT_EMAIL` (requested `e72***@qq.com`). No new users or balance bootstrap.

## Observed Page Contract

On 2026-09-07, before the user pinned the default Sender, read-only inspection with the existing Personal Journey observed:

| Item | Evidence |
| --- | --- |
| Entrance | Account page button `用户转账` |
| Recipient input | One `input[type=email]`; the visible `收款用户邮箱` is a heading, not an associated label |
| Eligibility | `收款用户及账户资格将在提交时由系统校验。` No pre-submit positive eligibility evidence observed yet |
| Asset | Combobox accessible name `转出资产` |
| Amount | Placeholder `0.00`, initially disabled until an asset is selected |
| Note | Placeholder `填写本次转账说明` |
| Summary | Amount, recipient, source account, fee, expected credit |
| Fee semantics | `手续费（从金额内扣）`. Actual amount/precision still need a live selected asset and quote |
| Business confirmation | `确认并提交审核`; initially disabled. Not clicked during Recon |

The preflight only observes these facts. Entering an email or enabling a button is not proof of recipient eligibility.

## Current Result And Blockers

### 2026-09-07 Final Admin Approval

- User explicitly authorized approving the existing order and subsequently defined successful Admin submission as this phase's success criterion. Balance and ledger settlement are not blocking conditions for this phase.
- Original `TRF-****fccb` / `TXN-****71eb`: candidateCount=1 and both parties, direction, USD, 40.11 requested, 40.00 fee, 0.11 expected credit, time and pending status matched before approval.
- Filled `AUTO_U2U_APPROVE_<originalRunId>` through `TransferApprovalReview.fillRemark()`, then clicked final Approve exactly once. Secondary confirmation count=0. No new Client confirmation, Security Key verification or transfer.
- The mutation command's subsequent list refresh failed to find the original record. The failed technical report is preserved at `reports/business/history/2026-09-07_18-25-27-555e4df6/report.html`; approval was never repeated.
- A separate read-only query restored the Sender email filter and polled actual records without treating an initially empty table as a terminal exception. The same TXN uniquely exists with **Admin status 已批准**. All original row fields still match.
- **Current phase business result: PASS; manual review: No; direct mutation rerun: forbidden because approval already succeeded.** Read-only report: `reports/business/history/2026-09-07_18-28-00-1baeffdc/report.html` (2/2 including Client auth).
- The evidence from that read-only Run persisted `ADMIN_ACTION_DONE`. Under the now-default contract, future successful approval/result runs advance directly to `COMPLETED`, without a fictitious `CLIENT_FINALIZED` step. Final Recipient credit and both-party ledger verification were not run and are outside this flow's success contract. Historical reports and evidence are not rewritten.
- All three mutation flags restored/verified false. Historical observations below describe the earlier pending state, not the current approval result.

- The initial default Sender login returned `用户名或密码错误` before the email OTP stage. The user subsequently updated the local password; fresh login now succeeds and refreshes `auth/client.json`.
- Verified dotenv resolves the requested Sender with no process overrides and no edge whitespace. This Sender is actually BUSINESS (`entityType=2`, `kyb_status=1`, `kyc_status=0`); use the shared account-type-specific KYC decoder rather than requiring the Personal field.
- The alternative existing Personal Journey can log in with KYC status 1, but the user subsequently excluded that Sender. Its balances must not be used as the default Sender's baseline.
- The user confirmed Recipient can use the existing ENV login password/OTP. Both accounts passed clean login and approved KYC/KYB checks. Recipient Hong Kong USD balance before submission: 202.06.
- One actual transfer was submitted in Run `U2U-20260907-HKUSD-01`: business confirmation 1, Security Key verification 1, `POST /api/transfer/p2p` 1 (HTTP 200), one real TRF. No second transfer was created.
- Client: `TRF-****fccb`, ledger `TXN-****71eb`, status `审核中`. Admin: **the same TXN**, status `待审核`. These identifiers were independently read from both pages, not derived by replacing prefixes.
- Admin candidateCount=1 after exact Client TXN plus both participant emails, account direction, USD, exact amount, fee/net amount, submission window and pending status. The review entry is separate from the final `批准` action.
- Sender available balance: 10,204,513,119.39 -> 10,204,513,079.28 USD. This 40.11 reduction before approval is not proof of final settlement or Recipient credit; freeze/debit semantics remain to be confirmed after approval.
- The former direct-completion fresh command remains disabled under the corrected Admin-required rule. Its fresh orchestration remains a separate implementation gap; missing balance/ledger verification is not a blocker. Continue existing orders only and never repeat completed approvals.
- The original mutation test failed while its detail parser did not recognize `审核中` and while it incorrectly expected direct completion. That historical report is preserved; a known pending-review order is not an unknown money outcome.

### Hong Kong USD Preview

The user selected Hong Kong USD as the primary test asset. The 2026-09-07 17:25 preflight confirmed:

| Field | Observed |
| --- | --- |
| Sender available balance | 10,204,513,119.39 USD |
| Transfer amount (preview only) | 40.11 USD |
| Fee | 40.00 USD, deducted from amount |
| Expected credit | 0.11 USD |
| Confirmation enabled | Yes, but not clicked |
| Security Key verification | 0 |
| Actual transfer creation | 0 |

The previous 0.11 USD trial input was below the actual 40 USD fee and displayed zero credit; it was not submitted. Reading an enabled confirmation button does not prove recipient eligibility.

Report: `reports/business/history/2026-09-07_17-25-18-9e69bbdf/report.html`. This is a read-only preflight success, not a completed money E2E.

## Existing Order Resume

Do not rerun Client submission. Use the stored original Client TXN to find the unique Admin record, revalidate details, and obtain explicit authorization for the new final Admin approval mutation. The completed Client confirmation/security steps must never execute again.

The implementation reuses `MoneyMutationGuard`, `FlowStateStore`, `AccountBalanceReader`, `SecurityKeyDialog`, `TransactionsPage`, `TransactionDetailDrawer`, `TransferListPage`, `TransferDetailPage` and `TransferApprovalReview`. Resume state and safe balance baselines are stored under `.flow-state/user-to-user-transfer/`. No credentials or full identity are persisted there. Admin metadata must not overwrite the original Client order reference.

Current stages: `PREPARED -> CLIENT_CREATED -> ADMIN_LOCATED -> FIDERE_APPROVAL_ATTEMPTED -> ADMIN_ACTION_DONE -> COMPLETED`. The existing order was approved successfully. Persist the final Admin attempt before clicking; never repeat an attempted approval on Resume. No post-approval Client settlement stage is required.

For the observed fee-inside-amount wording, the prospective arithmetic is sender debit = requested amount and recipient credit = requested amount minus fee, but this must first be confirmed against the live summary and observed settlement. All calculations use Decimal. No guessed tolerance or balance.

If a final verification was clicked without order creation evidence, classify `U2U_TRANSFER_SUBMISSION_UNCONFIRMED`, query only and prohibit resubmission. Missing recipient observability must be explicit, not reported as a verified credit.

## Safe Command

`npm run test:client:u2u:preflight` automatically runs Client authentication, then reads the distinct U2U form. Requires `U2U_RECIPIENT_EMAIL`; mutation switches stay false. It never clicks the final business confirmation or Security Key verification.

`npm run test:client:u2u:admin-review` requires the original `U2U_RUN_ID`. It only opens the Admin review entry, revalidates the original TXN, and reads Recipient balance. Fixture teardown closes the context without approving/rejecting. All mutation switches must remain false.

`npm run test:client:u2u:approve-resume` is the opt-in Admin-only mutation command. It refuses any previously attempted approval stage. It must never be rerun for this already approved order.

`npm run test:client:u2u:settlement` retains its existing command name for compatibility, but now only queries the original Admin approval result and finishes. `U2U_ADMIN_RESULT_ONLY` is no longer required or consulted. No balance/ledger tail, warnings or diagnostic failure is generated. All mutation flags must be false.

The legacy `npm run test:client:u2u:reconciliation` remains a separately invoked investigative tool, outside default regression and the approval journey. It is not called by the flow and is not needed for its success. Do not run it automatically.

## Latest Read-only Review Evidence

- 2026-09-07 18:06: Admin authentication, exact Client/Admin TXN matching, candidateCount=1, review details, and Recipient balance read all passed. The review was opened, but final Approve/Reject counts were both zero.
- Recipient current Hong Kong USD remains 202.06 (same as baseline), consistent with the original order awaiting approval. No incoming transfer is claimed as completed.
- Original Run state: `ADMIN_LOCATED`; original Client TRF and real Admin TXN are persisted separately. No second transfer, registration, deposit or balance bootstrap was performed.
- Read-only report: `reports/business/history/2026-09-07_18-06-53-c182343f/report.html` (2/2 including Client auth). The original failed mutation report remains unchanged.
- All three mutation switches remain false in `.env` and outside the explicitly scoped original money process.
