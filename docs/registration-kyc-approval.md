# Registration Golden Journey 审核闭环

## 范围

个人和企业保留原注册表单、上传和各自Signer。两个完整注册命令在Client提交后调用同一个 `runRegistrationKycTail`；不再以“等待审核”作为整个Golden Journey通过条件。

| accountType | 案件工作台Tab | Admin业务状态来源 | Client最终Oracle |
| --- | --- | --- | --- |
| PERSONAL | 个人用户 | `/admin-api/operation/kyc/process`，真实reviewStep/stages | 干净登录原账号，entityType=1、kyc_status=1、首页可用 |
| BUSINESS | 企业用户 | `/admin-api/operation/kyb/application`，application状态 | 干净登录原账号，entityType=2、kyb_status=1、首页可用 |

已通过只读页面观察确认两种接口不同，不能用Personal process解析Corporate application。Corporate的模块filled/validated/approved展示标志不能代替application最终状态。

## 状态与恢复

```text
PERSONAL_REGISTRATION_SUBMITTED -> ADMIN_PERSONAL_CASE_FOUND
BUSINESS_REGISTRATION_SUBMITTED -> ADMIN_BUSINESS_CASE_FOUND
  -> 各实际审核阶段分别记录attempt / confirmed
  -> KYC_APPROVED
  -> CLIENT_KYC_APPROVED
```

- Client提交证据确认后即保存sourceRunId、email、可取得的userId和提交时间。
- 定位案件后固定reviewId、userId、processPath；Corporate另固定applicationId。不会通过替换编号推导关联。
- 查询优先精确邮箱。工作台搜索不支持邮箱时，清空搜索并遍历对应Tab的待审分页，再匹配邮箱、名称及既有引用；不搜索带空格姓名、不选第一条。
- 原reviewId已进入处理中时，只读定位原处理中案件。已有详情路径时直接核对固定案件，不能换案。
- 已观察到Personal阶段包括info_review、doc_review；Corporate为当前application审核。每一阶段先保存尝试记录再点击，最多一次。未知阶段不自动点击。
- 审核结果不明确时只读查询。已尝试且仍未确认的阶段禁止重复审核。旧个人文档审核尝试计数会迁入防重日志。
- 未定位案件、审核失败或Client终态未更新时保留同一个已注册账号。下一次命令可通过原runId继续，不能重新上传、签署、提交或分配替代账号。
- 原Client注册store的COMPLETED仅保留“Client资料已提交”兼容语义；新的审核store必须同时含 `kycStage=CLIENT_KYC_APPROVED` 和 `kycVerifiedAt` 才算闭环完成。旧Dashboard-only历史结果不会被当作新证据，也不修改历史报告。

## 命令与权限

完整注册仍使用 `test:registration:personal` / `test:registration:corporate`，需要本次命令显式授权的Client及Admin mutation开关。新注册前先检查Admin认证，不能创建用户后才发现Admin登录失效。

只续跑原申请时设置 `REGISTRATION_APPROVAL_SOURCE_RUN_ID=<原runId>`，运行以下相应命令之一：

```text
npm run test:registration:personal:admin-approval:resume
npm run test:registration:corporate:admin-approval:resume
```

只续跑审核不需要Client mutation开关，不调用注册、签署或上传方法。`ALLOW_ADMIN_MUTATION_TESTS` 只可由获授权的调用进程临时开启，不修改.env。

同时选择两个Resume用例时分别提供 `PERSONAL_REGISTRATION_APPROVAL_SOURCE_RUN_ID` 和 `BUSINESS_REGISTRATION_APPROVAL_SOURCE_RUN_ID`，避免一个通用runId被用于两个不同账号。

所有真实审批均为workers=1、retries=0、repeatEach=1，不自动重跑。已有阶段尝试不能通过换命令绕过。

## 报告与验证

业务报告追加正确Tab、各层candidateCount、脱敏userId/reviewId、每个阶段尝试及确认状态、Admin终态、Client真实KYC终态和Resume阶段。普通Admin用户管理检索仍为非计分Diagnostic，不代替核心案件审核。

本次仅进行类型检查、本地契约/模拟DOM测试和只读真实页面结构确认，没有创建用户或执行真实审批。新增共用尾部尚未执行真实Mutation回归；历史个人/企业成功记录保持不变。

安全验证命令：`npm run typecheck`、`npm run test:registration:kyc:unit`。这组单测使用本地假数据与模拟页面，不连接Sandbox审批。

### 2026-09-07 验证结果

- Typecheck：通过。
- 本地reporting/Flow Engine/Journey回归：56/56通过，其中28项为新增KYC契约与模拟DOM测试。
- 原企业案件只读预检：1/1通过；企业用户Tab、candidateCount=1、KYB详情身份和审核表单均验证成功；Approve=0。
- 已修正工作台分页包含草稿、以及搜索后的No data available占位行造成的加载误判。草稿不进入待审核候选，但不能导致整页无法读取。
- 只读报告：[企业案件预检](../reports/business/history/2026-09-07_16-15-22-9b750690/report.html)。
- 本地回归报告：[本地回归](../reports/business/history/2026-09-07_16-19-01-d1d41b13/report.html)。
- 本阶段未创建账号、未重新上传或签署、未提交Client KYC、未执行Admin审核。三个Mutation开关的.env默认值仍为false；没有开启进程Mutation开关。
- 新版共享审核尾部的真实Approve及最终干净登录联调尚未执行；保留原Run等待明确授权，不把只读预检写成真实闭环通过。
