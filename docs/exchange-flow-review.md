# Exchange Flow Review

Review date: 2026-08-26

| # | Review item | Result | Evidence / conclusion |
| --- | --- | --- | --- |
| 1 | Client自动登录不依赖旧状态 | Pass | `client-auth`使用空storageState和干净上下文；Client项目通过dependency每次重新登录并覆盖`auth/client.json` |
| 2 | 完整兑换业务步骤 | Pass | 报价 -> 确认兑换 -> 安全密钥验证 -> 成交 -> Decimal余额校验 -> 交易记录校验均在EX-001中 |
| 3 | 两个最终按钮单次点击保护 | Pass | `ExchangePage`分别保存确认和验证点击状态，第二次调用直接失败 |
| 4 | retries=0 | Pass | npm命令、describe配置和资金用例运行时`testInfo.project.retries`三层校验 |
| 5 | workers=1 | Pass | 资金命令固定单worker，用例在提交前检查解析后的worker数 |
| 6 | 禁止repeatEach | Pass | 用例提交前要求`testInfo.project.repeatEach === 1`且`repeatEachIndex === 0` |
| 7 | 默认资金开关关闭 | Pass | `.env`默认`ALLOW_MONEY_TESTS=false`；模块skip、Client自动fixture和用例前置均检查资金门禁 |
| 8 | 禁止生产环境 | Pass | Client自动fixture和EX-001均只接受已识别测试域名，生产域名快速失败 |
| 9 | 金额精度 | Pass | 余额、报价和差额均使用`Decimal`及项目money工具 |
| 10 | Exchange双编号模型 | Pass | 交易流水列表读取真实`TXN-*`作为`ledgerTransactionId`；点击唯一记录后从“兑换 详情”读取真实`OTC-*`作为`exchangeOrderId`，两者不做前缀替换或推导 |
| 11 | 可靠定位本次记录 | Pass | 使用当前账号上下文、交易类型、币种对、金额、到账、状态和执行窗口，禁止默认取第一条 |
| 12 | 结果不明确不重复提交 | Pass | 验证后立即标记潜在提交、重复风险和禁止安全重跑；不会再次点击确认或验证 |
| 13 | 危险等待或强制操作 | Pass | Exchange代码无`waitForTimeout`、固定sleep、`force:true`或空catch |
| 14 | 中文业务报告字段 | Pass | 步骤、预期/实际、汇率、手续费、余额和状态均可展示；TXN流水编号与OTC订单编号分字段脱敏展示 |
| 15 | 敏感数据保护 | Pass | 账号、密码、OTP、安全密钥、Cookie、Token和Authorization均被禁止写入业务报告；网络证据仅保存路径、状态码和请求时间 |
| 16 | 余额不可自动恢复 | Pass | 测试数据和blocker文档已记录余额会持续变化，禁止反向兑换充当回滚 |

## Review Decision

Exchange真实业务成交、只读reconciliation和全部资金安全条件均已验证。客户端页面同时提供列表`TXN-*`流水编号和详情`OTC-*`订单编号，正式Review通过：

- Status: Ready
- Priority: P0
- Scope: Client
- Type: Money / Mutation
- Real E2E Verified: Yes
- Requires Admin: No
- Requires Third Party: No
- Default Regression: No
- Money Regression: Yes

编号Oracle：先按类型、币种、金额、状态和时间窗口唯一定位流水，从列表读取`ledgerTransactionId`；再打开对应“兑换 详情”，从详情读取`exchangeOrderId`及成交字段。两个编号必须来自真实页面，禁止相互推导。
