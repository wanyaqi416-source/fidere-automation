# Fidere Flow Engine

## 目录

| 文件 | 职责 |
| --- | --- |
| `definition.ts` | `BusinessFlowDefinition`、L0-L5、Scope和Admin Action元数据 |
| `lifecycle.ts` | 与DOM无关的十二阶段执行器 |
| `client-admin-approval-flow.ts` | Approve/Reject/Claim审批型Flow模板及Resume入口 |
| `candidate-matcher.ts` | 领域可配置的逐层候选筛选与唯一候选硬门禁 |
| `mutation-guard.ts` | Sandbox、开关、执行参数、Client资金确认、安全密钥验证、业务创建和Admin动作的顺序及单次计数 |
| `resume-state.ts` | 白名单状态、单向推进与本地持久化；支持资金确认/安全密钥尝试后的Resume边界 |
| `oracle.ts` | Primary/Secondary Oracle与五种业务结果裁决 |
| `auth-preflight.ts` | Admin优先的双端认证回调编排 |
| `customer-identity.ts` | 邮箱、内部ID或不可逆哈希身份匹配 |
| `unique-amount.ts` | 基于runId的可复现Decimal唯一金额 |

Flow Engine不导入Playwright Page或具体Page Object。领域代码通过回调注入页面行为。Transfer、Deposit和Withdrawal保留原有公共API并委托公共候选、身份、金额、认证及Guard组件；Exchange复用Sandbox与Money Mutation Guard。

## 生命周期

```text
preflight
-> captureBeforeState
-> clientSubmit
-> captureClientReference
-> adminLocate
-> adminVerify
-> adminAction
-> clientWaitFinalState
-> captureAfterState
-> primaryOracle
-> secondaryOracle
-> report
```

进入`CLIENT_CREATED`后，新的Fresh Run默认被拒绝。Resume会跳过Client创建，并从Admin定位或终态查询继续。

## Client Money Mutation

任何会在Client实际扣费或扣款的Mutation统一遵循：

```text
读取确认摘要与操作前余额
-> 单次点击业务/费用确认
-> 共享SecurityKeyDialog
-> 从CLIENT_SECURITY_KEY填写6位密钥
-> 单次点击验证
-> 读取真实余额/订单/状态证据
-> 才记录Client业务创建
```

- 业务确认按钮只表示进入安全验证，不等于资金Mutation已经完成。
- `MoneyMutationGuard`对资金确认、安全密钥验证、Client业务创建分别计数，并在启用`requiresSecurityKey`的Flow中强制执行上述顺序。
- 安全密钥验证点击后结果不明确时，只允许查询余额、业务状态和Admin候选；禁止再次确认、再次验证或Fresh Run。
- 所有领域复用`pages/client/SecurityKeyDialog.ts`；密钥只从`CLIENT_SECURITY_KEY`读取，不写入报告、日志或Trace说明。

## 批处理边界

- `test:smoke`：L0。
- `test:validation`：L1。
- `test:readonly`：仅收集无需专用Resume变量、可重复查询的L2。
- `test:dry-run`：仅收集当前具备稳定测试数据、可重复停在最终动作前的L3。
- `regression`：上述稳定L0-L3集合，命令级排除`@mutation`和`@money`。
- 依赖某次历史订单、特定状态筛选或Resume参数的用例保留独立命令；缺少该上下文属于`BLOCKED`，不应混入默认批次制造假回归。
- `test:money`：交互式单Flow L4入口，不批量执行、不修改`.env`。
