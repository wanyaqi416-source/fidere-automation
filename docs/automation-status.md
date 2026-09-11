# Fidere Automation Status

## 2026-09-10 三模式两类转账真实矩阵

- `ATFM6-20260910-01` 六笔独立原订单均COMPLETED；固定0.37/百分比5%/免手续费分别覆盖资金互转和用户转账，六项Ready / Real E2E Verified=Yes。
- 实际全部使用巴林USD：11.20/11.40、20.20/20.40、11.60/11.80；未执行余额不足的HKD固定200示例，没有造余额。
- 用户转账均candidateCount=1、批准1次，以Admin成功提交结束，不追加双方余额/流水。六笔安全验证各1次，没有替代订单。
- 首笔响应读取、比例批准状态读取、最后一笔完整候选扫描曾中断；按原订单只读核查/Resume完成，原失败报告不覆盖。原5%完整配置已恢复，三个Mutation开关false。
- [六笔结果、编号与各中文历史报告](./transfer-fee-matrix.md)。最后一笔TXN尾号0849审批Resume于17:00通过。

## 2026-09-10 巴林 USD 互转手续费

- 新增独立 ATF-001（配置编辑取消与原手续费试算）和 ATF-002（修改固定费、单笔法币账户互转、恢复原配置）。复用默认 Client 账号，不覆盖券商互转或用户间转账用例。
- 新页面支持免手续费、固定手续费、百分比。ATF-003/004/005实际页面Dry Run 3/3通过，Ready（仅L3）；未保存配置或转账。报告：`reports/business/history/2026-09-10_16-11-32-25c94687/report.html`。
- 原巴林USD固定40.00属于旧Run恢复快照；本轮稍后读取当前配置已是5%。当前类型和值按页面读取，不覆盖外部修改。只读试算已适配三种类型；百分比使用精确到分的示例，不猜舍入策略。
- 当前5% Client只读试算1/1通过：100/200 USD手续费5/10，净额95/190；前后配置一致，未保存或提交。报告：`reports/business/history/2026-09-10_16-15-34-85918298/report.html`。旧仅固定费前置造成的只读失败历史保留，现已适配当前模式；类型检查及本地回归171/171通过，Baseline不变。
- ATF-002 已 Ready / Real E2E Verified=Yes：首次真实 Run 完成后，只读复核确认金额11.13、手续费0.37、实际到账10.76一致。首次FAIL是自动化误用接口字段，不是产品金额错误；原失败历史保留。
- ATF-001 真实 Dry Run 1/1 通过，Ready：编辑后取消并回读原配置，41.13/41.30 USD 两次试算固定费均为40，净额1.13/1.30；完整读取26条历史。报告：`reports/business/history/2026-09-10_15-19-29-22d204c9/report.html`。此前只读调试失败报告保留，不作为真实资金执行。
- 具体页面规则、授权参数与配置恢复约束见 [固定互转手续费用例](./account-transfer-fee.md)。
- 实现阶段 `typecheck` 通过，本地单元/报告回归164/164通过；该阶段没有资金Mutation，未更新Baseline。
- 授权 `ATF002-20260910-01` 单次真实执行：默认账号巴林 -> 香港，11.13 USD；改费保存1次、安全验证1次、Client确认1次、恢复原费1次。候选1，原TRF状态approved；配置40.00 -> 0.37 -> 40.00，其他配置回读一致。
- 字段更正：Client原确认页预估到账10.76；Admin原TXN列表与详情明确标注实际到账10.76、手续费0.37、已批准。`/api/transfer/records.actualAmount=11.13`仅保留为原始诊断字段，不作为净额Oracle。金额断言保留，改用真实业务标签的值。
- ATF-002-RECON 只读复核1/1 PASS，原Run推进COMPLETED，无再次改费、提交、密钥验证或审批。更正报告：`reports/business/history/2026-09-10_16-00-21-d85419e6/report.html`；原误判报告：`reports/business/history/2026-09-10_15-32-09-2d9e10cd/report.html`。不要求人工核查，禁止重跑，所有Mutation开关false。
- 更正后类型检查和本地单元/报告回归165/165通过，未更新Baseline。

## 2026-09-09 DP-004 入金拒绝新用例

- `deposit-rejection-journey` / `DP-004`：In Progress，Real E2E Verified=No；不覆盖旧 DP-002 历史结果。
- `DP-004-PREFLIGHT`：Ready，可视化只读预检通过；TEST SANDBOX AH 原KYC/银行地址已通过，香港账户USD余额794.62，拟入金11.56，待处理冲突0。
- `DP004-AH-20260909` 已获授权执行：Client提交1次，`/api/confirm-deposit` HTTP 200；随后60秒未读取到唯一新增Client入金记录/详情TXN，标记 `DEPOSIT_SUBMISSION_UNCONFIRMED` / `MANUAL_REVIEW`。不能据此断言后端未创建申请。
- Admin拒绝0次，余额最终断言未执行；原Run处于 `CLIENT_SUBMIT_ATTEMPTED`，只允许原申请只读复核，不得重提。所有Mutation开关已恢复false。
- 后续只读复核通过：Admin入账认领没有TXN，按真实业务字段扫描324条，香港账户161 → USD104 → 金额11.56为1 → 状态/渠道/原提交时间/用户均为1；原申请状态“待处理”，详情一致。Client候选仍为0，当前余额794.62 USD。原申请已存在，不得新建；此次拒绝/认领/批准均为0，不代表DP-004拒绝闭环已通过。
- 只读证据：`reports/business/history/2026-09-09_15-55-41-ff215b2e/report.html`。Admin调查已解除对Client TXN的前置依赖；原真实执行报告与提交标记保留。
- 16:15 经用户授权Resume原申请：重新唯一定位并详情核对，Admin确认拒绝1次，原记录已拒绝；余额794.62=794.62。Client原入金历史在60秒内仍返回missing，因此完整DP-004尚未通过，原状态推进至 `ADMIN_ACTION_DONE`。禁止再次拒绝/新建，所有开关已恢复false。报告：`reports/business/history/2026-09-09_16-16-51-70c01185/report.html`。
- 16:23 只读复核再次确认Admin原候选1、已拒绝、余额794.62；Client全局流水及入金历史卡片仍未被当前读取器观察到。只读报告：`reports/business/history/2026-09-09_16-23-23-33c3bf13/report.html`，不代表完整拒绝用例PASS。一次中间列表扫描314条/候选0，后续324条/候选1，列表刷新/分页一致性待查；没有因此重提或重复拒绝。类型检查和145项本地单元/报告测试通过。
- 核心判定保留Client原申请拒绝终态和余额严格不变；授权Resume允许用已核对的唯一Admin业务指纹证明原申请存在，不虚构TXN。旧入金审核通过用例不覆盖、不执行。详见[独立用例与Resume](./deposit-rejection-journey.md)。

本表由`config/flow-registry.ts`中的状态生成原则维护。未实现、缺少可恢复数据或缺少唯一业务Oracle的流程不得标记为Ready。

业务订单编号统一遵循[Business Order ID Model](./business-id-model.md)：资金互转`TRF-*`、兑换`OTC-*`、入金/出金`TXN-*`、理财`INV-*`。流水或Admin侧的独立`TXN-*`必须使用不同字段保存，不做前缀推导。

| Flow | Priority | Scope | Status | Real E2E Verified | Business Result | Automation Result | Regression |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Login | P0 | Client | Ready | Yes | Passed | Passed | Default |
| REG-P-002 Personal Registration | P0 | Client+Admin+Third Party | Ready | Yes | Passed | Passed after reconciliation | Mutation / On demand |
| REG-P-003 Personal Registration Admin Approval | P0 | Client+Admin | Ready | Yes | Passed | Passed | Mutation / Resume only |
| REG-C-001 Corporate Registration Validation | P0 | Client | Ready | N/A | N/A | Passed | On demand / Read-only |
| REG-C-002 Corporate Registration Happy Path | P0 | Client+Admin+Third Party | Ready | Yes | Passed | Passed | Mutation / On demand |
| REG-C-003 Corporate Registration Admin Approval | P0 | Client+Admin | Ready | Yes | Passed | Passed | Mutation / Resume only |
| Client Smoke | P0 | Client | Ready | Yes | Passed | Passed | Default |
| Client Read-only Regression | P0/P1 | Client | Ready | Yes | Passed | Passed | Default |
| DA-001 Digital Address Validation | P0 | Client | Ready | N/A | N/A | Passed | On demand / Read-only |
| DA-DRY Digital Address Review | P0 | Client+Admin | Ready | N/A | N/A | Passed | On demand / Read-only |
| DA-002 Digital Address Approval | P0 | Client+Admin | Ready | Yes | Passed | Passed | Mutation / On demand |
| TRUST-BEN-003 Beneficiary Resume Reconciliation | P0 | Client+Admin | Ready | N/A | Blocked | Passed | On demand / Read-only |
| TRUST-BEN-002 Trust Beneficiary Golden Journey | P0 | Client+Admin | Ready | Yes | Passed | Passed | Mutation / Resume only |
| Exchange Validation | P0 | Client | Ready | N/A | N/A | Passed | Default |
| Exchange Security Key Validation | P0 | Client | Ready | N/A | N/A | Passed | Default |
| Exchange Reconciliation | P0 | Client | Ready | Yes | Passed | Passed | On demand / Read-only |
| Exchange | P0 | Client | Ready | Yes | Passed | Passed | Money |
| TR-001 Transfer Validation | P0 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| TR-002 Transfer Reject | P0 | Client+Admin | Ready | Yes | Passed | Passed | Money / On demand |
| TR-003 Jurisdiction -> Broker Approve | P0 | Client+Admin | Ready | Yes | Passed | Passed With Warning | Money / On demand |
| TR-004 Broker -> Jurisdiction Approve | P1 | Client+Admin | Pending | No | Not Run | Not Run | Money / On demand |
| TR-005 Transfer Roundtrip | P2 | Client+Admin | Pending | No | Not Run | Not Run | Low-frequency Money |
| WD-001 Withdrawal Validation | P0 | Client | Ready | N/A | N/A | Passed | On demand / Read-only |
| WD-002 Withdrawal Reject | P0 | Client+Admin | Ready | Yes | Passed | Passed | Money / On demand |
| WD-003 Withdrawal Approve | P0 | Client+Admin | Ready | Yes | Passed | Passed | Money / On demand |
| DP-001 Deposit Validation | P0 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| Deposit Reconciliation | P0 | Client+Admin | Ready | N/A | N/A | Passed | On demand / Read-only |
| DP-003 Resume Reconciliation | P0 | Client+Admin | Ready | N/A | N/A | Passed | On demand / Read-only |
| DP-002 Deposit Reject | P0 | Client+Admin | Ready | Yes | Passed | Passed | Money / On demand |
| DP-003 Deposit Claim (Hong Kong USD) | P0 | Client+Admin | Ready | Yes | Passed | Passed | Money / On demand |
| ADMIN-MD-001 Manual Fiat Deposit | P0 | Client+Admin | Ready | Yes | Passed | Passed after reconciliation | Money / On demand |
| OPEN-TIGER-003 Tiger Broker Opening | P0 | Client+Admin | Ready | Yes | Passed | Passed after original-application Resume | Money / On demand |
| OPEN-001 Account Opening Validation | P0 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| OPEN-US-001 US Validation + Documenso Dry Run | P0 | Client+Third Party+Admin | Ready | N/A | N/A | Passed | Default / Read-only |
| OPEN-US-002 Historical Reject Reconciliation | P0 | Client+Admin | Pending | N/A | Not Run | Not Run | Read-only / No Mutation |
| OPEN-US-003 US Account Opening Happy Path | P0 | Client+Third Party+Admin | Blocked | No | Failed | Failed | BLOCKED_BAAS_FAILED / No rerun |
| OPEN-US-004 BaaS Failure Recovery | P0 | Client+Third Party+Admin | Pending | No | Not Run | Not Run | External / Resume only |
| OPEN-SG-001 Existing Singapore Account Readonly | P1 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| OPEN-SG-002 Singapore First Opening | P1 | Client+Admin | Ready | Yes | Passed | Passed | On demand / Money Mutation |
| OPEN-BH-001/DRY Bahrain Validation + Dry Run | P1 | Client+Admin | Ready | N/A | N/A | Passed | Default / Read-only |
| OPEN-BH-003 Bahrain Approve Happy Path | P1 | Client+Admin | Ready | Yes | Passed | Passed | External / On demand |
| WS-001 Wealth Subscribe Validation | P1 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| Wealth Subscribe Dry Run | P1 | Client+Admin | Ready | N/A | Blocked | Passed | Default / Read-only |
| WS-002 Wealth Subscribe Reject | P1 | Client+Admin | Ready | Yes | Passed | Passed | WS002-20260909-173401真实执行一次：1.60 USD认购后拒绝，资金恢复，无新增有效持仓；Money / Explicit authorization only |
| WS-003 Wealth Subscribe Approve | P1 | Client+Admin | Ready | Yes | Passed | Passed | Money / Explicit authorization only |
| WR-001 Wealth Redeem Validation | P1 | Client | Ready | N/A | N/A | Passed | Default / Read-only |
| Wealth Redeem Dry Run | P1 | Client+Admin | Ready | N/A | N/A | Passed | Default / Read-only |
| Wealth Redeem Mutation | P1 | Client+Admin | Blocked | No | Not Run | Not Run | Money / On demand |

## Personal Registration Note

`TEST SANDBOX AC`（sequence 3）的Registration Agreement已完成，Client最终提交后在Admin“
KYC审核案件工作台 -> 个人用户”生成了对应唯一用户案件。该Admin案件是注册资料已落库的
最终业务证据，因此REG-P-002业务结果为Passed并标记Ready。

历史自动化Run因Client未跳转、`kyc_step_status=pending`及响应中未继续暴露`signature`字段而
误判失败；历史报告保持不变。`pending`在此表示等待Admin KYC审核，不能覆盖Admin案件已经
生成的事实。后续Flow以最终提交接口业务码和Admin KYC案件为Oracle，不得再次提交该账号。

2026-09-02修正最终提交契约：Registration Agreement完成后还必须单次点击页面右下角“提交”。该动作调用`POST /api/member-profile`并进入`sign-success`；`POST /api/create-kyc-doc`仅用于创建签署文档，不能作为最终资料提交证据。

同日针对新账号`TEST SANDBOX AE`的唯一Fresh/Resume执行确认了一个独立产品缺陷：Registration Agreement已完成、剩余字段为0、Fidere签署状态为1，但页面重载后没有恢复本页签署完成门禁。右下角蓝色`提交`虽可操作，单次点击未发出`POST /api/member-profile`且未进入等待审核页。该账号保持`FIDERE_SIGNING_RECOGNIZED`，没有创建第二个账号；本次Run判定失败且禁止继续点击。此结果不改写此前`TEST SANDBOX AC`已经由Admin KYC案件复核成功的历史Run。

同日续跑同一`TEST SANDBOX AF` Journey时，Registration signer已改为点击PDF/Konva Canvas中的真实待签字段，不再把右侧签名偏好控件当成文档字段。本次`Remaining Fields 1 -> 0`、TEST Canvas签名1次、Complete/Sign各1次；Fidere签署状态为1后，当前页第一次蓝色Submit产生`POST /api/member-profile` 200并进入“等待审核”。没有reload recovery、没有第二次Submit、没有创建第二个账号。

2026-09-03执行REG-P-003时，该原Personal账号已经在“用户管理”的已通过KYC活跃用户中唯一存在，待审核候选为0。为避免重复审核，本Run未点击Approve（Approve=0），只读确认Admin成功终态和原账号Dashboard可访问，Resume从`CLIENT_KYC_SUBMITTED`推进到`COMPLETED`。该结果证明原注册审核闭环终态，不宣称本Run重新执行了Personal Approve。

## Corporate Registration Note

REG-C-001已完成9个真实页面步骤和全分支28个上传位置Recon；REG-C-002采用最小合法结构：1名授权代表、1名自然人董事、0名法人董事、1名个人股东、0名企业股东，实际适用资料20/20。

2026-09-03，`TEST SANDBOX CORP AA`同一Journey真实Resume通过。企业基本档案、运营信息、资产来源、合规问询和授权代表均作为独立页面完成；嵌入式Documenso通过绿色`Next Field`定位签名字段并完成Canvas `TEST`签署，Remaining Fields归零。Corporate KYC最终提交仅点击1次，`POST /api/kyb/submit-application`返回HTTP 200，Client进入`等待审核`，没有创建第二个企业账号。REG-C-002现为Ready且Real E2E Verified=Yes；Admin Post-Registration查询仍只是非计分Diagnostic。

同日REG-C-003从该原申请的`CLIENT_KYC_SUBMITTED`状态Resume。Admin通过email/displayName、Corporate类型、提交时间和待审核状态唯一定位1条候选，复核企业资料、自然人董事、个人股东/UBO与电子签名后仅Approve 1次；Admin进入已通过KYC活跃终态，原企业账号随后可进入Client Dashboard。未创建新企业账号、未重新上传20份适用资料、未重复签署或Client提交。REG-C-003现为Ready。

## Exchange Note

EX-001原始业务结果为成功、原始自动化结果为失败，历史报告保持不变。修复后的只读reconciliation已从交易流水列表读取`TXN-*`流水编号，并从对应“兑换 详情”读取`OTC-*`订单编号；两个编号分别保存并完成金额、币种、手续费、日期与状态交叉验证。Exchange现为Ready，但真实兑换仍只属于Money Regression。

## Transfer Note

TR-001已覆盖真实双向入口、EUR/USD/HKD、两位小数金额、Decimal费用预览和共享安全密钥弹窗。Validation仅点击一次`提交审核`以打开弹窗，填写`CLIENT_SECURITY_KEY`后停在`验证`前并安全关闭，因此没有创建申请。

TR-002不依赖`TRF-*`与Admin `TXN-*`直接映射。完整E2E、Client TRF定向查询、法域余额Oracle、Admin列表/详情、审核抽屉、双开关门禁和候选唯一性守卫均已实现；代码以测试用户、转出/转入账户、币种、精确金额、Client提交时间窗口和Admin待审核状态形成业务指纹，并硬性要求`candidateCount === 1`。

2026-08-26重新采集`auth/admin.json`后，双端认证预检和只读Dry Run均通过。随后真实TR-002由用户确认执行成功：Client生成唯一`TRF-*`申请，Admin业务指纹候选恰好1条，详情完成用户、方向、币种、金额和创建时间二次核对，最终拒绝只点击一次；Client原TRF进入拒绝终态，法域余额没有最终扣减，也没有创建第二条Transfer。TR-002现为Ready、Real E2E Verified为Yes，仅进入Money Regression。

TR-003真实批准闭环已完成：Admin候选唯一且详情匹配，Admin最终状态为`已批准`，Client原TRF最终状态为`已完成`，香港账户USD余额从`99894823.09`准确减少`80.02`至`99894743.07`，手续费`40.00`，券商实际到账`40.02`。八项Primary Oracle全部通过，因此业务结果为Passed。

Client全局“交易流水”未出现对应Transfer记录，无法读取Client流水TXN编号。该项已降为Secondary Oracle并独立登记，不覆盖已经成立的核心资金证据。TR-003自动化结果为Passed With Warning；无需人工核查，但原资金业务已经完成，所以不允许安全重跑。TR-001、TR-002、TR-003均Ready，Transfer Flow整体标记为Ready。

所有资金Flow在实现前必须按[Oracle分级模型](./oracle-model.md)定义Primary与Secondary Oracle。Secondary异常不得自动升级为业务失败或人工核查。

## Withdrawal Note

Withdrawal真实入口为Client账户页`法币转出`，Client业务编号为`TXN-*`，从全局交易流水的`提现`类型及`法币转出 详情`读取。Admin入口为`法币资产管理 -> 出金审批`；列表使用测试用户邮箱搜索，再通过法域账户、币种、Decimal精确金额、状态和时间窗口形成业务指纹，收款人只在详情二次核对，并硬性要求`candidateCount===1`。

WD-001、历史只读Reconciliation和WD-002/WD-003 Dry Run均已通过。随后WD-002拒绝闭环与WD-003批准闭环分别通过受控真实执行：原Client TXN、Admin唯一候选、详情二次核对、单次Admin Action、Client终态和余额Oracle均已确认。Withdrawal整体为Ready，但所有真实出金仍仅属于显式授权的Money Regression。

## Deposit Note

DP-001已在真实Sandbox验证银行电汇入金的四类法域账户、币种矩阵、打款银行、必填字段和两位小数金额，并在`提交`前停止。历史只读Reconciliation已通过Client历史与Admin`入账认领`完整业务指纹得到唯一候选，认领详情和拒绝入口均可用，最终操作点击次数为0。

Client入金订单遵循`TXN-*`。当前全局交易流水列表显示系统TXN，点击唯一入金行可打开`法币转入 详情`；详情中同名“交易编号”字段对本次记录显示Client电汇指令参考号，因此代码分别保存系统TXN与详情显示值，不做语义替换。Admin入账认领页没有独立业务编号，DP-002/DP-003依赖客户稳定指纹、账户、币种、精确金额、状态、渠道和时间窗口，并保持`candidateCount===1`。Client附言不回写Admin参考号，因此参考号不属于强制指纹。Sandbox流程不依赖外部银行/BaaS回调；当前阻塞集中在真实闭环验证和数据恢复能力。

DP-002真实拒绝闭环已完成：Client只创建一笔`11.18 HKD`申请，Admin候选数为1且详情一致，确认拒绝只点击一次；最终Client原`TXN-*`状态为`rejected`，Admin状态为`已拒绝`，香港账户HKD余额`70.07 -> 70.07`，全局流水也显示同一TXN、`+11.18 HKD`和`已拒绝`。五项Primary Oracle与全局流水Secondary Oracle全部通过，无需人工核查且不允许重跑原申请。DP-002现为Ready。

DP-003单次提交的`香港账户 / USD / 11.97`申请先经只读Reconciliation取得唯一Client TXN与唯一Admin候选，再以Resume方式完成Admin认领。原Client TXN终态、Admin状态和USD余额增加均通过Primary Oracle；没有创建第二笔申请。原失败Run永久保留，DP-003及Deposit整体现为Ready。

## Platform Model

### Admin Operations Opening 2026-09-09

新增独立 `ADMIN-OPEN-BH-001` 和 `ADMIN-OPEN-SG-001`，入口为运营客户页面，不复用Client开户或KYC审批路径。
两条真实提交前Dry Run通过：AH原客户唯一，两地区均未开通；必填收款人、账号及零费用表单可填写，最终确认0次。
随后用户授权AH两地区均开通且费用不填；`ADMIN-OPEN-BH-AH-20260909`与`ADMIN-OPEN-SG-AH-20260909`顺序真实执行成功。
两地区候选各1，最终确认各1，费用框保持空白；重新查询均为已开户且账号和收款人正确。两条开户用例Ready、Real E2E Verified=Yes、结果PASS；原Run均COMPLETED且禁止重跑。
Admin临时权限已关闭，三个Mutation开关均为false。AH现在不再适合作为这两个地区的首次开户Dry Run数据；能力状态不因此降级。
支持个人/企业参数化；不重新注册、不签署、不充值、不修改冻结Baseline。详见[运营客户地区开户](./admin-operations-account-opening.md)。

### Webull Opening 2026-09-09

`OPEN-WEBULL-001`预检Ready；`OPEN-WEBULL-003`完整开户Ready、Real E2E Verified=Yes。
原AH的`OPEN-WEBULL-AH-20260909`已恢复两份原签署结果，未重签；Client微牛申请30、安全验证1次、Admin候选1条、最终通过1次。Admin已开户，Client已开通，原Run为COMPLETED。
香港USD从894.62降至794.62，实际费用100.00 USD。三个Mutation开关均恢复false，没有额外入金或第二条申请。
原始签署及只读失败报告保留；新报告明确记录原生init-sign对两份文档均返回signed=true。微牛独立Signer不修改个人、企业或US签署组件。详见[微牛开户](./webull-broker-opening.md)。冻结Baseline不变，完整Mutation不进入默认回归。

- L0 Smoke、L1 Validation、L2 Readonly Reconciliation、L3 Dry Run可进入安全回归。
- L4 Mutation E2E必须显式选择单条Flow并开启对应安全开关；不进入`npm run regression`。
- L5 External Sandbox要求外部渠道Sandbox和可控终态。
- Registry是Definition、菜单、Reporter元数据和状态的唯一来源。
- 公共生命周期、Candidate Matcher、Mutation Guard、Resume和Oracle位于`src/flow-engine/`。
- 默认L2/L3只收集无需专用Resume参数且测试数据可重复的用例；数据绑定的历史Postcheck/Dry Run继续保留专项命令。

2026-08-28冻结`FIDERE AUTOMATION BASELINE V1`：L0 Smoke `10/10`、L1 Validation `16/16`、稳定L2 Readonly `7/7`、稳定L3 Dry Run `4/4`、完整安全Regression `34/34`。Baseline业务结果为32条`PASS`、2条已知TR-003全局流水Secondary Oracle的`PASS_WITH_WARNING`，无失败、阻塞或人工核查。Baseline只允许通过`npm run baseline:update`显式更新，普通Regression只读比较。

同日Readiness批次新增OPEN-001、WS-001、WR-001三条Validation，以及开户、认购、赎回三条L3 Dry Run。美国开户第三方页面通过`app.documenso.com` iframe加载，实际签名方式为Canvas Draw，固定`TEST / TEST / T`签署Recon已通过；日期和认证Checkbox由文档预填，无Initial、OTP或Captcha。

2026-08-31首次受控OPEN-US-003 Run通过十项Preflight并上传5份固定Sandbox资料，但Documenso当前草稿已经保留此前Dry Run的TEST签名，页面直接显示`0 Fields Remaining`与可用`Complete`。旧实现仍强制寻找`Next Field`，因此在最终Complete之前技术失败。`Complete=0`、Client最终提交`=0`、Admin批准`=0`、Admin候选`=0`，没有创建开户申请；历史失败报告保持原样。Resume状态为`DOCUMENTS_UPLOADED`，Fresh Run已阻断，只能在新的明确授权下从原草稿Resume。OPEN-US-003保持`In Progress`，不能标记Real E2E Verified。

随后人工确认Documenso的`Full Name`应保持开户测试用户的文档预填值，只有Canvas签名值必须为`TEST`，因此删除了`Full Name=TEST`错误门禁并将Resume迁移到`DOCUMENT_READY_TO_COMPLETE`。2026-08-31正式Resume通过双端认证、5份资料、TEST Canvas签名和`0 Fields Remaining`预检，单次点击`Complete`后成功打开`Are you sure?`确认框；自动化又错误要求确认框文档名包含`FATCA`，因此在绿色`Sign`前停止。实际计数为`Complete=1`、`Sign=0`、Client提交`=0`、Admin批准`=0`、候选`=0`，没有创建开户申请，也不需要人工核查。该文档名解析已按真实DOM修正但未重跑；OPEN-US-003仍为`In Progress`，等待新的明确Resume授权。

同日新的单次Resume删除标题过度断言后成功完成Documenso：`Fields Remaining=0`、`Complete=1`、确认`Sign=1`，且没有重传资料、改写Full Name或重绘签名。开户页面的提交入口只打开真实“确认开通并扣费”弹窗，不代表Client申请已创建；当时`openFeeConfirmation=1`、`feeConfirmation=0`、`applicationCreate=0`，所以Admin候选0是正确结果。随后Fee Resume只读Preflight真实读取`USD 500`、付款账户`信托账户`和可用余额`5900 USD`，验证Admin认证与Interlace配置有效，并以`feeConfirmation=0`、Security Key验证0次、Mutation=false通过。当前业务状态为`CLIENT_FEE_CONFIRMATION_REQUIRED`；后续只能经新的明确资金授权Resume原草稿。

同日后续唯一Fee Resume完成至第三方处理阶段：五份资料与Documenso Canvas `TEST`签名沿用原草稿，Complete/Sign各1次；页面读取并单次确认`USD 500`开户费，SecurityKey验证1次，信托账户短时`5900 -> 5400 USD`，Client只创建一条美国开户申请，Admin候选严格为1且详情匹配，Fidere Approve只执行1次。最终只读复核却确认Client=`已拒绝`、Admin原reviewId=`failed`，信托余额恢复为`5900 USD`；当前没有第二条申请或重复扣费。Resume=`BAAS_FAILED`，OPEN-US-003不能标记Ready，历史各次报告继续原样保留。

2026-08-31 Readiness刷新：Bahrain Validation与双端Dry Run再次通过，专用用户仍为`可申请`，页面开户费`USD 100`、上传控件0、Client/Admin最终动作0，因此OPEN-BH-003进入`Mutation Ready`。Wealth Subscribe读取9条Client `INV-*`，修复状态Tab切换后的Locator恢复后，已在Admin取得1条同编号唯一候选并打开详情；该历史订单为终态，Approve/Reject入口均不可用，基金页持仓行与赎回动作仍为0，所以WS-002/003仍未达到Mutation Ready，WR继续`BLOCKED_TEST_DATA`。

2026-09-11 `OPEN-BH-003-AF-20260911`真实闭环通过：`TEST SANDBOX AF`从Client提交唯一巴林账户申请，页面开户费为`100 USD`、付款账户为香港法币账户；共享SecurityKey验证一次后生成原申请`103`。Admin按邮箱、账户类型、`审核中`状态和时间窗口唯一定位，candidateCount=`1`，详情核对后Approve一次。最终Admin=`审核通过`、Client=`已开通`，香港账户USD余额`200 -> 100`，实际扣费与页面金额一致；未创建第二条申请。OPEN-BH-003更新为`Ready / Real E2E Verified`。

## Baseline V1 Verification

2026-09-08新增 `ADMIN-MW-001` Admin普通手动出金：复用原AH用户，独立于Client出金审批。
实现专用Page Object、原Journey认证/余额预检、单次最终确认、持久化attempt和中文报告。
初始专项单测11/11、AH提交前Dry Run 1/1通过；该Dry Run余额907.65不变、最终确认0次，历史报告保留。
随后显式授权Run `MW001-AH-20260908`真实通过：11.03 USD出金、2.00 USD手续费，最终确认1次，Admin业务响应与成功状态均明确，余额907.65降至894.62。Money Flow更新为`Ready`、Real E2E Verified为Yes、Business/Automation Result均Passed。原Run已COMPLETED，禁止重跑，三个Mutation开关已关闭。
详见`docs/admin-manual-withdrawal-flow.md`，不改动冻结Baseline。

2026-08-31最终安全验证结果：TypeScript类型检查通过；Validation `23/23`；Dry Run修复一次只读Admin状态Tab Locator恢复问题后 `10/10`；Regression技术结果 `48/48`。业务裁决为41条PASS、2条已知Secondary Oracle警告、5条Readiness Blocked、0条FAIL、0条MANUAL_REVIEW。相对冻结的34条Baseline新增14条测试：新增PASS 9条、Readiness blocker 5条、新增FAIL 0条、原有用例回归0条；Baseline文件未更新，全程未执行Mutation。
