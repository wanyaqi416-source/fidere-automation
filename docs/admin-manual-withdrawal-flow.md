# Admin 普通手动出金 / ADMIN-MW-001

## 范围

- 复用 `TEST SANDBOX AH` 的原 Personal Journey，来源 Run 为 `REGP-20260904020924`。
- 独立于 Client 提交出金 -> Admin 出金审批，不调用 Client 出金、SecurityKeyDialog、入金或开户。
- Admin 实际入口：法币资产管理 -> 手动出金。
- 提交前 Dry Run 与后续显式授权的 `MW001-AH-20260908` 均已通过；Money Flow 为 `Ready`，`Real E2E Verified = Yes`。原Run已完成，禁止重跑。

## 真实表单

2026-09-08 已在 Sandbox 页面核对：

| 字段 | 当前用例行为 |
| --- | --- |
| 选择客户 | 只用原 Journey 邮箱搜索，精确邮箱匹配，候选必须为 1；姓名只二次核对 |
| 选择账户 | 香港账户；运行时确认选项存在且唯一 |
| 操作类型 | 普通出金；费用扣除、调账为其他业务，本用例不选择 |
| 币种 | USD；当前香港账户还展示 HKD |
| 打款渠道 | 实际选项 LOCAL PAYMENT、FPS、SWIFT、Others；本次 Dry Run 选择 SWIFT |
| 银行账号 | 原有 FIDERE SANDBOX BANK AH，持有人 TEST SANDBOX AH、尾号 0008，唯一选中 |
| 出金手续费 | 从实际表单读取；本轮为 USD 2.00，不硬编码手续费 |
| 出金金额 | Decimal；Dry Run 使用 11.03 USD；真实执行必须明确提供授权金额 |
| 备注说明 | 必填，`AUTO_SANDBOX_MANUAL_WITHDRAWAL_<runId>` |
| 上传凭证（可选） | 当前不是必填，本次未上传；不混用 Client 支持性文件或审批表单必填凭证 |

页面提示此操作直接扣减客户余额。表单按钮 `确认出金` 仅打开标题为 `确认手动出金` 的二次确认框。
确认框显示客户、操作类型、币种/金额、银行和备注。框内 `确认手动出金` 才调用资金操作。
已从当前加载的页面代码核对 handler：`handleManualWithdrawalSubmit` 打开确认框，
`handleManualWithdrawalAction` 才调用 `/operation/fiat/manual-withdraw`。
本流程不再进入另一条 Admin 审核，也不假定存在 Client 安全密钥弹窗。

## 执行步骤

1. 校验 Sandbox、命名 Run、原 Journey、授权金额和资金/Admin 双开关；固定单 worker、零重试、单次执行。
2. Admin 认证预检；Client 以原用户干净登录并验证 KYC，仅做余额读取。
3. 读取香港 USD 可用、冻结、总余额。
4. 打开 Admin 手动出金，按邮箱选择唯一客户、香港账户和原银行，填写普通出金摘要。
5. 读取实际手续费，保证可用余额严格大于金额与页面手续费之和，避免全额出金。
6. 打开二次确认框并核对；此时资金提交计数仍为 0。
7. Dry Run 在此取消，验证最终资金请求为 0、余额未变。
8. 后续已授权 Money Run 在最终点击前重新读余额、持久化 attempt，再点击一次框内最终确认。
9. 验证同源手动出金 POST、业务成功响应、Admin “手动出金成功”状态和确认框/表单关闭。
10. 保存业务结果、实际业务引用（响应存在时）、脱敏网络元信息。只读记录 Client 余额变化，不套用 Client 出金公式。

## 状态与成功标准

`PREPARED -> CONFIRMATION_READY -> SUBMISSION_ATTEMPTED -> COMPLETED`

Primary：正确原用户/账户/银行唯一且摘要匹配；最终确认仅 1 次；服务端业务响应成功且 Admin 明确显示手动出金成功。
HTTP 200、点击成功、表单消失或 Toast 任一单独信号都不足以判定成功。
首次真实执行还需要核实响应的业务成功 envelope，未知 schema 不自动接受。

余额快照属于 Diagnostic，不将尚未证实的 `金额+手续费` 或 `金额-手续费` 写成余额 Oracle。
预检中的 `余额 > 金额+手续费` 只是保守资金余量检查，不代表已确认实际扣费方式。
通过本用例表示 Admin 手动出金业务提交成功，不表示已证明外部银行实际汇款到账。

Resume 保存在 `.journey-context/admin-manual-withdrawal/`，只保存原 Journey 引用、Run、金额币种、状态、计数和余额观测等白名单。
最终点击前写入独占 `.attempt` 标记；进程退出、旧对象或相同 Run 重新启动都不能再次扣款。
未知结果标记 `MANUAL_WITHDRAWAL_SUBMISSION_UNCONFIRMED`，只允许核查原 Run 的 Admin 流水/业务记录和余额，禁止再次确认、替换 Run 或创建 Client 申请。

## 命令

安全验证（默认三个 Mutation 开关均关闭）：

```powershell
$env:MANUAL_WITHDRAWAL_SOURCE_RUN_ID='REGP-20260904020924'
npm run typecheck
npm run test:admin:manual-withdrawal:unit
npm run test:admin:manual-withdrawal:dry-run -- --headed
```

可执行完整用例命令为 `npm run test:admin:manual-withdrawal`，不加入默认 regression。
必须在用户授权一个命名 Run 和具体金额后，提供 `MANUAL_WITHDRAWAL_RUN_ID`、
`MANUAL_WITHDRAWAL_AUTHORIZED_AMOUNT`、`MANUAL_WITHDRAWAL_AUTHORIZED_FEE`，仅在该进程开启 `ALLOW_MONEY_TESTS` 和 `ALLOW_ADMIN_MUTATION_TESTS`。
真实提交前两次核对页面手续费等于授权手续费；费用变化时不得执行最终确认。
菜单/Live Monitor 继续复用 Registry 与 Business Flow 步骤，不能绕过任何开关；已完成的Run不得重新执行。
配置模板已加入 `.env.example`；不修改 `.env`，不记录密码、密钥或完整身份信息。

## 初始安全验证

- 类型检查通过；本地安全/兼容测试11项通过（含原手动入金守卫测试）。
- AH真实Dry Run通过：香港USD可用/总余额均为907.65，冻结0，取消后仍为907.65；测试填写11.03，页面手续费2.00。
- 确认框打开1次、最终确认0次、手动出金POST请求0次，没有创建出金或更改余额。
- Dry Run能力Ready；ADMIN-MW-001仍In Progress，未执行真实Money Run，不标Real E2E Verified。
- 历史报告：`reports/business/history/2026-09-08_17-30-36-45b2b642/report.html`。探测/失败历史不覆盖。

## 首次真实执行

2026-09-08用户明确授权 `MW001-AH-20260908`：原AH香港账户，11.03 USD出金，手续费2.00 USD，单次执行、不重跑。

- Admin/Client认证通过；客户、香港账户及尾号0008银行账户候选各1；SWIFT渠道；确认摘要匹配。
- 手续费在表单和最终点击前均核对为授权的2.00 USD。
- 二次确认框打开1次，框内最终确认1次，同源 `POST /admin-api/operation/fiat/manual-withdraw` 1次。
- HTTP200之外同时验证了业务成功响应、Admin“手动出金成功”状态、确认框和表单关闭。
- 香港USD可用及总余额从907.65降至894.62；本次实际扣减13.03 = 11.03 + 2.00 USD，未新增冻结。
- 响应未提供解析器可识别的业务编号，未编造TXN；原Run和脱敏请求元信息已保留。业务提交成功不代表外部收款银行到账已独立验证。
- `COMPLETED` / `PASS`；无重复提交，无Client出金申请，无额外Admin审批。三个Mutation开关均已恢复false，`.env`未改写。
- 历史业务报告：`reports/business/history/2026-09-08_17-42-02-55a5a78a/report.html`。
