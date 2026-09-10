# 巴林 USD 互转手续费

2026-09-10新增三模式×两类转账真实六笔矩阵已完成，见[最新执行与原订单恢复记录](./transfer-fee-matrix.md)。以下保留ATF-002及较早Dry Run的分阶段历史，不覆盖旧用例。

## 独立用例

| Case | Flow Registry ID | 范围 | 执行方式 |
| --- | --- | --- | --- |
| ATF-001 | account-transfer-fee-dry-run | 真实编辑表单取消 + Client 当前费用类型试算 | L3，只读 |
| ATF-002 | account-transfer-fee | 修改配置 + 单笔互转 + 原配置恢复 | L4，具名授权后执行 |
| ATF-002-RECON | account-transfer-fee-reconciliation | 原订单与Admin实际到账只读复核 | L2，不执行资金写操作 |
| ATF-003 | account-transfer-fee-none-dry-run | 免手续费置零/禁用/取消验证 | L3，只读 |
| ATF-004 | account-transfer-fee-fixed-dry-run | 固定手续费单位/范围/精度/取消验证 | L3，只读 |
| ATF-005 | account-transfer-fee-percent-dry-run | 百分比单位/0–100范围/精度/取消验证 | L3，只读 |

不覆盖旧券商资金互转 TR-002/TR-003 或用户间转账 U2U。这是同一 Client 用户的法币账户内部互转。
使用 `CLIENT_USERNAME`、`CLIENT_PASSWORD`、既有登录 OTP 配置和共享 `SecurityKeyDialog`；不新增用户、不造余额。

## 真实页面规则

- Admin：业务配置 -> 账户类型配置 -> 巴林账户（BH）-> 编辑账户类型。
- 区域：支持币种及互转手续费；按“美元”字段定位该币种下拉框和输入，不按位置选择。
- 2026-09-10 新页面三个选项：免手续费(`none`)、固定手续费(`fixed`)、百分比(`percent`)。
- 免手续费：值自动为0，输入禁用，显示“免手续费”。固定：min=0、step=0.01、单位USD，无max。百分比：min=0、max=100、step=0.01、单位%。
- 旧真实Run恢复原固定40.00。新页面检查期间随后读取的当前USD配置为5%；本轮没有执行配置保存，不能用旧40.00覆盖当前值。开户费是另一个字段，不能修改。
- Client：账户 -> 资金互转 -> 法币账户互转；实际路径 `/zh-CN/account/internal-transfer`。
- 默认方向：巴林账户 -> 香港账户，USD；真实执行也可明确指定已支持的新加坡账户为目标，不自动切换。
- 固定费已验证规则：`预估到账金额 = 转账金额 - 固定手续费`。三模式计算分别为0、固定值、金额乘百分比再除100；当前类型从真实Admin配置读取，不把百分比数值当USD。
- 百分比首次试算选100/200 USD等净额精确到分的金额；超过两位小数的收费舍入策略仍需真实业务证据，不自行四舍五入或加容差。
- 两个仅试算金额用于证明固定费不会随金额变化；只提交其中授权的一个金额。
- 互转历史 `/api/transfer/records` 包含其他用户转账，必须筛选 `transferType=internal`。原申请编号 TRF，独立 TXN 另存。
- 历史卡片首屏并非全量。读取实际分页参数，逐页只读查询；总数不一致、重复页或覆盖不完整时不能宣布候选唯一。
- Client历史卡片显示关联TXN、方向、完成状态和转账金额，不展示净额。API `actualAmount` 不等于页面实际到账标签，不能根据键名赋予净额语义。
- 最终到账Oracle复用Admin资金互转列表/详情的“实际到账金额”，通过原Client记录的TXN精确关联、候选唯一、身份和方向二次核对；不执行Admin审批。

## ATF-002 步骤与 Oracle

1. Admin 认证及真实配置页面可读；默认 Client 干净登录、身份/KYC 正常。
2. 保存巴林配置原始快照、旧订单 ID 和现有巴林 USD 可用余额，验证所选方向可用。
3. 只改 USD 固定互转费，保存一次；重新打开配置验证已生效且其他币种、开户费和基础设置均未变化。
4. Client 重新加载页面，两个金额分别验证方向、USD、固定手续费、金额和预估到账。
5. 再次核对当前后台配置未被其他人员更改，填写本 Run 备注，只点击一次提交审核和一次安全密钥验证。
6. 按 `internal + BH/目标账户 + USD + 精确金额 + 本 Run 备注 + 提交时间窗口 + 排除原订单` 匹配唯一新 TRF。
7. 保存原 TRF/TXN，等待原订单真实完成，核对订单金额和手续费；只读Admin同TXN列表与详情，核对明确标注的实际到账金额与原Client确认页一致。不根据 Toast、HTTP 200 或接口键名判成功。
8. 恢复原 USD 固定费一次，重新回读完整配置；恢复也是一次独立 Admin 写操作，必须包含在授权范围内。

以上均为 Primary。无需额外 Admin 审批内部互转；若当前环境实际进入待审，不擅自批准或再转一笔。
不把旧 TR-003 的券商规则、旧历史实际到账字段或 U2U 审核规则套到本用例。

## Resume 与共享配置

领域阶段：

`PREPARED -> APPLY_ATTEMPTED -> CONFIG_UPDATED -> CLIENT_REVIEW_READY -> CONFIRM_ATTEMPTED -> SECURITY_ATTEMPTED -> CLIENT_CREATED -> CONFIG_RESTORED -> COMPLETED`

复用 `FlowStateStore` 保存标准生命周期；`.flow-state/account-transfer-fee/` 保存原配置、金额、编号、时间及阶段，不保存认证信息。
`apply / confirm / security / restore` 分别持久化排他单次尝试标记；点击之后出现错误仅回读，不再次点击。
Resume 保持原用户、Run ID、金额、费用、方向和原订单；已完成 Run 禁止重跑。

后台配置是所有用户共享的设置，真实执行应安排无其他费用编辑/相关资金测试的时段。客户端提交前和恢复前都会比对快照，但这不是服务端事务锁，不能保证阻止外部并发修改。
发现外部改动时不覆盖。安全密钥已验证而原订单仍无法确认时，暂缓再次修改费用，保留现场供原 Run 只读核查。
恢复失败必须明确报告，不能悄悄保留测试费或自动重复保存。
恢复快照同时保留每个币种的费用类型和值；旧版本无类型快照只按旧固定费兼容，不把免手续费或百分比当固定费恢复。

## 新下拉框验证

ATF-003/004/005 真实页面3/3通过，均已Ready（仅L3，Real E2E Verified不适用）。测试值依次为免手续费0、固定0.37 USD、百分比1.25%。
验证全部下拉选项、单位、输入禁用/开启、原生min/max/step约束、只改USD及取消后完整配置不变。没有保存非法值，因此不宣称服务端校验已验证。
报告：[三模式Dry Run](../reports/business/history/2026-09-10_16-11-32-25c94687/report.html)。
当前已保存5%规则的Client只读试算1/1通过：100.00 USD -> 手续费5.00/净额95.00；200.00 USD -> 手续费10.00/净额190.00。最终回读类型和值仍为5%，没有保存或提交。
报告：[Client百分比试算](../reports/business/history/2026-09-10_16-15-34-85918298/report.html)。
旧“仅允许当前固定费”的前置条件在5%下产生一次只读失败，现已改为按当前类型试算；原报告`2026-09-10_16-12-51-d71b7a89`保留，不是资金执行失败。
类型检查及本地单元/报告回归171/171通过。三个新模式尚无本轮真实资金执行，百分比舍入、保存生效/订单/实际到账完整闭环不在以上已通过范围内。

```powershell
npm run test:account-transfer-fee:modes:dry-run -- --headed
```

三个模式共享Page Object，不复制资金Flow。ATF-002原固定费真实用例与旧成功报告保留。
三种类型“保存配置 -> Client生效 -> 真实提交 -> 恢复原类型/值”的完整资金测试尚未执行，需新的具名授权，不能复用已完成的ATF002-20260910-01。

## 运行

安全验证：

```powershell
npm run typecheck
npm run test:account-transfer-fee:unit
npm run test:account-transfer-fee:dry-run
```

Admin 认证过期时，在启动测试前运行现有 `npm run auth:admin`，人工验证码沿用原机制；测试内部不启动交互登录。

ATF-001 要求所有 Mutation 开关关闭。它可以填写测试费后取消，**不会验证“保存新费后客户端生效”**，也不会点击客户端提交或安全密钥验证。

ATF-002 入口为 `npm run test:account-transfer-fee`，不得无授权执行。需要进程级配置：

| 变量 | 要求 |
| --- | --- |
| ACCOUNT_TRANSFER_FEE_RUN_ID | 本次明确授权的唯一 Run |
| ACCOUNT_TRANSFER_FIXED_FEE | 明确授权的新固定 USD 手续费，必须不同于原费 |
| ACCOUNT_TRANSFER_AMOUNT | 明确授权的单笔金额，大于新费，余额足够，不使用全部余额 |
| ACCOUNT_TRANSFER_TARGET | 默认香港账户，可明确选新加坡账户 |
| ACCOUNT_TRANSFER_RESTORE_ORIGINAL | 必须为 true，表示授权最后恢复原配置 |
| ACCOUNT_TRANSFER_FEE_RESUME | 仅原未完成 Run 设 true |
| ALLOW_ADMIN_MUTATION_TESTS | 本次进程 true，结束后恢复 |
| ALLOW_MONEY_TESTS | 本次进程 true，结束后恢复 |

保持 `.env` 默认 false，不修改认证配置、不写入密码/密钥。固定 workers=1、retries=0、repeatEach=1，不自动重跑。

## 报告

中文报告包括原手续费、新手续费、费用类型、两个金额试算、原 TRF/独立 TXN（脱敏）、保存/确认/安全验证/恢复尝试次数、最终订单及原配置恢复状态。
历史报告不可覆盖。ATF-002基于具名真实执行及原订单只读更正复核已Ready，不能仅因Dry Run通过就标记真实E2E已验证。

2026-09-10 ATF-001 真实 Dry Run 通过，已标 Ready：原固定费40.00，试算41.13/41.30 USD，净额1.13/1.30；完整历史26条。
保存配置、恢复配置、Client 提交和安全验证均0次，所有 Mutation 开关 false。
报告：[ATF-001 历史报告](../reports/business/history/2026-09-10_15-19-29-22d204c9/report.html)。
实现阶段类型检查通过；本地 `tests/reporting` 164/164 通过（含本次新增10项费用、DOM、分页、去重和配置恢复测试）。当时未运行真实 ATF-002，未更新 Baseline。

## 首次真实执行：ATF002-20260910-01

2026-09-10 用户明确授权后，只执行1次，无代码修改后的资金重跑。

| 项目 | 真实证据 |
| --- | --- |
| 用户 | `.env` 默认Client，干净登录，KYC/KYB核对通过 |
| 方向/币种 | 巴林 -> 香港 / USD |
| 固定手续费 | 原40.00，设置0.37，结束恢复40.00；完整配置回读一致 |
| 试算 | 11.30/0.37/10.93，以及11.13/0.37/10.76 |
| 唯一原申请 | TRF-****2da8；独立TXN-****8961；候选1 |
| 原订单 | amount=11.13，fee=0.37，status=approved；actualAmount仅为原始接口诊断 |
| 实际到账Oracle | 原Client确认页10.76；原TXN对应Admin列表/详情“实际到账金额”10.76，一致 |
| 单次操作 | 设置保存1，Client确认1，SecurityKey验证1，恢复保存1 |
| 原Run阶段 | COMPLETED，经原订单只读复核推进；不创建替代订单 |
| 自动化结果 | 更正复核PASS；首次误判FAIL的历史报告保留 |
| 人工核查/安全重跑 | 不属于提交不明，不要求资金结果人工核查；禁止安全重跑 |

### ATF-ISSUE-001：自动化错误使用接口字段（已修复）

- 原错误：将 `/api/transfer/records.actualAmount=11.13` 直接赋给净额Oracle，与原确认页10.76比较。未经验证的字段语义导致误判，撤销此前产品金额异常结论。
- 真实页面证据：Admin同一TXN列表及详情的“实际到账金额”均为10.76，转账金额11.13、手续费0.37、状态已批准；用户和方向一致、候选1。Client原订单approved，与原确认页10.76一致。
- 修正保留金额断言：用Admin明确标注的净额、原Client确认页和Decimal计算核对。接口原始actualAmount只作Diagnostic，不影响结果。
- 单次执行后只读回读，后台完整配置已恢复40.00，原四种尝试标记各1；更正期间没有新资金Mutation。
- 源巴林可用余额999950400.00 -> 999950388.87，总余额999950962.00 -> 999950950.87，均减少11.13；冻结仍为562。
- 没有目标香港账户操作前余额，不把actualAmount字段直接等同于独立验证过的目标到账增量，也不猜测净额/手续费服务端口径。
- 原历史报告保持FAIL，不修改、不覆盖；本次之后无再次保存费率、再次提交或再次验证密钥。
- 新增回归覆盖：API原始值11.13且Admin净额10.76应通过；Admin净额错误、用户/原TXN/方向/币种/金额/手续费/状态不匹配、确认页证据缺失仍失败。

[ATF-002 中文历史报告](../reports/business/history/2026-09-10_15-32-09-2d9e10cd/report.html)。
[原订单只读更正报告（PASS）](../reports/business/history/2026-09-10_16-00-21-d85419e6/report.html)。
只读入口：设置原 `ACCOUNT_TRANSFER_FEE_RUN_ID` 后执行 `npm run test:account-transfer-fee:reconciliation`；所有Mutation开关必须false，不重跑L4。
修正后 `typecheck`、专项11/11、本地单元/报告回归165/165通过；未更新Baseline，未重新执行任何资金用例。
运行进程退出时恢复全部Mutation开关为false，`.env`未修改。
