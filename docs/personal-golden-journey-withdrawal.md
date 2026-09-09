# Personal Golden Journey Withdrawal

## 2026-09-07 执行结果

本次继续原已入金用户 TEST SANDBOX AH（`yhd***@mowan666.com`），sourceRunId 为 `REGP-20260904020924`。没有创建新用户、银行地址、入金或额外余额。

| 项目 | 结果 |
| --- | --- |
| 账户 / 币种 | 香港账户 / USD |
| 原收款银行 | FIDERE SANDBOX BANK AH，账号尾号0008 |
| 出金前可用余额 | 11.37 USD |
| 本笔出金 | 1.43 USD |
| Client / Admin订单手续费 | 2.28 USD |
| Admin实际到账字段 | 1.43 USD |
| Client TXN | TXN-****4b35 |
| Client确认 / 安全密钥验证 | 各1次 |
| Admin candidateCount | 1，详情二次核对通过 |
| 实际批准渠道 / 银行 | SWIFT / 汇丰银行 |
| Admin批准次数 | 1 |
| Admin终态 | 处理完成 |
| Client终态 | 已完成 |
| 提交后 / 批准后可用余额 | 7.65 / 7.65 USD |
| 新增出金数量 | 1，原历史为空，最终只有原TXN |
| 当前Resume阶段 | COMPLETED，禁止新建或再次批准 |

第一次执行创建原TXN后，因旧配置渠道“电汇”不在当前页面选项中停止，Admin批准0次。用户随后授权按页面实际渠道继续；第二次仅Resume原申请，跳过全部Client提交步骤，使用SWIFT批准1次。

## 当前通过条件

按最新验收要求，必须真实执行：唯一Admin候选 -> 详情核对 -> 审核通过 -> Admin成功终态，并验证原Client TXN完成且无重复出金。仅发现Admin列表记录不等于审核通过。

已移除原第10步的余额等式硬断言。余额及费用仍保留快照，但作为非计分Diagnostic，不影响PASS、Warning数量或人工核查判定。

本次显示金额存在差异：`11.37 - 1.43 - 2.28 = 7.66`，实际可用余额为`7.65`。该0.01 USD差异未被抹除，原因尚未确定，不据此增加容差、推断额外费用或触发新交易。页面没有提供独立总余额/冻结余额，不能把可用余额变化直接称为冻结。

## 历史报告

- 原创建阶段失败（渠道配置过时）：`reports/business/history/2026-09-07_15-02-15-18f2814c/report.html`。
- 实际批准完成、旧余额标准未通过：`reports/business/history/2026-09-07_15-07-00-8f695f57/report.html`，历史结果保持不变。
- 更新验收规则后只读复核：`reports/business/history/2026-09-07_15-12-08-059a9d75/report.html`，1/1 PASS，无Warning、无人工核查。

## 代码与状态

- `tests/e2e/registration/personal-golden-journey.withdrawal.spec.ts`：原Journey单笔出金、Admin唯一批准和终态；余额Diagnostic。
- `tests/e2e/registration/personal-golden-journey.withdrawal.preflight.spec.ts`：认证、地址、余额和确认页预检，不提交。
- `tests/e2e/registration/personal-golden-journey.withdrawal.readonly.spec.ts`：只读核对原TXN与Admin状态，不批准。
- `src/journey/personal-post-registration-journey.ts`：独立出金快照，保留原入金状态及基线。
- `src/registration/personal-journey-client-session.ts`：支持原用户强制干净登录。
- `src/withdrawal/withdrawal-balance-oracle.ts`：按订单requested/fee/net关系解释费用，不推测缺失费率。
- `pages/client/WithdrawalPage.ts`：支持固定付款账户；不误把其他字段下拉框当账户选择器。
- `pages/client/TransactionsPage.ts`：兼容新用户“暂无交易记录”空状态。
- `pages/admin/WithdrawalListPage.ts`：识别业务页延迟重定向导致的认证失效。
- `tests/reporting/journey-withdrawal.spec.ts`：固定账户与Decimal规则本地测试，5/5通过。
- `config/flow-registry.ts`、`package.json`：注册同一Journey出金命令和平台Live能力。

复用FlowStateStore状态：`PREPARED -> CLIENT_SUBMIT_ATTEMPTED -> SECURITY_KEY_VERIFICATION_ATTEMPTED -> CLIENT_CREATED -> ADMIN_LOCATED -> FIDERE_APPROVAL_ATTEMPTED -> ADMIN_ACTION_DONE -> CLIENT_FINALIZED -> COMPLETED`。每个最终动作之前持久化尝试状态；已存在原TXN时绝不再次创建。

当前Admin渠道真实选项为LOCAL PAYMENT、FPS、SWIFT、Others。先匹配已保存/配置渠道；旧配置不存在时，只允许使用同样在真实列表中的Client转账方式，不默认选第一项。

`ALLOW_MONEY_TESTS`、`ALLOW_ADMIN_MUTATION_TESTS`和`ALLOW_CLIENT_MUTATION_TESTS`的`.env`默认值保持false，进程临时开关已清除。当前订单已经完成，本命令不得用于再提交第二笔或再次批准。
