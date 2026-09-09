# Fidere Client + Admin E2E Flow Map

本文把 Client 提交、Admin 处理、Client 验证和资金账变串成同一条链路。所有写操作设计都以专用 Sandbox、唯一业务编号和可恢复数据为前置条件；当前 Recon 没有执行这些闭环。

统一订单编号模型：资金互转/用户互转为`TRF-*`，兑换为`OTC-*`，入金和出金为`TXN-*`，理财为`INV-*`。交易流水或Admin处理记录中的独立`TXN-*`按页面语义另存，详见`docs/business-id-model.md`。

## 闭环总览

### Admin Manual Withdrawal / ADMIN-MW-001

原已入金用户 -> Admin邮箱唯一选择客户 -> 香港USD与原银行账户 -> 普通手动出金表单
-> 二次确认 -> Admin单次最终确认 -> 明确的服务端业务响应及Admin成功状态。
这不是Client出金申请/出金审批，不能复用原Client提交链路。`MW001-AH-20260908`已真实通过，Flow为Ready；出金11.03 USD、手续费2.00，Admin最终确认1次，原Run禁止重跑。
运行后余额观测为Diagnostic，实际收费公式不从Client出金推导。详见`docs/admin-manual-withdrawal-flow.md`。

### Trust Beneficiary / TRUST-BEN-002

现有Personal用户与信托 -> Client单次创建唯一受益人 -> 为同一受益人创建唯一银行账户
-> Admin按用户邮箱与Trust Number唯一定位信托 -> 受益人管理候选唯一
-> 详情二次核对 -> 单次审核通过 -> Client状态同步。

如果受益人与银行账户是两个独立Admin Mutation，受益人审核完成后必须停止并取得新的明确授权，不能连续审批。

当前`TBEN-20260908-AH-01`只执行过一次受益人提交；Client干净重载与Admin信托详情均未观察到该记录，阶段为`BENEFICIARY_CREATION_UNCONFIRMED`。禁止再次提交受益人；银行账户和Admin审核均未执行。详见`docs/trust-beneficiary-flow.md`。

`TBEN-20260908-AH-02`已完成真实闭环：`TEST BENEFICIARY AB`和唯一USD银行账户创建成功，Admin候选唯一且详情字段全部匹配，受益人单次审核通过，Client最终显示`审核通过`。当前页面未暴露银行账户独立Admin审核入口，因此该Run最终阶段为`BENEFICIARY_DATA_VERIFIED`，TRUST-BEN-002标记为Ready。

### Personal Registration / REG-P-002

唯一Sandbox账号 -> 个人KYC资料 -> Registration Agreement TEST签署 -> Fields Remaining=0
-> Fidere识别签署完成 -> 单次点击页面右下角“提交” -> `POST /api/member-profile`
-> 进入`sign-success` -> Client最终提交完成
-> Admin KYC审核案件工作台个人用户列表生成唯一案件。

sequence 3 `TEST SANDBOX AC`已经人工核对存在对应Admin KYC案件，业务闭环视为成功。
Client提交后仍显示`pending`表示等待Admin审核；缺少页面跳转或响应不再暴露`signature`
属于可观测性差异，不得触发第二次提交。

`POST /api/create-kyc-doc`只代表创建Registration Agreement，不是最终资料提交。最终提交必须以右下角“提交”单次点击、`member-profile`成功响应和`sign-success`页面作为核心证据。

### Corporate Registration / REG-C-002

唯一Sandbox企业账号 -> 基本档案 -> 运营信息 -> 资产来源 -> 合规问询 -> 授权代表
-> 1名自然人董事（不创建法人董事） -> 1名个人股东（不创建企业股东）
-> 上传本Journey适用资料20/20 -> 进入授权页 -> 嵌入式Documenso绿色`Next Field`
-> Canvas `TEST`签名 -> Remaining Fields=0 -> 单次最终提交
-> `POST /api/kyb/submit-application` HTTP 200 -> Client进入`等待审核`。

Corporate外层页面由`CorporateRegistrationSigner`负责；真实DOM已证明内层Documenso签署契约与个人注册一致，因此复用已验证的字段跳转、Canvas、Complete和Sign生命周期。全分支资产目录保留28个映射，首条自然人董事/个人股东Happy Path只使用实际适用的20个字段。2026-09-03真实Run仅创建1个企业账号、最终提交1次，REG-C-002现为Ready。

### Registration Admin Approval / REG-P-003 + REG-C-003

```text
原Client KYC提交
-> Admin认证Preflight
-> KYC审核案件工作台按账号类型定位
-> email + displayName + 类型 + 提交时间 + 待审核状态形成唯一候选
-> Admin详情二次核对
-> Admin Approve最多1次
-> Admin已通过KYC / 活跃
-> 原Client账号进入Dashboard
```

REG-P-003目标账号在审批Run开始前已经通过KYC，因此本Run按唯一已通过用户复核，Approve=0，未重复审核。REG-C-003对`TEST SANDBOX CORP AA`原申请得到`candidateCount=1`，详情复核后Approve=1，Admin与Client均进入成功终态。两个Resume均未重新注册、签署或提交Client KYC。

| 流程 | Admin 入口 | 编号精确搜索 | 余额影响 | 第三方 | 当前分类 |
| --- | --- | --- | --- | --- | --- |
| 法币入金认领 | 法币资产管理 -> 入账认领 | 否；完整业务指纹候选可唯一 | 拒绝保持不变；认领增加实际入账金额 | Sandbox不依赖外部回调 | B，Ready |
| 法币出金 | 法币资产管理 -> 出金审批 | 否；邮箱搜索加完整业务指纹可唯一 | 拒绝恢复；批准按真实规则最终扣减 | Sandbox固定凭证 | B，Ready |
| 数字资产出金 | 数字资产管理 -> 出金审核 | 地址/日期筛选，无业务编号输入 | 已有账变证据 | Safeheron/链上 | C |
| 资金互转 | 法币资产管理 -> 资金互转 | 列表有申请编号，但搜索不支持 | 成对扣增并计费 | 券商互转可能依赖券商 | B/D |
| 美国/新加坡/巴林开户 | KYC审核 -> 开户审核 | 否 | 可能产生开户费 | 地区渠道、签署 | C |
| 券商开户 | KYC审核 -> 券商开户管理 | 是，支持申请编号 | 可能产生开户费 | Webull/IBKR/Tiger | C |
| 理财认购 | 理财产品 -> 认购管理 | 是，支持订单号 | 扣减余额、增加持仓 | 产品/托管规则 | B |
| 理财赎回 | 理财产品 -> 赎回管理 | 是，支持订单号 | 减少持仓、增加余额 | 产品/托管规则 | B |
| 兑换 | 交易管理 + 账变流水 | 交易管理否；账变流水是 | 卖出扣减、买入增加 | 报价服务 | A |

## A. 法币入金

```text
Client 前置状态
  Client/Admin认证有效；目标法币账户已开通；记录初始余额；两个安全开关显式开启
-> Client 操作
  进入银行电汇入金；选择账户/币种/打款银行；填写唯一11.xx金额、渠道、用途和资金来源；单次提交
-> 获取业务编号
  保存提交时间；进入交易流水，按入金类型、账户、币种、精确金额和时间窗口定位唯一记录
  点击唯一记录打开法币转入详情；分别保存列表系统TXN-*与详情显示的电汇指令参考号
-> Admin 搜索方式
  入账认领：匹配客户稳定指纹 + 账户 + 币种 + 精确金额 + 待处理状态 + 渠道 + 时间窗口
  Admin无独立编号，candidateCount必须严格等于1
-> Admin 处理
  打开认领抽屉二次核对；DP-002填写原因后拒绝，DP-003填写备注并认领实际入账金额
-> Client 最终状态
  DP-002原TXN进入拒绝/失败终态；DP-003原TXN进入已完成
-> 余额变化
  DP-002无不应有增加；DP-003 afterBalance = beforeBalance + actualDepositAmount
-> 交易记录
  Client原入金记录为Primary；法币流水、对账记录和全局账变为Secondary
-> 数据恢复方式
  需要测试环境冲正/重置 API；不能删除账变，也不能用手动出金伪装清理
```

**当前状态**：DP-001、历史只读Reconciliation、DP-002拒绝闭环和DP-003认领闭环均已通过。DP-003使用原`11.97 USD`申请Resume完成，没有创建第二笔入金；Client原TXN终态、Admin认领状态与余额增加一致。详见`docs/deposit-flow.md`。

## B1. 法币出金批准

```text
Client 前置状态
  已登录；目标账户余额充足；收款账户已审核；记录可用/冻结/总余额
-> Client 操作
  提交唯一金额和用途的出金申请
-> 获取业务编号
  保存 Client 出金订单号和提交时间
-> Admin 搜索方式
  出金审批：客户/收款人 + 日期 + 金额；当前不能按订单号搜索
-> Admin 处理
  核对收款人、金额、手续费和订单身份；填写打款渠道、银行、凭证、审批备注；批准
-> Client 最终状态
  处理中 -> 完成，或第三方失败
-> 余额变化
  提交后冻结；完成后最终扣减。具体时点待受控 E2E 证实
-> 交易记录
  出金订单、法币流水、账变流水、外部参考号/凭证状态
-> 数据恢复方式
  需要测试银行撤销/冲正和余额重置；没有恢复能力时不可纳入常规回归
```

## B2. 法币出金拒绝

```text
Client 前置状态
  与批准链路相同
-> Client 操作
  提交出金并记录订单号、余额和冻结金额
-> 获取业务编号
  保存 Client 出金订单号
-> Admin 搜索方式
  客户/收款人 + 日期 + 金额组合定位；处理前必须二次核对
-> Admin 处理
  选择拒绝并填写原因
-> Client 最终状态
  已拒绝，展示拒绝原因
-> 余额变化
  冻结金额释放、可用余额恢复；手续费是否退回待验证
-> 交易记录
  出金拒绝记录；不应出现最终外部打款
-> 数据恢复方式
  拒绝订单保留为审计记录；下一次使用新的唯一订单，不删除历史
```

**当前限制**：Admin仍不能按Client TXN搜索，且状态筛选未完整覆盖`已拒绝`；现有实现使用邮箱搜索、完整业务指纹、`candidateCount===1`与详情二次核对安全处理。WD-002/WD-003真实闭环均已通过。

## C. 数字资产出金

```text
Client 前置状态
  数字资产余额充足；白名单地址已通过；记录余额
-> Client 操作
  提交出金，保存币种、网络、地址、金额和业务编号
-> 获取业务编号
  保存 Client 订单号；后续还需 TXHASH
-> Admin 搜索方式
  出金审核按状态、币种、网络、地址、日期筛选
-> Admin 处理
  通过不可撤销确认，或拒绝并填写必填原因
-> Client 最终状态
  已审核 -> 链上处理中 -> 完成/失败
-> 余额变化
  扣减金额和网络手续费；失败/拒绝释放规则待验证
-> 交易记录
  数字资产流水、TXHASH、账变流水及手续费
-> 数据恢复方式
  需要 Safeheron Sandbox 和链上测试网络；链上交易不可删除，只能测试网重置账户
```

## D. 账户开户

```text
Client 前置状态
  KYC 已通过；该地区账户尚未开通；资料和开户费余额满足要求
-> Client 操作
  提交美国/新加坡/巴林账户申请
-> 获取业务编号
  保存 Client 申请编号；当前 Admin 搜索不支持该编号
-> Admin 搜索方式
  开户审核按客户 ID/名称/邮箱、状态搜索，再核对账户类型与时间
-> Admin 处理
  查看身份、地址、文件和签署状态；选择通过/拒绝；填写备注；提交
-> Client 最终状态
  审核通过/已拒绝；外部渠道可能继续处理中，最终为已开通或失败
-> 余额变化
  美国账户已验证页面USD 500经SecurityKey后从信托账户扣减；巴林页面显示USD 100，未来真实Run按费用弹窗付款账户和实际余额变化验证
-> 交易记录
  开户申请状态、开户费交易、账变流水
-> 数据恢复方式
  需要关闭/重置测试账户的后台接口；已开通账户不可用删除历史替代恢复
```

**地区依赖**：美国 `interlace` + FATCA已真实完成；新加坡为 `sg_bank`；巴林第三方终态在OPEN-BH-003首次受控Run中以真实页面状态和Resume确认，不以配置展示名作为成功Oracle。

## E. 券商开户

```text
Client 前置状态
  KYC 已通过；券商未开通；资料和开户费余额满足要求
-> Client 操作
  提交 Webull/IBKR/Tiger 开户申请
-> 获取业务编号
  保存申请编号
-> Admin 搜索方式
  券商开户管理按申请编号精确搜索
-> Admin 处理
  核对客户、券商、文档；更新审核通过/审核拒绝及处理说明
-> Client 最终状态
  待处理 -> 审核中/需关注 -> 已开户或已拒绝
-> 余额变化
  可能扣券商开户行政费；时点待验证
-> 交易记录
  开户状态、开户费交易、券商账户信息
-> 数据恢复方式
  需要券商 Sandbox 撤销/重置申请和平台账户解绑能力
```

**阻塞**：第三方预计 3–7 个工作日，无法作为快速回归闭环。

## F. 理财认购

```text
Client 前置状态
  产品上架；付款账户余额充足；用户满足风险等级；记录余额与持仓
-> Client 操作
  提交唯一金额的首次/追加认购
-> 获取业务编号
  保存理财订单号
-> Admin 搜索方式
  认购管理按订单号精确搜索
-> Admin 处理
  核对产品、金额、手续费、付款账户和风险；批准或拒绝
-> Client 最终状态
  已通过后持仓增加；拒绝后显示原因且不新增持仓
-> 余额变化
  通过后付款账户扣减；拒绝路径的预扣释放规则待验证
-> 交易记录
  理财认购交易、账变流水、持仓处理记录
-> 数据恢复方式
  需要产品级订单撤销/测试重置；赎回不是等价回滚，会生成新订单和账变
```

**高风险**：`批准认购`没有二次确认，点击即执行。自动化必须在写操作前启用显式环境门禁，并先断言订单号、客户 ID、金额、产品和状态。

## G. 理财赎回

```text
Client 前置状态
  存在可赎回持仓；记录份额、结算账户余额和产品状态
-> Client 操作
  提交唯一赎回金额/份额
-> 获取业务编号
  保存赎回订单号
-> Admin 搜索方式
  赎回管理按订单号精确搜索
-> Admin 处理
  核对订单、产品、持有金额、赎回金额、手续费和结算账户；批准或拒绝
-> Client 最终状态
  通过后持仓减少，订单完成；拒绝后持仓恢复/保持
-> 余额变化
  通过后结算账户增加净赎回金额
-> 交易记录
  理财赎回交易、账变流水、持仓处理记录
-> 数据恢复方式
  需要重置持仓/订单的测试接口；重新认购不是等价恢复
```

## H. 资金互转

```text
Client 前置状态
  Client自动认证成功；Admin auth/admin.json有效；已购买并审核通过券商账户
  记录runId、开始时间和法域账户余额；券商账户当前无余额查询能力
-> Client 操作
  使用可复现唯一金额提交；安全密钥验证最多一次
-> 获取业务编号
  保存Client TRF编号、金额、币种、账户方向和提交完成时间
-> Admin 搜索方式
  不假设TRF/TXN映射；按类型、待审核状态、日期、客户/收款人缩小范围
  对候选详情逐一核对用户、账户方向、币种、精确金额、创建时间和状态
-> Admin 处理
  只有业务指纹候选恰好1条时才允许处理；Admin记录自己的TXN编号
  TR-002填写AUTO_TRANSFER_E2E_REJECT_<runId>并拒绝；TR-003/TR-004为批准
-> Client 最终状态
  原TRF进入已拒绝或已完成终态；拒绝后再次操作必须创建新申请
-> 余额变化
  拒绝路径验证法域余额没有不应有的最终扣减
  批准路径验证法域转出余额减少或法域转入余额增加；券商余额当前无法直接验证
-> 交易记录
  Client按TRF核对申请；Admin按独立TXN记录处理；不通过替换前缀建立关系
-> 数据恢复方式
  拒绝申请保留为终态审计记录；后续必须创建新申请
  批准路径需要余额/申请重置能力；反向互转是TR-005新业务，不是清理
```

### Transfer Flow拆分

| 用例 | 链路 | 当前状态 |
| --- | --- | --- |
| TR-001 | Client提交前Validation，含两位小数与安全密钥弹窗，不点验证 | Ready |
| TR-002 | Client提交 -> Admin业务指纹唯一匹配 -> 拒绝 -> Client验证原TRF终态和法域余额 | Ready；真实闭环已成功，Real E2E Verified=Yes，仅进入Money Regression |
| TR-003 | 法域账户 -> 券商 -> Admin通过 -> Client TRF完成、法域余额减少、辅助流水校验 | Ready；Real E2E Verified=Yes，Business Result=Passed，Automation Result=Passed With Warning |
| TR-004 | 券商 -> 法域账户 -> Admin通过 -> Client TRF完成、法域余额增加 | Pending；券商转出余额无Oracle |
| TR-005 | TR-003后反向转回，验证最终法域余额和总手续费 | Pending；低频Money E2E，不进默认回归 |

**候选安全门禁**：`candidateCount !== 1`时立即停止，不点击拒绝或批准。禁止第一条、最新一条、仅金额或仅用户定位。

**编号模型**：Client申请是`TRF-*`，Admin资金互转记录是`TXN-*`；当前没有已确认的直接映射关系，两个编号分别保存。

### TR-003审核通过流程

1. 在任何Client写操作前验证Admin storageState可进入真实资金互转业务路由。
2. 由`client-auth`使用干净上下文自动登录Client。
3. 校验Client域名属于Sandbox/Staging，并校验两个Mutation安全开关、`workers=1`、`retries=0`、`repeatEach=1`。
4. 从Client账户页读取香港账户USD实时可用余额。
5. 由runId生成可复现的`80.xx USD`唯一金额，并校验不超过实时余额。
6. 进入已开通的老虎证券详情。
7. 选择香港账户 -> 老虎证券方向。
8. 选择USD。
9. 输入本次唯一金额并填写非敏感用途。
10. 从页面读取手续费。
11. 从页面读取预计到账金额。
12. 使用Decimal确认`转账总额=手续费+预计到账`，源余额预期减少转账总额。
13. 单次点击提交审核，打开安全密钥弹窗。
14. 从`CLIENT_SECURITY_KEY`填写密钥并单次验证，读取新`TRF-*`及提交时间。
15. Admin按用户、方向、币种、精确金额、时间窗口和待审核状态收集候选，强制`candidateCount===1`。
16. 打开唯一Admin `TXN-*`详情，二次核对用户、账户、币种、金额、状态和创建时间。
17. 填写`AUTO_TRANSFER_E2E_APPROVE_<runId>`审核备注，并单次点击最终`批准`。
18. 使用`expect.poll`等待原Admin TXN进入`已批准`，再等待原Client TRF进入`已完成`；当前历史记录未显示额外处理中状态。
19. 读取香港账户审核后余额，断言等于操作前余额减转账总额。
20. 复核Client券商详情中的原TRF资金历史和Admin独立TXN；将Client全局交易流水作为Secondary Oracle只读查询并写入中文业务报告。

**TR-003真实结果**：Admin候选唯一且详情匹配，Admin最终状态`已批准`，Client原TRF最终状态`已完成`。香港账户USD从`99894823.09`准确减少`80.02`至`99894743.07`；手续费`40.00`，实际到账`40.02`。核心业务Oracle全部通过，TR-003业务结果为Passed。

**TR-003覆盖限制**：老虎证券目标账户当前不提供余额查询，因此不能直接断言目标账户最终余额。源账户余额、Client TRF终态、Admin TXN状态、手续费和实际到账共同构成Primary Oracle，目标券商余额不可见是已知观测限制。

**Client全局流水现状**：真实页面选择`类型: 转账`后仍未找到Transfer记录，也无法读取Client全局流水TXN编号。该项是Secondary Oracle；因此TR-003自动化结果为Passed With Warning，而不是Fail或Manual Review。异常单独记录于`docs/known-issues.md`，不得通过再次执行资金互转来验证。

### TR-003 Oracle分级

Primary Oracle：Client原TRF已创建、Admin候选唯一、Admin详情匹配、Admin已批准、Client原TRF已完成、源余额准确减少`requestedAmount`、手续费一致、实际到账一致。

Secondary Oracle：Client全局交易流水Transfer记录、Client全局流水TXN编号和其他不影响最终资金状态的展示字段。

## I. 兑换

```text
Client 前置状态
  卖出资产余额充足；记录两种资产余额
-> Client 操作
  获取报价并在有效期内确认兑换
-> 获取业务编号
  从 Client 成功页/交易记录保存交易编号
-> Admin 搜索方式
  交易管理按用户邮箱、日期、类型定位；账变流水按业务交易编号精确查询
-> Admin 处理
  无；Admin 仅只读核对
-> Client 最终状态
  兑换成功，来源资产减少、目标资产增加
-> 余额变化
  按成交金额和手续费变化；同一业务编号下应有对应账变
-> 交易记录
  交易管理中的来源/目标资产与成功状态；账变详情中的前后余额
-> 数据恢复方式
  专用余额快照/重置；反向兑换受汇率和手续费影响，不是精确恢复
```

**结论**：兑换是当前最清晰的 Client 完全自动化业务；若要求 Client + Admin 联动，则 Admin 只负责只读财务核对。

## 第一条 Client + Admin E2E 建议

TR-003真实审核通过闭环已经完成，Transfer Flow整体为Ready。后续资金Flow继续执行前必须先定义Primary/Secondary Oracle，并保留双安全开关、候选唯一性守卫和不可重复提交规则。TR-004与TR-005仍为Pending，不因TR-003完成而自动开放执行。

## Withdrawal / 出金

### WD-002 拒绝闭环

```text
Client前置状态
  双端认证有效；香港账户USD可用余额可读；两个Mutation开关打开
-> Client操作
  选择已保存USD收款人、唯一1.xx金额和用途；确认转账；安全密钥验证一次
-> 获取业务编号
  在全局交易流水定位唯一法币转出，打开详情读取TXN-*
-> Admin搜索方式
  客户/收款人筛选 + 账户 + 币种 + Decimal精确金额 + 收款尾号 + 待处理状态 + 时间窗口
-> Admin处理
  candidateCount必须为1；详情二次核对；填写AUTO_WITHDRAW_E2E_REJECT_<runId>并拒绝一次
-> Client最终状态
  原TXN进入拒绝终态
-> 余额变化
  记录提交前/提交后/拒绝后availableBalance；拒绝后不得有永久错误扣减
-> 交易记录
  原TXN状态与详情；全局辅助展示属于Secondary Oracle
-> 数据恢复方式
  拒绝释放冻结资金；申请审计记录保留，不创建第二条申请作为补偿
```

### WD-003 批准闭环

```text
Client前置状态
  双端认证有效；可用余额、数值手续费和实际扣款已确认；银行/BaaS Sandbox可控
-> Client操作
  与WD-002相同，只提交一次并读取原TXN
-> Admin搜索方式
  使用同一业务指纹，禁止按第一条或最新一条
-> Admin处理
  candidateCount必须为1；核对详情；填写渠道、银行、凭证和审批备注；批准一次
-> Client最终状态
  原TXN经过实际中间状态进入成功终态
-> 余额变化
  按首次受控执行确认的真实扣费公式校验，不预先假设requestedAmount或requestedAmount+fee
-> 交易记录
  Client原TXN与详情为Primary证据；其他全局/邮件展示为Secondary
-> 数据恢复方式
  当前无冲正或余额重置，批准成功后禁止直接重跑
```

Withdrawal Client与Admin当前不能按编号直接关联：Client编号为`TXN-*`，Admin出金审批列表不显示或搜索业务编号。任何Admin写操作必须满足完整指纹候选恰好1条。

## Account Opening Readiness

```text
Client前置状态
  专用美国账户未开户Sandbox账号、五份固定资料、Client/Admin认证有效
-> Client操作
  账户页“开设其他账户” -> 美国账户 -> 上传五份资料 -> Documenso iframe签署 -> 打开开户费确认 -> 确认页面实际费用 -> SecurityKeyDialog -> 创建Client申请
-> 第三方签署
  signerFullName保留开户资料/Documenso预填值；signatureValue=TEST；日期和认证Checkbox预填；无Initial、OTP或Captcha
  最终Complete、确认框Sign和Client提交均为Mutation边界，每次Run各最多点击1次
-> 获取业务编号
  Client提交页当前未确认直接提供编号；Admin唯一候选的真实reviewId分别保存为Client/Admin申请引用，不使用内部runId伪装业务编号
-> Admin搜索方式
  客户稳定标识 + 待提交状态 + 提交时间窗口；账户类型、五份资料、FATCA文档和时间在详情二次核对
-> Admin处理
  candidateCount必须为1；只允许“通过审核”且最多一次；当前专用用户禁止平台Reject
-> Client最终状态
  Fidere审核通过后继续等待Interlace/BaaS结果，只有Client显示美国账户已开通才是成功终态
-> 外部状态
  `DOCUMENT_SIGNED -> CLIENT_CREATED -> FIDERE_APPROVED -> BAAS_SUBMITTED -> BAAS_PENDING -> BAAS_APPROVED -> CLIENT_FINALIZED`
  BaaS失败使用独立`BAAS_FAILED`，不得混同Fidere Reject
-> 数据恢复方式
  无重置能力；DOCUMENTS_UPLOADED以后必须Resume原草稿/申请，禁止Fresh Run和第二条申请
  OPEN-US-003已持久化为BAAS_FAILED；专用用户首次申请已消耗，禁止重新执行首次开户
```

`OPEN-US-001`与Documenso Dry Run已实现并通过。`OPEN-US-002`只允许历史拒绝数据Readonly，不得消耗专用用户执行平台Reject。`OPEN-US-004`仅建立BaaS失败恢复定义，没有可控失败数据时不得执行。

2026-08-31首次OPEN-US-003受控Run通过Preflight并上传五份资料，随后因已有`0 Fields Remaining`草稿不再显示`Next Field`而在Complete前停止。人工确认Full Name应保留文档预填值后，正式Resume通过前置检查并单击Complete 1次，真实确认框正常打开；因文档名解析错误在确认Sign前停止，故`Sign=0`、Client提交`=0`、Admin批准`=0`，未创建Client申请且不需要人工核查。解析逻辑已按真实DOM修正但没有重跑；当前Resume=`DOCUMENT_READY_TO_COMPLETE`，只能在新的明确授权下继续，禁止Fresh Run。美国开户Reject终态不可重新申请；Singapore首次开户因账号已开通而`BLOCKED_TEST_DATA`，Bahrain当前仍可申请但Approve Happy Path尚未实现。

后续单次Resume已成功执行Complete与确认Sign各1次，Documenso正式完成且没有重复签名。开户提交入口出现真实USD 500“确认开通并扣费”弹窗，但该动作不再记为申请提交；确认扣费0次，因此Admin候选0、Admin批准0、BaaS未进入。Fee Resume只读Preflight已确认付款账户`信托账户`、余额`5900 USD`、Admin认证有效和Interlace渠道启用。当前Resume=`CLIENT_FEE_CONFIRMATION_REQUIRED`，后续只能在新的明确资金授权下继续原草稿。

最终唯一Fee Resume随后完成开户费确认1次、安全密钥验证1次，信托账户短时`5900 -> 5400 USD`且实际扣费`500 USD`；Client只创建一条美国开户申请，Admin候选1条、详情匹配、Approve 1次。最终只读复核为Client`已拒绝`、Admin原reviewId`failed`，余额恢复`5900 USD`，没有重复扣费、签名或第二条申请。Resume=`BAAS_FAILED`，OPEN-US-003保持Blocked；历史各次中间态/失败报告保持不变。

巴林开户复用同一Account Opening业务指纹、Admin详情/Approve、余额Oracle、Resume与共享SecurityKeyDialog。2026-08-31只读确认专用用户仍为`可申请`、开户费`USD 100`、无资料上传，Validation和双端Dry Run均通过且写操作为0；OPEN-BH-003为`MUTATION_READY`。真实Run仍必须从费用弹窗读取付款账户与金额，并只在双开关和单次授权下提交。

## Wealth Subscribe Readiness

```text
Client前置状态
  可申购产品、符合最低金额的付款账户、付款余额与持仓基线
-> Client操作
  选择产品和付款账户，输入金额，接受条款并核对0手续费/总额
-> 获取业务编号
  提交后从Client交易历史读取真实INV-*
-> Admin搜索方式
  先以INV-*精确搜索，再核对客户、产品、币种、金额、状态和创建时间
-> Admin处理
  candidateCount必须为1；详情二次核对后执行一次Reject或Approve
-> Client最终状态
  原INV进入拒绝或成功终态
-> 余额与持仓
  拒绝验证退款/不扣款且持仓不增加；批准验证付款余额减少与持仓增加
-> 数据恢复方式
  需要订单、付款余额和持仓的测试重置能力
```

`WS-001`已验证真实产品目录、最低金额、付款账户和未提交摘要。2026-08-31运行`WS-DRY`读取到9条Client历史`INV-*`；修复状态Tab切换后的Locator恢复后，其中1条可在Admin按同一INV精确取得唯一候选并打开详情，跨端编号关联已成立。该历史订单为终态，详情没有可用Approve/Reject入口，因此无法验证最终操作表单；WS-002保持`BLOCKED_ADMIN_FORM / BALANCE_RULE`。基金页`我的投资`持仓行仍为0，WS-003额外缺少持仓增加Primary Oracle，保持`BLOCKED_ADMIN_FORM / HOLDING_ORACLE`。

## Wealth Redeem Readiness

2026-09-08更新：WS-003已通过一次真实Client+Admin闭环（`WS003-20260908-143500`）。香港账户认购Galaxy Digital Lending 1.43 USD、费用0；INV唯一、Admin已通过、Client持有中、持仓本金增加1.43。可用余额98980.06→98978.63，总余额99172.88→99171.45；提交时新增冻结1.43，批准后恢复原冻结192.82。WS-003为Ready，旧持仓表格/币种解析阻塞已修复。WR是独立Journey，用户因Admin赎回列表bug明确暂停，禁止自动提交赎回或访问该Tab，等待用户后续通知。

```text
Client前置状态
  页面可见、处于赎回窗口、份额充足且结算账户余额可读的持仓
-> Client操作
  选择持仓、份额和结算账户，核对手续费与预计到账
-> 获取业务编号
  提交后从Client赎回历史读取真实INV-*
-> Admin搜索方式
  INV-*精确搜索 + 客户 + 产品 + 份额 + 状态 + 详情时间
-> Admin处理
  candidateCount必须为1；拒绝或批准只允许一次
-> Client最终状态
  原INV赎回订单进入拒绝或成功终态
-> 余额与持仓
  拒绝验证份额和余额恢复；批准验证持仓减少/关闭及结算到账
-> 数据恢复方式
  需要可重置持仓、赎回窗口和结算余额
```

`WR-001`与`WR-DRY`只读识别当前持仓条件。现账号没有页面可见且可赎回的持仓，因此Mutation状态为`BLOCKED_TEST_DATA`，测试不会伪造仓位或打开最终赎回链路。

## 数字资产地址审核 DA-002

原Journey用户 -> Client头像/设置/地址管理 -> 填写地址名称、币种网络、钱包地址
-> 共享SecurityKeyDialog单次验证 -> 真实白名单创建证据
-> Admin数字资产地址审核按Client完整钱包地址搜索 -> 完整分页与唯一候选
-> 原用户ID/地址/资产/网络/标签详情复核 -> 通过/确认通过一次
-> Admin原记录已通过 -> Client同一地址可见且启用。

列表“启用”与“审核通过”分离；原白名单ID用于Resume及二次匹配，不替代钱包地址搜索。
本流程不执行数字资产出金或任何余额操作。DA-001和DA-DRY已通过安全验证；DA-002代码已接入，真实新增审批尚未执行，保持In Progress。
详见[数字资产地址流程](./digital-address-flow.md)。
