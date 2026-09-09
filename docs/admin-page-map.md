# Fidere Admin Page Map

本页基于 `auth/admin.json` 在真实 Admin 测试环境中的实际勘察结果整理。勘察日期为 2026-08-25。除文末记录的理财认购审批意外外，勘察仅浏览、筛选、打开详情或审核表单，未执行审核、拒绝、调账、配置修改或删除。

## 权限与导航概览

- 当前账号可见 6 个一级菜单：`KYC审核`、`运营`、`业务配置`、`权限管理`、`系统配置`、`系统工具`。
- 共打开并验证 32 个二级页面，均未出现无权限页面。
- 登录态来自 `auth/admin.json`。失效时必须快速失败并提示运行 `npm run auth:admin`，不得自动进入图形验证码登录。
- 页面 URL 中的 `{id}`、`{userId}`、`{reviewId}`、`{recordId}` 为运行时标识，文档不记录真实客户资料或完整业务编号。

## KYC审核

| 页面 | URL | 核心功能与主要字段 | 详情/操作入口 | Page Object 建议 |
| --- | --- | --- | --- | --- |
| 案件工作台 | `/zh-CN/kyc/dashboard` | 个人/企业 tab；待处理表含客户信息、提交日期、状态；拒绝表含拒绝原因、拒绝时间、审核员 | `查看详情`、`开始处理`、`重新审核` | `AdminKycDashboardPage` |
| 用户管理 | `/zh-CN/kyc/userManagement` | 搜索用户名、ID、客户编号；状态筛选；客户信息、申请类型、通过时间、账户状态、最后活动 | `查看详情`、`修改密码` | `AdminKycUsersPage` |
| 用户详情 | `/zh-CN/kyc/userManagement/{userId}` | 基本信息、文档资料、白名单、三方状态、操作记录；三方状态显示 Sumsub 身份验证 | tab 内查看；无资金操作 | `AdminKycUserDetailPage` |
| 处理中审核 | `/zh-CN/kyc/processingReviews` | 搜索客户名称；状态筛选；客户信息、审核类型、当前步骤、审核时间、进度 | `查看详情`、`开始处理` | `AdminProcessingReviewsPage` |
| 法币账户审核 | `/zh-CN/kyc/fatAccounts` | 待审核/已通过/已拒绝；搜索账户 ID、用户名、账号；银行/机构、账号、持有人、提交时间 | `查看详情` | `AdminFiatAccountReviewPage` |
| 法币账户详情 | `/zh-CN/kyc/fatAccounts/{id}` | 账户类型、银行、账号、持有人、开户行、SWIFT、中间行、用户 KYC 与审核状态 | `拒绝`、`通过`；页面未展示审核备注字段 | `AdminFiatAccountReviewDetailPage` |
| 数字资产地址审核 | `/zh-CN/kyc/whitelists` | 待审核/已通过/已拒绝；搜索地址 ID、用户名、地址；币种筛选；地址类型、网络、标签、状态 | `查看详情` | `AdminWhitelistReviewPage` |
| 信托管理 | `/zh-CN/kyc/trust` | 搜索信托名称、编号或用户名；用户信息、信托名称/编号、设立时间、受益人、文件、待处理 | `查看详情` | `AdminTrustManagementPage` |
| 审核日志 | `/zh-CN/kyc/auditLogs` | 搜索操作人员；请求方式筛选；日志编号、模块、方法、人员、部门、URL、主机、地点、时间 | `详情` | `AdminAuditLogsPage` |
| 开户审核 | `/zh-CN/kyc/accountReviews` | 个人/企业 tab；搜索客户 ID、名称或邮箱；状态筛选；客户信息、提交日期、状态 | `查看详情`、`开始处理` | `AdminAccountOpeningReviewsPage` |
| 开户详情/处理 | `/zh-CN/kyc/accountReviews/{userId}`；`.../{userId}/process?reviewId={reviewId}` | 美国、新加坡、巴林账户申请；身份、地址、证件、资金来源、FATCA 签署状态；处理页含审核决定和备注 | 最终按钮 `保存修改并提交审核` | `AdminAccountOpeningReviewDetailPage` |
| 券商开户管理 | `/zh-CN/kyc/brokerAccountManagement` | 个人/企业 tab；按客户名称、ID、邮箱、申请编号搜索；券商/状态筛选；客户、券商、提交时间、开户状态 | `查看详情`、`开始处理` | `AdminBrokerAccountReviewsPage` |
| 券商开户详情/处理 | `/zh-CN/kyc/brokerAccountManagement/{recordId}`；`.../{recordId}/process` | 申请概览、文档资料、客户/券商/状态/提交时间；处理状态为审核通过或审核拒绝，可填处理说明 | 最终按钮 `保存处理结果` | `AdminBrokerAccountReviewDetailPage` |

## 运营

| 页面 | URL | 核心功能与主要字段 | 详情/操作入口 | Page Object 建议 |
| --- | --- | --- | --- | --- |
| 概览 | `/zh-CN/operation/dashboard` | 资产、客户、交易概览；最近活动含类型、客户、金额、状态、时间 | 法币/数字资产、理财、客户快捷入口；`查看全部交易` | `AdminOperationDashboardPage` |
| 客户 | `/zh-CN/operation/clients` | 搜索用户名、ID、客户编号；状态筛选；客户与资产运营视图 | 行级详情 | `AdminClientsPage` |
| 资产中心 | `/zh-CN/operation/assets` | `资产总览`、`按客户查看` | tab 切换 | `AdminAssetCenterPage` |
| 法币资产管理 | `/zh-CN/operation/fiatAssets` | `总览`、`客户资产`、`流水查询`、`入账认领`、`出金审批`、`资金互转`、`对账中心` | tab 内详情、认领/拒绝/审批/审核 | `AdminFiatAssetsPage` + tab 组件对象 |
| 数字资产管理 | `/zh-CN/operation/digitalAssets` | `总览`、`按客户`、`流水`、`出金审核`；页面明确标注与 Safeheron 对接 | 出金审核 `审核`、`拒绝` | `AdminDigitalAssetsPage` |
| 交易管理 | `/zh-CN/operation/transactions` | 按用户邮箱、日期、交易类型筛选；编号、用户、交易编号、类型、来源资产、目标资产、时间、状态 | 只读列表；可导出 Excel | `AdminTransactionsPage` |
| 账变流水 | `/zh-CN/operation/accountLedger` | 可按业务交易编号/账变流水号、用户、账户、币种、券商、网络、交易类型、方向查询；展示前后余额与手续费 | `查看`账变详情及关联账变 | `AdminAccountLedgerPage` |

### 法币资产管理 tab

| Tab | 搜索/筛选 | 主要字段 | 操作与风险 |
| --- | --- | --- | --- |
| 总览 | 资产统计和最近活动 | AUM、净流入、待认领、待审批、未匹配来账 | `手动入金`、`手动出金`会改资金，本次未打开 |
| 客户资产 | 币种、客户搜索 | 客户、账户类型、总资产、币种、最后活动 | 选中客户查看最近流水 |
| 流水查询 | 日期、客户 ID、交易/资金类型、状态、关键词 | 时间、客户、账户、币种金额、类型、方向、渠道、参考号、状态 | 只读 |
| 入账认领 | 处理状态、匹配状态、日期、参考号/付款人/备注 | 提交时间、账户、金额、实际入账金额、付款人、渠道、参考号、凭证、匹配客户、状态；无独立业务编号 | `认领`抽屉要求实际入账金额和必填备注；`拒绝`抽屉要求必填原因；PO为`DepositClaimListPage`/`DepositClaimDrawer`/`DepositRejectDrawer` |
| 出金审批 | 状态、日期、客户/收款人 | 客户、账户、金额、手续费、收款人、用途、状态 | `审批` |
| 资金互转 | 类型、状态、日期、客户/收款人 | Admin `TXN-*`编号、类型、转出/收款客户、账户、金额、手续费、状态、时间 | `审核`、`查看详情`；与Client `TRF-*`不做直接映射 |
| 对账中心 | 匹配状态、日期、关键词 | 日期、金额、参考号、类型、匹配状态、备注 | 只读匹配结果 |

## 业务配置

| 页面 | URL | 核心功能与主要字段 | Page Object 建议 |
| --- | --- | --- | --- |
| 账户类型配置 | `/zh-CN/operation/account-type-configuration` | 名称/代码、地区、渠道、分类、主币种、支持币种、开户费、资料要求、状态；当前可见香港、美国、新加坡、巴林等 | `AdminAccountTypeConfigPage` |
| 提现服务费配置 | `/zh-CN/operation/withdrawServiceFee` | 按用户 ID 搜索；用户、计费方式、服务费规则、是否使用平台默认 | `AdminWithdrawFeeConfigPage` |
| 币种管理 | `/zh-CN/operation/feeManagement/digitalCurrency` | 按币种 key、名称、全名搜索；币种、网络及状态配置 | `AdminCurrencyConfigPage` |
| 费率中心 | `/zh-CN/operation/feeCenter` | 按用户 ID/邮箱搜索；法币兑法币、数币兑法币、数币兑数币费率 | `AdminExchangeFeeCenterPage` |
| 券商配置 | `/zh-CN/operation/brokerManagement` | 券商代码、市场、标签、开户费、账户类型、资料数、处理时间、状态；当前启用 Webull、IBKR、Tiger | `AdminBrokerConfigPage` |
| 理财产品 | `/zh-CN/operation/financialProducts` | 产品列表、认购管理、赎回管理；产品、风险、收益、AUM、订单状态 | `AdminFinancialProductsPage` + `SubscriptionReviewPanel` + `RedemptionReviewPanel` |
| 信用卡管理 | `/zh-CN/operation/creditCard` | 交易流水、信用卡审核；按卡号/商户搜索 | `AdminCreditCardManagementPage` |

## 权限管理、系统配置与系统工具

这些页面当前账号均可访问，但不属于 Client 核心业务闭环，Recon 仅确认页面结构，后续业务 E2E 不应修改。

| 一级菜单 | 页面 | URL | 主要字段/能力 | Page Object 建议 |
| --- | --- | --- | --- | --- |
| 权限管理 | 菜单管理 | `/zh-CN/admin/authMenu` | 菜单名称、路由、排序、权限、状态 | `AdminMenuManagementPage` |
| 权限管理 | 角色管理 | `/zh-CN/admin/authRoles` | 角色名称、权限、状态 | `AdminRoleManagementPage` |
| 权限管理 | 部门管理 | `/zh-CN/admin/authDept` | 部门名称、状态 | `AdminDepartmentManagementPage` |
| 权限管理 | 岗位管理 | `/zh-CN/admin/authPost` | 岗位名称、编码、状态 | `AdminPostManagementPage` |
| 权限管理 | 用户管理 | `/zh-CN/admin/authUser` | 部门、用户名、手机号、状态 | `AdminUserManagementPage` |
| 系统配置 | 字典管理 | `/zh-CN/admin/dictList` | 字典名称、类型、标签、状态 | `AdminDictionaryPage` |
| 系统配置 | 参数管理 | `/zh-CN/admin/configList` | 参数名称、键、类型、状态 | `AdminSystemParametersPage` |
| 系统工具 | 定时任务 | `/zh-CN/admin/jobList` | 任务名称、分组、状态、执行信息 | `AdminScheduledJobsPage` |
| 系统工具 | 附件管理 | `/zh-CN/admin/sysAttachment` | 应用 ID、类型、扩展名、原始文件名 | `AdminAttachmentsPage` |

## 账户与第三方配置实况

| 账户/服务 | 页面证据 | 自动化含义 |
| --- | --- | --- |
| 香港账户 | `HK`、`hk_bank`、onshore、无需开户资料、开户费 0 | 可作为低依赖法币账户候选，但仍需专用数据与重置能力 |
| 美国账户 | `US`、`interlace`、offshore、需要开户资料；详情可见 FATCA 签署状态 | 存在第三方开户和签署状态，不是纯 Admin 即时闭环 |
| 新加坡账户 | `SG`、`sg_bank`、offshore | 依赖外部开户渠道状态 |
| 巴林账户 | `BH`、`EU_BLANK`、offshore | 渠道配置名称疑似占位值，需环境负责人确认 |
| 数字资产 | 页面明确写明与 Safeheron 对接 | 出金审批后仍可能等待托管/链上完成 |
| KYC | 用户详情显示 Sumsub 身份验证状态 | KYC 完成依赖第三方身份验证 |
| 券商 | Webull、IBKR、Tiger；预计 3–7 个工作日 | 存在审核中、需关注、已开户等中间状态 |

## 可测性备注

- 多数审核列表使用稳定的 tab、输入框和有名称按钮，可优先使用 `getByRole`、`getByPlaceholder`。
- `法币资产管理` 的 7 个业务区域共用同一 URL，Page Object 应按 tab/组件拆分，不能只用 URL 判断页面状态。
- `开户审核`搜索不含申请编号；`资金互转`搜索框只标注客户/收款人，且Admin `TXN-*`与Client `TRF-*`未确认直接映射。
- `交易管理`显示交易编号但没有交易编号搜索框；精确追踪应转到`账变流水`按业务交易编号查询。
- 理财认购/赎回详情里的批准按钮是最终动作，未提供二次确认。自动化代码必须显式隔离只读 Recon 与写操作。
