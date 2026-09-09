# Admin Operations Account Opening

## 范围与真实页面

入口：`运营 -> 客户`，路径 `/zh-CN/operation/clients`。
这是后台直接开通地区账户，不是 Client 发起开户，也不是 KYC 开户审核。
巴林和新加坡为两个独立用例，复用同一 Page Object / Flow，按 `BH | SG` 参数化。
客户类型支持 `PERSONAL | BUSINESS`，本次真实表单验证使用 Personal。

2026-09-09 初始只读查到：`TEST SANDBOX AH` 已启用，巴林、新加坡均未开通。
随后经用户授权，两地区均已真实开通，详见文末结果。不得再用AH测试这两地区的首次开户。
原 Journey 为 `REGP-20260904020924`；邮箱从受忽略保护的原 Journey 读取，不创建新用户。
列表中另有 `TEST SANDBOX CORP AF` 等企业测试用户，两地区未开通；仅作为候选发现，未操作。
邮箱搜索后核对原 UID、个人/企业类型、启用状态和目标地区状态；每层记录 candidateCount。
搜索结果必须完整展示在一页，否则不能声称候选唯一。不得选择第一条/最新一条。

## 表单契约

| 字段 | 实际要求 | 当前用例处理 |
| --- | --- | --- |
| 用户名称 / UID | 弹窗只读显示 | 与列表原客户二次核对 |
| 账户类型 | 巴林账户或新加坡账户 | 只操作对应地区卡片 |
| 开户来源 | 后台手动开通 | 与 Client 开户区分 |
| 当前状态 | 未开通 | 已开户不再点开通 |
| 收款人 | 必填文本框 | 从配置读取，默认测试客户名称 |
| 账户号码 | 必填文本框 | Dry Run 使用地区专属 Sandbox 值；实开需配置批准使用的测试账号 |
| IBAN（选填） | 选填文本框 | 可留空或从配置读取 |
| 开户费金额 | 提示“空或 0 表示免费” | 首版只支持显式授权的 0 费用分支 |
| 开户费币种 | 零费用时禁用 | 不推导为 USD，也不触发收费 |
| 备注 | 选填文本框 | `AUTO_SANDBOX_<runId>` |
| 最终按钮 | 确认开通 | 单次保护；Dry Run 不点击 |

收费分支未确认付款账户和扣费时点，不能借用 Client 巴林开户费用规则。
代码遇到非零或未配置的授权费直接拒绝，不自动改成免费，不充值。
没有在本页面观察到资料上传、第三方签署或 Client SecurityKey 步骤；不调用其他签署组件。

## 用例与命令

| 用例 | 命令 | 当前状态 |
| --- | --- | --- |
| ADMIN-OPEN-BH-DRY | `npm run test:admin:opening:bh:dry-run` | Ready，真实表单验证通过 |
| ADMIN-OPEN-SG-DRY | `npm run test:admin:opening:sg:dry-run` | Ready，真实表单验证通过 |
| ADMIN-OPEN-BH-001 | `npm run test:admin:opening:bh` | Ready，真实开通通过 |
| ADMIN-OPEN-SG-001 | `npm run test:admin:opening:sg` | Ready，真实开通通过 |

两个 Dry Run 可通过 `npm run test:admin:opening:dry-run -- --headed` 顺序运行。
专用测试数据不加入默认 Regression；冻结 Baseline 不变。
实际用例必须单独执行，不提供同时批量开通两个地区的 Mutation 命令。

身份配置：`ADMIN_OPENING_SOURCE_RUN_ID` + `ADMIN_OPENING_USER_ID`。
没有原 Journey 时也可显式配置现有用户的 `ADMIN_OPENING_EMAIL`、`ADMIN_OPENING_DISPLAY_NAME`、`ADMIN_OPENING_ACCOUNT_TYPE`、`ADMIN_OPENING_USER_ID`。

真实执行另需命名 `ADMIN_OPENING_RUN_ID`、本地区 `ADMIN_OPENING_AUTHORIZED_COUNTRY`、显式 `ADMIN_OPENING_AUTHORIZED_FEE=0`、`ADMIN_OPENING_ACCOUNT_NUMBER`。
可选 `ADMIN_OPENING_HOLDER`、`ADMIN_OPENING_IBAN`。默认 `.env` 未改动。
`ADMIN_OPENING_FEE_INPUT=blank` 表示费用框保持空白，完全不触发费用输入；`zero` 表示填入授权的零值。两者均要求显式零费用授权，空白不能绕过授权。
只允许在用户授权该 Run 后临时启用 `ALLOW_ADMIN_MUTATION_TESTS`；本版无资金扣费，不能用于收费分支。
所有命令 `workers=1`、`retries=0`、`repeatEach=1`。

## Oracle 与 Resume

Primary：原客户唯一、本地区未开通、弹窗身份/地区/配置一致、最终确认不重复、重新查询本地区已开户且账号/收款人一致。
不把点击按钮或关闭弹窗当成开户成功；最终状态来自重新加载后的业务列表。
不额外要求 Client 开户申请、KYC 审核或第三方开户订单。

状态：`PREPARED -> ADMIN_LOCATED -> ADMIN_APPROVAL_SUBMISSION_ATTEMPTED -> COMPLETED`。
复用 `FlowStateStore`，身份和表单只存哈希绑定，不保存完整邮箱或银行资料。
确认前保存单次 attempt，额外以客户/地区锁阻止换 Run 重复开通；巴林和新加坡互不混用。
如果确认后不明确，只能用原 Run 只读查询；不再点确认、不编辑已有账号、不改用另一客户。
报告保留历史失败探查，不把 Dry Run 的成功写成已真实开户。

## 本次验证

真实 Admin Dry Run：2/2 通过，两地区候选各 1，最终确认各 0，AH 两地区仍未开通。
初始通过报告：`reports/business/history/2026-09-09_14-43-45-d1080164/report.html`。
最终代码验收报告：`reports/business/history/2026-09-09_14-50-15-816746c1/report.html`，2/2 PASS、通过率100%。
`npm run typecheck`通过；`tests/reporting`共享本地测试135/135通过，其中本流程专项8条。
本地专项测试覆盖表头重排、地区状态分离、个人/企业身份、唯一候选、零费配置、单次确认和持久化 Resume。
曾遇到的探查问题是把只读 POST 查询误拦截，以及搜索时读取到骨架表头；已改为表单阶段防写和原子 DOM 快照，未发生开户 Mutation。

## 真实开通结果

用户授权：继续同一AH，巴林和新加坡均开通，费用不输入直接提交。
2026-09-09 两个独立Run通过Live + headed顺序执行，均为 `workers=1 / retries=0 / repeatEach=1`。

| Run | 原客户候选 | 费用输入 | 最终确认 | 最终状态 | 结果 |
| --- | --- | --- | --- | --- | --- |
| ADMIN-OPEN-BH-AH-20260909 | 1 | 空白，未输入0 | 1 | 巴林账户已开户 | PASS |
| ADMIN-OPEN-SG-AH-20260909 | 1 | 空白，未输入0 | 1 | 新加坡账户已开户 | PASS |

两个地区使用不同的Sandbox占位账号，收款人为TEST SANDBOX AH；重新查询原用户，均确认账号和收款人匹配。
页面“空或0表示免费”作为本次零费依据，没有执行收费流程或独立余额验证。
两个Run均为COMPLETED、无需人工核查、禁止重跑；没有新用户、Client申请、签署或额外开户。
每个测试结束通过finally关闭临时权限；`.env`的三个Mutation开关始终为false。

- 巴林报告：`reports/business/history/2026-09-09_14-58-55-a0130dc8/report.html`
- 新加坡报告：`reports/business/history/2026-09-09_14-59-55-2024c417/report.html`
