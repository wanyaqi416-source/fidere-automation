# How To Add A Fidere Flow

新增普通Client + Admin审批Flow时，先读取根目录`AGENTS.md`，再从`templates/flow/`开始。公共执行能力位于`src/flow-engine/`。

## 1. 注册Definition

在`config/flow-registry.ts`只维护一次`BusinessFlowDefinition`：

- `id/name/module/priority/level/scope/status`
- `changesData/affectsMoney/requiresClient/requiresAdmin/requiresThirdParty`
- `requiresSecurityKey/safetySwitches/supportsResume`
- `clientAction/adminAction`
- `primaryOracles/secondaryOracles/regressionClass`

Pending Flow不得配置可执行Mutation命令，也不得标记Ready。

## 2. 实现领域Page Object

Client和Admin分别建立领域Page Object。Page Object只负责稳定Locator、读取页面字段和执行一个页面动作，不负责跨系统成功判定。优先`getByRole`、`getByLabel`、`getByPlaceholder`、`getByText`和稳定`data-testid`。

## 3. 定义业务指纹

为该领域配置`CandidateMatchStage[]`。例如用户、账户、币种、Decimal精确金额、状态和可靠时间。每层数量进入报告；最终必须`candidateCount === 1`，随后在详情再次核对。

## 4. 定义Oracle

Primary Oracle只包含决定业务是否成功的核心证据；Secondary Oracle包含全局流水、通知或非核心展示。先明确余额/持仓公式、终态和编号语义，再允许真实E2E。

## 5. 实现L1 Validation

覆盖真实页面规则、必填项、边界和确认页。允许打开安全密钥弹窗，但不点击最终验证；Client/Admin最终动作计数必须为0。

Client侧存在实际扣费/扣款时，必须复用`SecurityKeyDialog`并将“业务确认”“安全密钥验证”“业务创建”作为三个独立阶段。Validation停在验证前；Mutation Flow从`CLIENT_SECURITY_KEY`读取密钥并由`MoneyMutationGuard`保证两个按钮各最多一次。业务确认按钮关闭或HTTP 200都不能单独作为创建成功Oracle。

## 6. 实现L3 Dry Run

完成双端认证、Sandbox检查、历史数据候选匹配、详情二次核对和最终表单填写。停在最后一个会改变数据的按钮之前。

## 7. 执行一次真实E2E

获得逐次明确授权后，使用L4、单worker、零retry、单次点击和双安全开关。Client创建后立即保存Resume状态；后续失败只Resume原业务。

## 8. 标记Ready

真实闭环和只读reconciliation通过后，更新Registry和`docs/automation-status.md`。Secondary异常可以是`PASS_WITH_WARNING`，但必须独立登记；不能篡改历史Run。

## 最小文件集合

```text
config/flow-registry.ts
pages/client/<Domain>Page.ts
pages/admin/<Domain>ListPage.ts
pages/admin/<Domain>DetailPage.ts
src/<domain>/<domain>-e2e.ts
tests/client/<domain>/<domain>-validation.spec.ts
tests/e2e/<domain>/<domain>.dry-run.spec.ts
tests/e2e/<domain>/<domain>.spec.ts
```

Auth、Guard、Resume、Candidate Engine、Oracle Engine、Reporter和History不应为新Flow复制。
