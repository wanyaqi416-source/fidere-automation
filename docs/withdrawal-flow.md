# Withdrawal Flow

## 当前状态

Withdrawal整体状态为`Ready`。真实Sandbox已完成WD-001 Validation、历史Reconciliation、WD-002拒绝闭环和WD-003批准闭环；资金用例仍仅允许在逐次授权、双安全开关、单worker和零retry下运行。

## Client真实页面

| 项目 | 当前Sandbox证据 |
| --- | --- |
| 入口 | `账户` -> 法域账户详情 -> `法币转出` |
| URL | `/zh-CN/account/transfer?mode=beneficiary&fromAccountType=trust` |
| Page Object | `WithdrawalPage`、`WithdrawalHistoryPage`、公共`TransactionsPage`/`TransactionDetailDrawer` |
| 支持账户/币种 | 香港：HKD/USD；美国：USD；新加坡：HKD/USD/SGD/AED/JPY；巴林：HKD/SGD/CNY/USD/EUR |
| 收款账户 | 从已保存银行收款人中选择；当前香港/USD有可选收款人，也提供`添加新的收款人信息`入口 |
| 银行资料 | 已保存收款人展开后显示银行、账号尾号、SWIFT、国家/地区；自动化只保存配置名和账号尾号 |
| 白名单 | 页面没有使用“白名单”文案；已保存收款人相当于出金前置数据，但是否有独立审核规则待产品确认 |
| Memo / Tag | 有可选`附言 / 付款备注`；法币流程没有数字资产Memo/Tag字段 |
| 转账用途 | 必填下拉；当前有工资、继承、离婚协议、养老金/储蓄、出售财产、利息收入、资本收益、赌博、礼物 |
| 可用余额 | 香港账户USD当前显示`13.04`；页面未提供独立总余额或冻结余额 |
| 最低金额 | 页面未展示最低值；`0`明确提示`请输入有效金额`，`0.01 USD`可进入确认态，因此当前可观察下限不高于0.01 USD |
| 最大金额 | 页面未展示最大值；超过可用余额0.01的金额仍可进入确认态，余额不足校验不在第一层表单完成 |
| 手续费 | 当前香港/USD表单及确认态显示`-`；历史Client详情和Admin列表存在数值手续费，但数值随记录变化，无法从当前证据判定固定费、百分比或组合规则 |
| 实际扣款/到账 | 当前确认态显示`-`，无法确认手续费额外扣除还是从requestedAmount扣除 |
| 全部提现 | `全部`把金额填为当前完整可用余额`13.04`，没有在输入框阶段预扣手续费 |
| 金额小于手续费 | 当前手续费不是数值，无法安全验证，保持待确认 |
| 确认与安全密钥 | `继续确认`进入内联确认态；`确认转账`只触发`POST /api/check-operate`并打开6位安全密钥弹窗；未点击`验证` |

## Client记录与编号

- Client全局`交易流水`的类型筛选名为`提现`，真实行类型显示`法币转出`。
- 列表列为交易类型、网络、账户类型、交易金额、状态、时间、交易编号。
- Client出金业务编号为`TXN-*`。
- 点击列表TXN可打开`法币转出 详情`；详情显示状态、负向金额、手续费、付款账户、创建日期、交易编号、审核时间和账户类型。
- 表单页右侧还有`最近转账记录`，但它不是读取TXN的最终Oracle；TXN从全局流水及详情读取。

## Admin真实页面

| 项目 | 当前Sandbox证据 |
| --- | --- |
| 入口 | `运营` -> `法币资产管理` -> `出金审批` |
| URL | `/zh-CN/operation/fiatAssets` |
| Page Object | `WithdrawalListPage`、`WithdrawalDetailPage`、`WithdrawalApprovalPage` |
| 列表字段 | 申请时间、客户、账户类型、币种/金额、出金手续费、收款人、用途、状态、操作 |
| 筛选 | 状态、开始/结束日期、`客户、收款人...`关键词 |
| 状态选项 | 全部、待处理、处理中、处理完成、处理失败、客户取消；历史列表可见`已拒绝`但筛选没有该值 |
| 当前数据 | 待处理记录较多；WD-003 Dry Run通过测试用户、账户、币种、精确金额、收款人、状态和申请时间跨分页唯一定位，禁止直接使用第一条或最新一条 |
| Admin编号 | 列表不显示业务编号或Admin编号；当前终态行没有详情入口，未取得独立Admin TXN |
| 审批字段 | 真实DOM确认四个必填项为打款渠道、打款银行、上传打款凭证和审批备注；底部为拒绝与批准按钮 |
| 拒绝原因 | WD-002已通过真实表单填写并单次拒绝验证 |
| 第三方 | WD-003复用固定Sandbox打款凭证、真实渠道/银行和审批备注完成；默认回归仍不得执行批准 |

## 编号与唯一定位

Client `TXN-*`无法在Admin出金审批列表直接搜索或映射。Admin写操作前使用以下业务指纹，并要求`candidateCount === 1`：

1. 自动化测试用户稳定标识。
2. 出金法域账户类型。
3. 币种。
4. Decimal精确金额。
5. 收款账户尾号。
6. 待处理状态。
7. Client提交时间窗口。

禁止按第一条、最新一条、单独金额或单独用户处理。

## 余额模型

当前Client只能稳定观察`availableBalance`。以下字段已在报告模型中保留，但未知字段写`页面未提供`，不得伪造：

- `beforeAvailableBalance` / `beforeTotalBalance`
- `submittedAvailableBalance` / `submittedTotalBalance`
- `afterRejectedAvailableBalance` / `afterRejectedTotalBalance`
- `afterApprovedAvailableBalance` / `afterApprovedTotalBalance`
- `frozenAmount`

Client提交、拒绝恢复和批准后最终余额规则已由首次受控WD-002/WD-003建立。后续用例必须读取页面实时金额并用Decimal计算，不能把历史余额或手续费写死为通用规则。

## 用例设计

### WD-001 出金提交前Validation

- 账户/币种矩阵、已保存收款人、用途、空金额、0金额、超余额、页面限额、全部、确认摘要和安全密钥弹窗。
- `确认转账`最多点击一次，仅验证弹窗；安全密钥`验证`点击0次。
- 状态：`Ready`；真实Sandbox 3/3通过，安全密钥验证点击0次。

### WD-002 Client提交 -> Admin拒绝

Primary Oracle：原TXN存在、Admin候选唯一、详情匹配、拒绝只执行一次、Client原TXN拒绝、可用余额恢复且无永久错误扣减。全局流水、邮件和非核心详情是Secondary Oracle。

未来拒绝原因使用`AUTO_WITHDRAW_E2E_REJECT_<runId>`。真实执行必须先验证Admin认证、出金审批路由、当前候选无冲突、手续费摘要可解释，并同时开启两个Mutation开关。

### WD-003 Client提交 -> Admin批准

Primary Oracle：原TXN存在、Admin候选唯一、详情匹配、Admin批准、Client成功终态、最终余额、手续费和实际出金金额符合真实规则。批准路径还需要银行/BaaS Sandbox、测试渠道、测试银行和安全凭证。

### WD-003 Admin批准表单Dry Run

- Case ID：`WD-003-DRY`；Scope：`Admin / Readonly`。
- 通过测试用户、账户类型、币种、精确金额、收款人、待处理状态和申请时间跨分页定位；全局候选必须严格等于1，再按同一指纹找回当前页实时行。
- 真实打款渠道选项：电汇、FPS、SWIFT、Others；当前显式配置选择`电汇`。
- 真实打款银行选项：汇丰银行、渣打银行、花旗银行、星展银行；当前显式配置选择`汇丰银行`。
- 上传控件为隐藏`input[type=file][accept="image/*"]`，使用`setInputFiles()`上传`test-assets/withdrawal/bank-payment-proof.png`。
- 凭证必须具有合法PNG签名、非空且小于10MB；Business Report只记录文件名、类型和大小，不记录绝对路径、base64或二进制内容。
- 审批备注使用`AUTO_WITHDRAW_APPROVE_<runId>`；四个必填项回读正确且批准按钮可用。
- Dry Run最终批准点击0次、拒绝点击0次，`Mutation Performed: No`。

## 推荐首条真实数据

- 方向：香港账户 -> 已保存USD银行收款人。
- 币种：USD。
- 金额：runId生成的唯一`1.xx USD`，当前建议基数1；执行前必须运行时重新读取余额。
- WD-002和WD-003均已真实验证并进入Ready。
- 任何新Run仍需明确授权；历史TXN只能Resume或只读复核，禁止作为新申请重复执行。
