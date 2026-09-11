# Fidere Flow Readiness Matrix

本表区分可进入安全回归的非写用例与真实Mutation资格。`Validation`或`Dry Run`通过不代表可以执行资金、开户或Admin审核。真实写操作仍需单条授权、对应安全开关、唯一候选和可判定的Primary Oracle。

| Flow | Validation | Dry Run | Test Data | Client Oracle | Admin Oracle | Balance Oracle | External Dependency | Mutation Ready | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Personal Registration | READY | READY | 唯一邮箱/手机号已完成真实注册 | Documenso完成、提交接口业务码、认证会话、Dashboard终态 | REG-P-003唯一已通过用户复核；本Run前已批准，未重复Approve | 不适用 | Documenso已完成 | Yes | READY |
| Corporate Registration | READY | READY | 单一企业Journey已完成；自然人董事/个人股东最小合法结构 | KYB提交接口、等待审核状态、同一账号认证、Dashboard终态 | REG-C-003候选唯一、详情匹配、Approve=1、已通过KYC | 不适用 | 嵌入式Documenso TEST签署已完成 | Yes | READY |
| Exchange | READY | READY | 专用账号与小额双币余额已具备 | OTC订单、TXN流水、状态、双币余额 | 不需要处理 | 双币种均可直接读取 | 无Admin/第三方审批 | Yes | READY |
| Transfer | READY | READY | 券商已开通账号与法域余额已具备 | TRF终态、方向、金额、手续费 | 业务指纹唯一候选与独立Admin TXN终态 | 法域源账户可读；券商余额不可见 | 不需要外部回调 | Yes | READY |
| Deposit | READY | READY | 法域账户、银行与唯一金额已具备 | TXN详情与Client终态 | 入账认领唯一候选与处理终态 | 入账账户余额可读 | Sandbox不依赖银行/BaaS回调 | Yes | READY |
| Withdrawal | READY | READY | 收款人、余额与固定Sandbox凭证已具备 | TXN详情与Client终态 | 审批唯一候选、表单与处理终态 | 源账户余额可读 | 当前已验证Admin闭环 | Yes | READY |
| US Account Opening | READY | READY | 专用用户首次申请已消耗，不可重复 | Client当前显示`已拒绝` | 原reviewId唯一，Admin最终显示`failed` | 扣费阶段`5900 -> 5400 USD`，失败后恢复`5900 USD` | Documenso成功；Interlace/BaaS最终失败 | No; only recovery | BLOCKED_BAAS_FAILED |
| Singapore First Opening | READY | READY | 页面开户费与香港USD扣费账户可读 | Client单次提交与安全密钥已验证 | Admin候选唯一、详情复核和Approve已验证 | 香港USD按页面开户费扣减 | 原申请单次提交与Admin单次审批保护 | Yes | READY |
| Bahrain Account Opening | READY | READY | 原AF用户已完成首次开户；后续用户需满足未开户及余额条件 | 页面开户费`USD 100`、最终提交边界和共享SecurityKey规则已真实验证 | Admin按邮箱、账户类型、审核中状态和时间窗口唯一定位，Approve已验证 | 香港账户USD `200 -> 100`，Decimal扣费Oracle通过 | 不依赖外部第三方终态 | Yes | READY |
| WS-002 Subscribe Reject | READY | READY | 有可申购产品、最低金额与付款余额；无重置能力 | INV历史、确认摘要和付款余额可读 | 同一INV唯一候选和详情已验证；历史终态无拒绝入口，拒绝表单未验证 | 付款余额可读；拒绝恢复公式尚无真实订单验证 | Reject不要求第三方成功终态 | No | BLOCKED_ADMIN_FORM / BALANCE_RULE |
| WS-003 Subscribe Approve | READY | READY | 有可申购产品、最低金额与付款余额；无重置能力 | 认购摘要可读；基金页持仓行为0 | 同一INV唯一候选和详情已验证；历史终态无批准入口 | 付款余额可读；持仓增加不可直接观察 | 产品/托管终态仍需受控验证 | No | BLOCKED_ADMIN_FORM / HOLDING_ORACLE |
| Wealth Redeem | READY | READY | 当前没有页面可见且处于赎回窗口的持仓 | 赎回历史与持仓门禁可读 | 赎回管理入口与状态Tab可读 | 无持仓，无法建立结算到账Oracle | 产品赎回窗口与托管终态未验证 | No | BLOCKED_TEST_DATA |

## Readiness Notes

- US Account Opening：OPEN-US-003完成五份资料、Documenso TEST签名、USD 500单次扣费、安全密钥、唯一Client申请和Admin单次Approve，但最终只读证据为Client`已拒绝`、Admin`failed`且余额恢复。Resume=`BAAS_FAILED`，首次开户不得重跑；OPEN-US-004需要先定义允许的恢复动作和重新推送规则。
- Corporate Registration：REG-C-002以同一企业账号完成9个独立步骤、20/20份适用资料、1名自然人董事、1名个人股东、嵌入式Documenso TEST签署和单次最终提交；Client进入`等待审核`，现为READY且不得以同一Journey重跑。
- Registration Admin Approval：REG-P-003复核原Personal账号已在本Run前通过KYC且Dashboard可访问，未重复Approve；REG-C-003对原Corporate申请唯一定位并Approve 1次，Admin与Client成功终态均已验证。两个Approval Flow均为READY且仅允许Resume，不能重新创建用户或KYC资料。
- Singapore：OPEN-SG-002已用独立未开户用户真实完成Client申请、Admin唯一审核、开户费扣减和Client已开通闭环。
- Bahrain：2026-09-11原AF用户真实完成Client申请、共享SecurityKey、Admin唯一审核和Client终态验证；开户费USD 100从香港账户准确扣除，OPEN-BH-003为`READY`。该用户已开户，原Run不得重跑。
- Wealth Subscribe：`WS-001`和`WS-DRY`可重复执行；9条Client历史INV中已有1条可在Admin按同一INV唯一定位并打开详情。该订单为终态，无法验证Approve/Reject表单；WS-002另缺拒绝余额恢复规则，WS-003另缺持仓增加Oracle，均保持Blocked。
- Wealth Redeem：`WR-001`和`WR-DRY`会如实报告`BLOCKED_TEST_DATA`；需要页面可见、可赎回、结算账户余额可观测的专用持仓。
- 以上六条新增用例均为L1/L3非Mutation；Client提交、Security Key最终验证和Admin最终动作次数均为0。

## Next Mutation Candidates

1. `WS-002`：拒绝路径价值高于批准路径，但必须先用可控待审核订单验证拒绝表单，并明确余额恢复规则。
2. `WS-003`：还需用可控待审核订单验证批准入口并解决Client持仓可见性，之后再受控执行。

当前不建议继续投入`WR-002/003`：没有可赎回持仓时无法形成真实Client订单、结算余额或持仓变化Oracle。
