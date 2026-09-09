# 数字资产地址新增与审核

## 范围

独立于法币银行地址、账户资金互转、用户转账和数字资产出金。
本流程只新增并审核一个受控 Sandbox 钱包白名单，不转出任何资产。
复用原 Journey 用户，不注册、不入金、不造余额。

| 用例 | 范围 | 当前情况 | 命令 |
| --- | --- | --- | --- |
| DA-001 | 必填、币种网络、填写后取消 | 真实页面校验通过 | `npm run test:digital-address:validation` |
| DA-DRY | 地址搜索、详情复核、审核确认框后取消 | 真实页面 Dry Run 通过 | `npm run test:digital-address:dry-run` |
| DA-002 | 新增 -> 安全验证 -> Admin审批 -> Client可见 | Ready；DA002-AH-20260909真实PASS | `npm run test:digital-address` |

## 真实页面契约

Client：头像 -> 设置 -> 地址管理 -> 添加地址。

| 字段 | 规则 |
| --- | --- |
| 地址名称 | 必填，最多50字符；自动化名称绑定命名Run |
| 加密货币类型 | 必填；BTC - Bitcoin、ETH - Ethereum、USDT - Ethereum、USDT - Tron |
| 钱包地址 | 必填，最多200字符；Run绑定明确授权的Sandbox地址。用户明确授权时可生成仅用于白名单测试的格式合法地址，禁止用于真实收款或链上/资金操作 |

新增入口先打开安全验证。复用 `SecurityKeyDialog` 和 `CLIENT_SECURITY_KEY`，不保存或报告密钥。
页面代码还存在2FA和首次设置密钥分支；当前完整用例使用已设置安全密钥的原Journey用户，不自动替用户开启/关闭2FA或新设密钥。

Client提示“提交成功！审核通过后将显示在地址列表中”。因此**不能要求新增后立即出现在Client列表**。
`POST /api/wallet-whitelist-add` 的明确业务响应与Admin真实唯一白名单共同确认创建，不将HTTP200单独作为成功。

Admin：KYC -> 数字资产地址审核，路径 `/zh-CN/kyc/whitelists`。
**搜索框始终输入Client填写的完整钱包地址**，不是用户姓名或邮箱；原白名单ID仅作候选及详情二次校验。
列表字段：白名单ID、客户信息、地址类型、地址、状态、标签、网络、提交时间、操作。

特别区分：列表“状态=启用/禁用”是地址开关，不等于审核通过。
审核状态来自待审核/已通过/已拒绝Tab，并在详情“审核状态”区域再次确认。
详情包含地址类型、网络、完整地址、标签、用户ID、用户姓名、当前状态和提交时间。
批准是“通过 -> 确认通过审核 -> 确认通过”，当前通过操作没有必填备注；拒绝不在本次范围。

## 唯一性与成功条件

按完整地址缩小范围，读取完整分页后分层校验用户可见标识、完整地址、资产、网络、Run标签、原ID与审核状态。
列表若只展示姓名，用户核对延后到详情，不用姓名猜测。详情实际请求返回`id`、`userId`、`memberEmail`；将这些字段与详情DOM及当前Client已认证邮箱关联，正文不保存、不报告。
Client会话只提供姓名/邮箱和KYC状态，不要求不存在的`user.id`。不依赖详情里额外的通用用户查询请求。
地址不做统一小写转换，避免破坏区分大小写的链地址。
候选不是1，禁止审批；详情再次核对后才允许最终确认。

Primary Oracle：

1. 同一已认证Journey用户、同一受控地址和网络。
2. 新增和安全密钥验证最多各一次，存在真实唯一白名单。
3. Admin详情指纹一致，原记录审核状态已通过。
4. Client重新加载后，同一标签/地址/资产/网络的记录可见且启用。

余额、交易流水、链上转账都不属于本用例；启用地址不等于执行了出金。

## Resume 与安全

`PREPARED -> CLIENT_SUBMIT_ATTEMPTED -> SECURITY_KEY_VERIFICATION_ATTEMPTED -> CLIENT_CREATED -> ADMIN_LOCATED -> ADMIN_APPROVAL_SUBMISSION_ATTEMPTED -> ADMIN_ACTION_DONE -> CLIENT_FINALIZED -> COMPLETED`

共用 `FlowStateStore`、`MoneyMutationGuard`、分层Matcher和中文业务报告。
首次绑定源Journey和地址指纹哈希，业务状态只保存引用和时间；三个动作有独占attempt标记。
`.flow-state`不持久化钱包原文、邮箱、密钥或认证数据。用户授权生成的测试地址可固定保存在Git忽略的`test-data/*.local.json`中，避免再次生成；不保存私钥。动作attempt在点击前写入，报告次数按尝试边界统计。
原记录ID首次从实际新增响应（若提供）或唯一Admin白名单读取；不生成伪造ID。
Resume保留原ID，跳过已尝试的新增/安全验证/审批，不删除标记、不重建地址。
验证后无法确认创建或审批后状态不明确时，仅查询原记录。普通Client最终展示失败不触发第二次审批。

实际Run需命名授权匹配 `DIGITAL_ADDRESS_RUN_ID` 与 `DIGITAL_ADDRESS_AUTHORIZED_RUN_ID`，以及临时开启
`ALLOW_CLIENT_MUTATION_TESTS`、`ALLOW_ADMIN_MUTATION_TESTS`。无需开启资金开关。
`workers=1`、`retries=0`、`repeatEach=1`；默认回归排除DA-002；`.env`不被命令修改。
钱包及白名单编号在报告中脱敏。Live Monitor复用平台观察器，可选，不参与结果判定。

## 本次安全验证配置

复用 `DIGITAL_ADDRESS_SOURCE_RUN_ID=REGP-20260904020924`（TEST SANDBOX AH）。
`DIGITAL_ADDRESS_READONLY_REFERENCE=53` 仅用于已存在的待审核历史记录只读检查，**不表示AH新增了该地址**，也不允许审批此历史记录。
真实页面Dry Run按该详情中的完整地址搜索，candidateCount=1，详情和确认框一致；最终创建、密钥验证和审批为0。
校验中占位文本 `SANDBOX-DRY-RUN-NOT-A-WALLET` 只填写后取消，不用作真实钱包。
## 真实执行结果

2026-09-09，用户明确授权`DA002-AH-20260909`使用自动生成的Sandbox测试地址；复用原AH用户，USDT / Ethereum，钱包`0x8b0****c2e1`，白名单`WHITELIST-****54`。

- Client提交1次，安全密钥验证1次；Admin各层候选均为1，详情用户、地址、币种、网络和标签匹配。
- Admin最终确认通过1次，原记录从待审核进入已通过；Client同一地址可见且启用。
- 结果`PASS`，Resume阶段`COMPLETED`，禁止重复新增或审批；不进行资金和链上操作。
- 临时Client/Admin Mutation权限已结束，`.env`三个Mutation/资金开关保持false。
- 之前Admin认证失效的失败历史保留，不重写。本次报告：[中文业务报告](../reports/business/history/2026-09-09_10-37-31-f8ac288a/report.html)。

此地址仅用于本次获授权的白名单测试，不能用于真实收款。后续新Run仍需单独授权；Ready不等于允许自动重跑。
