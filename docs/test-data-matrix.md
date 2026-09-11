# Fidere Automation Test Data Matrix

本文只记录自动化专用测试环境的数据要求和累积影响，不保存登录账号、客户姓名、Cookie、Token 或完整业务编号。

订单编号数据规则：资金互转/用户互转`TRF-*`、兑换`OTC-*`、入金/出金`TXN-*`、理财`INV-*`。同一流程出现多个编号时分别按语义保存，不通过前缀替换建立关系。

## Exchange

| 项目 | 当前配置/结论 |
| --- | --- |
| 环境 | `CLIENT_BASE_URL` 必须匹配 sandbox、staging 或 `.test`；当前 Recon 为 Sandbox |
| 账号用途 | `.env` 中的客户端测试账号；仅用于自动化测试，不用于真实客户业务 |
| 转出账户/币种 | `EXCHANGE_SOURCE_ACCOUNT_TYPE=数字资产`，`EXCHANGE_FROM_CURRENCY=USDT_TRC20` |
| 转入账户/币种 | `EXCHANGE_TARGET_ACCOUNT_TYPE=香港账户`，`EXCHANGE_TO_CURRENCY=HKD` |
| 建议金额 | `EXCHANGE_TEST_AMOUNT=0.01`；2026-08-26 实际报价为 7.76，预计并实际到账 0.07 HKD |
| 执行开关 | `ALLOW_MONEY_TESTS=false` 为默认值；只有一次获批执行时才临时设为 `true` |
| 可变数据 | 每次成功执行都会减少数字资产账户的 USDT_TRC20，并增加香港账户的 HKD，同时永久新增交易流水和账变记录 |
| 防重复 | 用例 `retries=0`、单 worker、无 `repeatEach`；最终确认按钮在单次测试内最多调用一次 |
| 累积影响 | 2026-08-26 已成功成交一次：USDT_TRC20 减少 0.01，HKD 增加 0.07，并永久新增一条 `OTC-*` 已完成记录 |
| 自动恢复 | 无。禁止用反向兑换当作回滚，因为汇率变化和手续费可能造成损失，且会产生新的审计记录 |
| 补充/重置 | 当前未发现客户端或 Admin 的余额重置入口；需要测试环境负责人提供按业务编号审计的余额快照/重置 API，或人工补充专用测试余额 |

## Exchange 执行记录

| 日期 | 自动化结果 | 转出变化 | 转入变化 | 恢复状态 |
| --- | --- | --- | --- | --- |
| 2026-08-25 | 仅报价和确认页勘察，未点击最终确认 | 0 | 0 | 无需恢复 |
| 2026-08-26 | 业务成功；自动化失败。原因是错误预期 `TXN-*`，实际兑换编号为 `OTC-*`；原始失败报告保持不变 | -0.01（502.0495 -> 502.0395） | +0.07（70.00 -> 70.07） | 不执行反向兑换；保留原始失败报告和成交审计记录 |

## Transfer

| 项目 | 当前配置/结论 |
| --- | --- |
| 账号前置 | `.env` 客户端账号已购买并完成老虎证券后台审核，详情 URL 使用 `TRANSFER_BROKER_ACCOUNT_ID=TIGER` |
| 账户方向 | 香港信托账户 -> 券商账户，以及券商账户 -> 香港信托账户；页面结构不允许同一账户作为两端 |
| 支持币种 | Validation 从真实下拉读取 `EUR`、`USD`、`HKD`；当前配置 `TRANSFER_CURRENCY=USD` |
| Validation 金额 | `TRANSFER_UNIQUE_AMOUNT_BASE=80`、精度2位；根据runId可复现生成`80.xx USD`，仅用于格式与费用预览，不代表真实授权 |
| 费用 | 信托转券商 100 USD：手续费 40 USD，预计到账 60 USD；券商转信托 100 USD：手续费 0 USD，预计到账 100 USD |
| 安全密钥 | 所有资金操作复用 `CLIENT_SECURITY_KEY`；TR-002真实执行中单次验证成功，Validation/TR-003 Dry Run中的`验证`点击均为0 |
| 资金开关 | `ALLOW_MONEY_TESTS=false`和`ALLOW_ADMIN_MUTATION_TESTS=false`保持关闭；Client自动登录不会修改任一开关，TR-002真实执行必须同时显式开启 |
| 当前余额 | 法域账户余额可从Client账户页读取；券商账户没有余额查询能力。首个批准方向优先法域账户 -> 券商账户 |
| 编号模型 | Client申请为`TRF-*`，Admin资金互转页面为独立`TXN-*`；没有已确认的直接映射关系，禁止前缀替换或强行对应 |
| Admin业务指纹 | 测试用户 + 转出账户 + 转入账户 + 币种 + 精确金额 + Client提交时间窗口 + 待审核状态；详情复核后候选必须恰好1条 |
| 数据恢复 | 无余额快照、订单撤销或测试重置能力；不得把反向划转当作回滚 |
| 当前执行结果 | TR-001 Validation、TR-002拒绝闭环和TR-003批准闭环均已真实验证并标记Ready；Transfer Flow整体Ready |
| TR-002结果 | Client生成唯一TRF；Admin候选数1并单次拒绝；原TRF进入拒绝终态；香港账户没有不应有的最终扣减；没有创建第二条Transfer |
| TR-003余额Oracle | 香港账户 -> 老虎证券时手续费从转账金额内扣：`预计到账=转账总额-手续费`，`批准后香港账户余额=批准前余额-转账总额`；全部使用Decimal |
| TR-003目标余额限制 | 券商账户当前无法查询余额，不能直接断言目标余额；源余额、Client TRF、Admin状态、手续费和实际到账构成Primary Oracle |
| TR-003全局流水限制 | Client全局`交易流水`未发现Transfer记录或Client流水TXN；该项为Secondary Oracle，结果记为Passed With Warning并单独跟踪，不阻塞Flow Ready |

### Transfer写操作门槛

1. 同一测试进程先完成Client和Admin双端认证预检；Admin必须能从认证首页进入真实`法币资产管理 -> 资金互转`业务路由，不能只依据缓存首页判定有效。失效时在Client提交前失败并提示运行`npm run auth:admin`。
2. 从Client账户页读取法域账户实时余额；金额必须高于页面手续费和已确认最低金额，且不超过余额。
3. Client提交后分别保存`TRF-*`、精确金额、币种、账户方向和提交完成时间。
4. Admin筛选与详情业务指纹最终只能得到1条`TXN-*`候选；候选数不是1时禁止处理。
5. TR-002拒绝后原TRF成为终态并保留审计记录；后续测试使用新runId和新申请，不重用原申请。
6. 首次真实候选使用可复现的`80.xx USD`两位小数金额；TR-002真实执行已确认该金额范围可提交，页面仍不展示明确最低金额文本。若后端以后返回最低金额错误，立即失败且不得自动提高金额或重试。
7. TR-003审核通过只允许单次点击`批准`；随后分别以`expect.poll`等待Admin原TXN为`已批准`、Client原TRF为`已完成`，不得固定sleep或再次批准。
8. TR-003批准后香港账户应减少转账总额，手续费已包含在转账总额中；Client原TRF和Admin状态必须进入正确终态。Client全局交易流水是Secondary Oracle，缺失时报告警告但不覆盖核心业务成功结论。券商余额不可见不构成用例失败。

## Deposit

| 项目 | 当前配置/结论 |
| --- | --- |
| 目标路径 | Client银行电汇入金 -> Admin入账认领；数字资产注入另属链上流程 |
| DP-003推荐账户/币种 | `DEPOSIT_ACCOUNT_TYPE=香港账户`、`DEPOSIT_CURRENCY=USD`、页面文案`美元` |
| Validation金额 | `DEPOSIT_UNIQUE_AMOUNT_BASE=11`、精度2位；按runId生成可复现`11.xx`，只用于表单验证 |
| 支持范围 | 香港HKD/USD、美国USD、新加坡HKD/USD/SGD/AED/JPY、巴林HKD/SGD/CNY/USD/EUR |
| Client字段 | 打款银行、金额、渠道、用途、资金来源、可选附言；无Client上传凭证字段 |
| 编号模型 | Client交易流水列表显示系统`TXN-*`并可打开法币转入详情；本次详情“交易编号”显示电汇指令参考号。Admin认领列表无Client TXN，禁止假设直接映射 |
| Admin业务指纹 | 匹配客户SHA-256稳定指纹 + 账户 + 币种 + 精确金额 + 待处理状态 + 渠道 + 时间窗口 |
| 历史只读数据 | DP-002历史HKD reconciliation使用独立`DEPOSIT_RECONCILIATION_ACCOUNT_TYPE/CURRENCY/CURRENCY_LABEL`，不随DP-003 USD配置切换；`.env`不保存真实TXN、客户姓名、邮箱或银行账号 |
| 安全开关 | DP-002/DP-003必须同时要求`ALLOW_MONEY_TESTS=true`和`ALLOW_ADMIN_MUTATION_TESTS=true`；默认均为false |
| 数据恢复 | 无冲正、余额重置或申请删除能力；真实认领后不得用出金当作回滚 |
| 第三方边界 | Sandbox银行电汇由Client提交后直接进入Admin入账认领，不依赖外部银行/BaaS回调 |
| DP-002已用数据 | 香港账户/HKD/11.18；Client原TXN rejected、Admin已拒绝、余额70.07不变；原申请禁止重用 |
| 当前状态 | DP-001、历史只读Reconciliation和DP-002 Ready；现有DP-003 11.97 USD申请已单次提交，Client系统TXN与Admin唯一待处理候选均已只读确认，状态为Resume Ready，禁止创建第二笔申请 |

## 运行前门槛

1. `client-auth` Setup Project 已使用干净上下文自动登录并生成最新 `auth/client.json`，Client 测试没有跳转登录页。
2. 账户分组和币种仍能通过真实菜单定位。
3. 转出账户可用余额不少于 `EXCHANGE_TEST_AMOUNT`。
4. 报价到账金额必须大于 0，手续费必须与已确认规则一致；当前选定路径实际显示`免费`。
5. 客户端列表显示`TXN-*`流水编号；点击对应记录后，“兑换 详情”显示`OTC-*`订单编号。自动化分别读取并保存两者，不建立前缀推导关系。
6. 已接受本次执行会永久改变余额和新增审计数据。

## Withdrawal

| 项目 | 当前配置/结论 |
| --- | --- |
| 推荐首条方向 | 香港账户 -> 已保存USD银行收款人；先做WD-002拒绝，不依赖外部打款完成 |
| 当前可用余额 | 香港账户USD `13.04`；页面只提供availableBalance，不提供total/frozen |
| 建议金额 | `WITHDRAWAL_UNIQUE_AMOUNT_BASE=1`、精度2位，按runId生成可复现`1.xx USD`；历史存在1.00 USD完成记录 |
| Client编号 | `TXN-*`；从全局`交易流水 -> 提现 -> 法币转出 详情`读取 |
| Admin编号 | 出金审批列表不显示独立编号；不得与Client TXN做映射 |
| Admin业务指纹 | 测试用户 + 法域账户 + 币种 + Decimal精确金额 + 收款账号尾号 + 待处理状态 + Client提交时间窗口 |
| 手续费/实际扣款 | 当前目标表单和确认态均显示`-`；历史记录有数值手续费，但不能据此推导当前费率 |
| 最低/最高 | 页面不显示；0无效，0.01可确认；超余额金额也可确认，最终余额校验可能在安全验证后 |
| 全部提现 | 输入完整可用余额，不预扣手续费 |
| 历史只读数据 | `.env`只保存金额、账户、币种、尾号、状态和时间；不保存完整TXN、客户身份或银行账号 |
| 安全开关 | WD-002/WD-003必须同时要求`ALLOW_MONEY_TESTS=true`和`ALLOW_ADMIN_MUTATION_TESTS=true`；默认均为false |
| 数据恢复 | 无出金冲正/删除/余额重置；拒绝申请保留审计记录，批准成功后禁止直接重跑 |

## Account Opening Readiness

| 项目 | 当前配置/结论 |
| --- | --- |
| Client真实入口 | 账户页`开设其他账户`弹窗 -> 美国账户；`OPENING_TEST_EMAIL`专用账号的首次申请已进入拒绝终态，不得重复申请 |
| 固定资料 | 护照、身份证明、手持护照自拍、住址证明、资金来源证明共5份，统一从`test-assets/account-opening/`读取 |
| Documenso | `app.documenso.com` iframe正常加载；Canvas Draw为实际签名方式，Upload可选，Typed Signature不存在 |
| Sandbox签署身份 | signerFullName保留开户资料/Documenso预填值；`OPENING_SIGNATURE_TEXT=TEST`，仅在实际存在Initial字段时使用`OPENING_INITIALS=T`；生产环境禁止自动签署 |
| 文档必填项 | 唯一Signature字段；日期和认证Checkbox由文档预填；无Initial、OTP或Captcha；正式完成需依次点击`Complete`和确认框`Sign` |
| Admin入口 | `/zh-CN/kyc/accountReviews`，支持客户ID、名称或邮箱搜索和个人/企业Tab |
| Candidate指纹 | 测试客户稳定标识 + `待提交`状态 + Client提交时间窗口；美国账户、5份资料、FATCA签署文档和提交时间在详情二次核对 |
| Primary Oracle | 5份资料、Documenso Complete+Sign正式完成、USD 500开户费单次确认与扣费Oracle、唯一Client申请、唯一Admin候选、Fidere批准、BaaS提交/成功、Client美国账户已开通、真实账户总览、无第二条申请 |
| Resume数据 | `.flow-state/account-opening-us-approve/`只保存runId、阶段、时间和取得后的真实reviewId；不保存身份资料、签名、Cookie或Token |
| 当前真实Run | `OPENUS003-****0819`已`BAAS_FAILED`：Documenso Complete/Sign各1次、USD 500费用确认1次、SecurityKey验证1次、Client申请1条、Admin候选1条且Approve 1次；最终Client`已拒绝`、Admin`failed`，信托余额恢复`5900 USD` |
| 当前状态 | OPEN-US-003=`BLOCKED_BAAS_FAILED`且首次开户不可重跑；OPEN-US-004需定义真实恢复规则后才能执行 |
| Singapore | OPEN-SG-002已用TEST SANDBOX AF真实验证首次开户；该用户现已开通，后续不得重复开户 |
| Bahrain | 2026-09-11 `OPEN-BH-003-AF-20260911`真实通过：Client唯一申请、Admin candidateCount=`1`且Approve一次，最终Client=`已开通`；香港账户USD `200 -> 100`，OPEN-BH-003=`READY` |

## Wealth Subscribe Readiness

| 项目 | 当前配置/结论 |
| --- | --- |
| 可见产品 | 4个真实产品；最低正数门槛产品为Galaxy Digital Lending，1 USD，页面显示0%手续费 |
| 付款条件 | Client可读取付款账户及余额；Dry Run仅形成有效摘要，不点击`确认并提交` |
| Client编号 | 认购订单使用真实`INV-*`，从Client交易历史读取 |
| Admin入口 | `/zh-CN/operation/financialProducts` -> 认购管理；订单号搜索与三个状态Tab可用，当前9条Client历史INV中有1条可按同一INV唯一定位并打开详情 |
| Candidate指纹 | INV订单号 + 测试客户 + 产品 + 币种 + Decimal金额 + 状态 + 详情创建时间 |
| WS-002 Primary Oracle | 原INV拒绝终态、Admin唯一候选、付款余额符合真实拒绝恢复规则、持仓不增加 |
| WS-003 Primary Oracle | 原INV成功终态、Admin唯一候选、付款余额按金额/手续费减少、持仓增加 |
| 当前缺口 | 历史双端INV为终态，详情无可用Approve/Reject入口；`我的投资`持仓行0；拒绝余额恢复规则、最终操作表单及订单/余额/持仓重置能力未验证 |
| 当前状态 | WS-001与WS-DRY可重复执行；WS-002=`BLOCKED_ADMIN_FORM / BALANCE_RULE`，WS-003=`BLOCKED_ADMIN_FORM / HOLDING_ORACLE` |

## Wealth Redeem Readiness

| 项目 | 当前配置/结论 |
| --- | --- |
| 当前持仓 | `我的投资`渲染持仓行0、赎回动作0；不得伪造持仓或绕过资格门禁 |
| Client编号 | 赎回订单使用真实`INV-*`，未来从Client赎回历史读取 |
| Admin入口 | `/zh-CN/operation/financialProducts` -> 赎回管理；搜索和状态Tab可读 |
| Candidate指纹 | INV订单号 + 测试客户 + 产品 + 份额/金额 + 状态 + 详情创建时间 |
| Primary Oracle | 原INV终态、Admin唯一候选、持仓减少/恢复和结算账户到账/不变 |
| 需要的数据 | 页面可见、处于赎回窗口、份额充足且结算余额可观测的专用持仓，以及重置能力 |
| 当前状态 | WR-001与WR-DRY可重复执行并报告`BLOCKED_TEST_DATA`；禁止真实Mutation |
