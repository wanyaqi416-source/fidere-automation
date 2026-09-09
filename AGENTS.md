# Fidere Automation Engineering Rules

Read this file before changing or adding a Flow.

## Safety

- Run money and mutation tests only after explicit user authorization for one named Run.
- Never retry, repeat, parallelize, or automatically rerun a money Flow. L4 uses `workers=1`, `retries=0`, and `repeatEach=1`.
- Keep `ALLOW_MONEY_TESTS=false` and `ALLOW_ADMIN_MUTATION_TESTS=false` in `.env`. A command may inherit temporary process values; code and menus must not edit `.env`.
- Reject production and unknown hosts. Mutation is allowed only on a recognized Sandbox, Staging, local, or `.test` host.
- Client submission, Security Key verification, and Admin final action are each limited to one click per Run.
- Any Client Money Mutation that causes a real fee or debit must use the shared `SecurityKeyDialog`: business confirmation -> read `CLIENT_SECURITY_KEY` -> one verification click -> business creation evidence. Clicking the business or fee confirmation alone is not a completed money submission. Never hardcode or report the Security Key.
- Once Client business data exists, persist the allowed Resume state and continue that business. Do not create a replacement order after a downstream failure.
- Local standalone Admin flows check a protected business page in Playwright global setup before any test/Client mutation. A missing or expired session automatically opens the shared headed Admin authentication once; the user completes captcha/OTP, and business-page verification must pass before tests start. Never invoke interactive authentication from a test body, replay a test, reset Resume/attempt markers, or repeat a mutation to recover auth. CI, safe regression suites, and `ADMIN_AUTH_AUTO_RENEW=false` never open interactive authentication; unavailable networks/permissions do not trigger login loops.
- Fresh Personal Registration must read its password only from `CLIENT_PASSWORD`; the user factory creates or reserves only unique Sandbox email and phone identities, and no password may be persisted in Journey or pool data.
- A Fresh Run is the active test journey, not a requirement to create a new account on every invocation. If that journey already has an account without a final profile submission, resume it by default; create another account only when no recoverable account exists. An existing sequence blocks allocation of the next sequence.
- Personal Registration must complete Documenso and observe Fidere signing recognition before final profile submission. An enabled submit button before signing is a Secondary product warning, but automation must continue signing and must never click that button early.
- After the Personal Registration document shows completed with zero remaining fields, the lower-right Fidere `Submit` is the separate action that completes the Authorization step. The left step may still show current before that click; do not use it as a circular pre-submit gate.
- Personal Registration final profile submission is a separate action after signing: click the Fidere page's lower-right `Submit` once, observe `POST /api/member-profile`, and require the `sign-success` waiting-for-review page. `POST /api/create-kyc-doc` only creates the signing document and is never final-submission evidence.
- For a new Personal Registration Run, a completed Registration Agreement plus recognized `client_authorization_status` does not by itself prove final profile submission. The first lower-right Submit attempt must capture button DOM state, console/page errors, and `POST /api/member-profile`. If and only if that attempt produces zero matching requests, preserve the diagnostic, reload/re-enter the same account once, revalidate the completed document and signing status, and allow one recovery click. Record a successful recovery as `POST_SIGN_FIRST_SUBMIT_STATE_DESYNC`. Any observed request forbids another click. Never create a replacement account. Historical Runs already reconciled through a unique Admin KYC case remain historical business successes.

## Flow Architecture

- Register metadata once in `config/flow-registry.ts` as a `BusinessFlowDefinition`.
- Keep Flow Capability status separate from a Specific Run Resume state. Journey Readiness uses capability status only and must not downgrade a reusable Flow because an older order is paused or failed.
- Reuse `src/flow-engine/` for lifecycle orchestration, candidate matching, guards, Resume, Oracle adjudication, and reporting metadata.
- Page Objects own DOM locators and page interactions. They must not decide cross-system business success.
- Money Flow Page Objects reuse `pages/client/SecurityKeyDialog.ts`; a domain must not duplicate the six-digit input or verification-button locators.
- Flow orchestration owns business assertions and state transitions. It must not contain raw DOM selectors.
- Do not duplicate an existing public component. Extend it only when the behavior is shared by at least two real Flows.
- Domain-specific forms, mappings, statuses, and identifiers stay in their domain modules.
- Different third-party or embedded signing pages may share only a signing lifecycle abstraction. Do not share concrete DOM locators across business flows unless that exact page DOM has been verified.
- Personal Registration uses `RegistrationAgreementSigner`; US Account Opening uses `DocumentSigningPage`. Neither flow may call the other's concrete locator contract.
- Webull W-8BEN and CRS signing uses its independent `WebullDocumentSigner`. It must not import or overwrite Personal, Corporate, or US Opening concrete signing locators. Each Webull document keeps separate signature, final-action, and callback evidence.
- Registration and KYC flows must never perform the final Client submission while any signing field remains or the domain signing-completion gate is false.

## Candidate Safety

- Registration Golden Journeys do not finish at Client waiting-for-review. After submission, use the shared registration KYC tail: PERSONAL -> 案件工作台/个人用户, BUSINESS -> 案件工作台/企业用户. Pin the original sourceRunId, email, userId, reviewId, and Corporate applicationId when available.
- KYC stages are separate Admin mutations. Persist each actual review step's attempt before clicking, and never repeat an attempted stage on Resume. A new/unknown stage requires explicit authorization and a verified page contract. The original case leaving a pending list is not approval evidence.
- KYC success requires the original Admin case's approved state plus a new empty-context Client login with the correct account type and approved kyc_status/kyb_status. Waiting-for-review or Dashboard access alone is insufficient. Generic Admin user search remains a Diagnostic; the actual KYC candidate and approval are Primary.
- If a registered user has pending KYC approval, Resume that user's case. Missing candidates never permit another registration, upload, signature, or Client profile submission.

- Configure staged business fingerprint fields per domain; do not force every Flow to use the same fields.
- Record candidate count after every stage in the business report.
- `candidateCount` must equal exactly `1` before opening a mutation path.
- Never select the first/latest row or match only by amount, user, or time.
- Revalidate the unique candidate in Admin detail before the final action.

## Resume

- Use stages: `PREPARED`, `CLIENT_CREATED`, `ADMIN_LOCATED`, `ADMIN_ACTION_DONE`, `CLIENT_FINALIZED`, `COMPLETED`.
- Persist only runId, flowId, Client/Admin business references, amount, currency, timestamps, and stage.
- Never persist passwords, OTPs, Security Keys, cookies, tokens, Authorization headers, or request/response bodies.
- At `CLIENT_CREATED` or later, fresh execution is blocked by default and Resume is required.

## Failure Disposition

- Classify deterministic form or validation problems before final Client submission as `RECOVERABLE_PRE_SUBMIT` when no Security Key verification, business-order creation, or Admin mutation has occurred.
- A recoverable pre-submit problem may receive one bounded, deterministic correction using predeclared Sandbox data, followed by explicit verification. Never retry indefinitely, fill random values, or create a replacement user/order.
- If an account exists but KYC/profile data has not been finally submitted, resume that account and correct the non-money form in place.
- Registration Admin user search is a post-registration Diagnostic only. It must not block account creation, signing, final profile submission, or the core Registration outcome.
- Reserve `HARD_STOP` for ambiguous or irreversible boundaries: an uncertain Client submission, Security Key verification, Admin approve/reject, final third-party signing, existing business order, conflicting balance/state evidence, or `candidateCount != 1` before Admin mutation.

## Oracle And Outcomes

- User-to-User Transfer ends successfully when the original unique Admin order's approval submission succeeds. Advance directly from `ADMIN_ACTION_DONE` to `COMPLETED` and report `PASS`. Do not run Sender/Recipient balance or ledger reconciliation as an automatic tail, Primary/Secondary Oracle, warning, or manual-review gate. Keep pre-approval uniqueness, detail matching, explicit authorization and single-click protection. Completion here means approval success, not a claim that settlement was independently verified.

- Define Primary and Secondary Oracle before any real E2E.
- Primary Oracle decides core business success. A failed Primary Oracle yields `FAIL`.
- Passed Primary plus failed Secondary yields `PASS_WITH_WARNING`.
- Use `MANUAL_REVIEW` only after a mutation when available evidence cannot determine success or failure, or core evidence conflicts.
- Use `BLOCKED` for an environment, product, data, permission, or external prerequisite that prevents execution.
- A Secondary display/audit issue alone must not turn a confirmed business success into `FAIL` or `MANUAL_REVIEW`.
- 第三方页面不得根据Fidere模块名称推导第三方文档标题或展示文本；仅使用真实DOM和已建立关联的数据作为Oracle。

## Reporting And Secrets

- Initialize reports through `business.flow('<registry-id>', overrides)` for new Flows.
- Report before/after state, Client reference, candidate stages, Admin reference/action, final state, Oracle results, outcome, and Resume stage.
- Mask full customer identity and business identifiers in rendered reports. Do not log credentials, OTP, Security Key, storageState, Cookie, Token, or Authorization values.
- Preserve historical reports. Never rewrite a failed historical Run to look successful.

## Tests And Assets

- L0 Smoke, L1 Validation, L2 Readonly, and L3 Dry Run are safe regression levels and must exclude `@mutation` and `@money`.
- L4 Mutation E2E is opt-in only. L5 requires an explicitly available external Sandbox.
- Validation stops before data creation. Dry Run may open/fill a final form but stops before its final action.
- Reuse fixed, reviewed files in `test-assets/`; do not generate a new upload asset per Run without a business reason.
- Do not use fixed sleeps, `waitForTimeout`, unconditional retries, empty catches, `force: true`, brittle XPath, or layout-dependent selectors to hide instability.

## Live Monitor

- Live Monitor is one platform-wide observer attached to shared Flow Engine and `business.step()` events. Never build a Flow-specific dashboard or make a Flow depend on the monitor.
- With Live disabled, the Flow, Business Report, status, and timing behavior remain unchanged. A monitor/server/dashboard failure must never fail, retry, resume, click, or otherwise alter Playwright execution.
- L0 Smoke, L1 Validation, and L2 Readonly default to Live off. L3 Dry Run may opt in for complex Flows. L4 Mutation E2E should normally be launched with Live after its existing explicit authorization. Fresh User Journey, Corporate Registration, US Account Opening, and complex Wealth runs should use Live when invoked interactively.
- `npm run regression` remains headless and must not start Live Monitor. `npm run test:live` defaults Playwright to headed mode but does not change `.env` or bypass Mutation Guards.
- Live events and business data must use the same masking and whitelist rules as the permanent Business Report. Do not expose credentials, OTP, Security Key, Cookie, Token, Authorization, full email/phone, document contents, or absolute private file paths.
- Live Monitor must not capture a screenshot for each step. Keep evidence capture at the existing failure-only policy.
