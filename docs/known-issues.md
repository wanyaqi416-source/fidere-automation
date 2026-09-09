# Fidere Automation and Product Issues

## REGISTRATION-002 签署后首次Submit的页面内状态可能未同步

**状态**：Open / Product state synchronization; deterministic same-account recovery implemented

**发现流程**：REG-P-002 Personal Registration，2026-09-02新账号Fresh + 原账号Resume

- 新账号只创建1次；Registration Agreement的`TEST`签名、文档完成动作和确认签署均已完成，最终`Remaining Fields=0`。
- Fidere持久化签署状态为`client_authorization_status=1`，说明Client已经识别文档签署完成。
- 页面重载并Resume后，右下角蓝色`提交`可见、可用、表单有效且React handler已挂载。
- 单次点击`提交`后没有发出`POST /api/member-profile`，页面也没有进入`sign-success`等待审核页；账号仍停留在`FIDERE_SIGNING_RECOGNIZED`。
- 已从当前部署的Fidere前端bundle跟踪到确切条件：最终Submit handler先检查页面内`signatureRef.current`；为`false`时显示“请先签署”并直接`return`，`/api/member-profile`调用位于该guard之后。持久化`client_authorization_status=1`未直接初始化这个React ref。
- 正确的Registration Agreement路径必须点击PDF/Konva Canvas中的真实待签字段；右侧`Signature`控件只是签名偏好编辑器，其`Next`不代表字段已签署。
- 2026-09-02同一Journey `TEST SANDBOX AF`修正真实PDF字段后，Remaining Fields由1变0、Documenso完成回调被Fidere识别，当前页首次Submit直接产生`POST /api/member-profile` 200并进入“等待审核”，未触发reload recovery。

**影响**：本次账号已创建且文档已签署，但KYC最终资料没有提交，不能按“等待审核”Oracle判定注册成功。

**处理原则**：首次Submit会记录按钮DOM、console/pageerror和`member-profile`请求计数。仅当请求数严格为0时，允许同一账号reload/重新进入一次、重新确认已签署状态后再点击一次，并记录`POST_SIGN_FIRST_SUBMIT_STATE_DESYNC`。任何已观察到的请求都禁止第二次点击；永远不创建替代账号。

## ACCOUNT-OPENING-DOC-001 Documenso草稿保留字段签名

**状态**：Resolved / Documenso步骤已完成

**发现流程**：OPEN-US-003 美国账户开户Happy Path首次受控Run

- 先前Dry Run的固定`TEST` Canvas签名保留在同一Documenso草稿中；重新打开时页面直接显示`0 Fields Remaining`和可用`Complete`，不会再出现`Next Field`。
- 旧自动化仍要求`Next Field`恰好存在，因此在最终`Complete`之前停止。
- 本次5份资料上传成功，但`Complete`、Client最终提交和Admin批准均为0次，没有创建Client开户申请。
- 人工确认Full Name应保持开户资料预填值，只有Canvas签名必须为TEST；`Full Name=TEST`硬门禁已删除，自动化不会修改该字段。
- 随后的正式Resume通过全部只读前置检查并点击Complete 1次，真实`Are you sure?`确认框正常出现；因自动化错误要求文档名包含FATCA而在确认Sign之前停止。`Sign=0`、Client提交`=0`、Admin批准`=0`，没有创建开户申请。
- 当前状态为`DOCUMENT_READY_TO_COMPLETE`；确认框文档名已按真实DOM改为只验证非空，修复后未重跑。

**收尾**：后续唯一Resume已按真实文档标题完成Complete与确认Sign各1次，未修改Full Name或重复绘制签名。该Documenso问题已解决，但OPEN-US-003最终在Interlace/BaaS阶段失败；历史失败报告保持原样，专用用户不得再次执行首次开户。

## ACCOUNT-OPENING-FEE-001 开户提交入口先打开费用确认

**状态**：Resolved / 开户费步骤已完成

- OPEN-US-003已真实完成Documenso签署，Complete与确认Sign各1次。
- Client“提交开户申请”入口只打开“确认开通并扣费”弹窗；这次交互记为`openFeeConfirmation`，不记为Client申请提交。真实开户费为`USD 500`。
- 只读Preflight确认付款账户为`信托账户`、可用余额为`5900 USD`；后续唯一Fee Resume只确认费用1次并只验证SecurityKey 1次。
- 扣费后余额为`5400 USD`，实际扣费严格等于页面`500 USD`；Client只创建一条申请，Admin候选1条并Approve 1次。
- 后续只读终态复核显示Client=`已拒绝`、Admin原reviewId=`failed`，信托余额恢复为`5900 USD`；开户费步骤本身完成，但Interlace/BaaS终态失败，Resume=`BAAS_FAILED`。

**收尾原则**：历史中间态报告不改写；专用账号的首次申请已经消耗，禁止Fresh、第二条申请、重复扣费或重复Documenso签署。后续只能在恢复规则明确后Resume原申请。

## WITHDRAWAL-001 出金确认态缺少数值手续费和实际扣款

**状态**：Open / Primary Oracle blocker

- 香港账户/USD法币出金确认态的`手续费`与`实际扣款`显示`-`，无法形成数值扣费Oracle。
- 金额超过可用余额仍可进入确认态，余额不足校验发生在更晚阶段；自动化不得据第一层按钮可用判断可提交。
- Admin出金审批列表不显示Client `TXN-*`或独立Admin编号，也不能按业务编号搜索。
- Admin状态筛选缺少历史实际存在的`已拒绝`选项。
- 当前没有待处理出金fixture，终态行无详情入口，因此拒绝原因和审批必填控件本轮不能重新做真实DOM验证。

## TRANSFER-LEDGER-001 Client全局交易流水缺少Transfer记录

**状态**：Open / Secondary Oracle

**发现流程**：TR-003 香港账户 -> 老虎证券审核通过闭环

**已确认业务证据**：

- Client原TRF状态为`已完成`。
- Admin对应申请状态为`已批准`。
- 香港账户USD余额准确减少`80.02`。
- 页面确认手续费为`40.00`，实际到账为`40.02`。

**异常**：Client全局交易流水未找到对应Transfer记录，因此无法读取Client全局流水TXN编号。

**影响**：仅影响辅助展示/审计记录Oracle。核心资金业务已经由TRF终态、Admin终态、源余额、手续费和实际到账共同确认，不阻塞Transfer Flow Ready。

**处理原则**：不为复核此问题重新执行Transfer。后续由产品或后端确认全局流水是否应生成/展示Transfer记录；修复后使用只读reconciliation补充Secondary Oracle验证。

## DEPOSIT-ID-001 Client TXN与Admin入账认领缺少直接关联

**状态**：Open / Automation Safety

**已确认**：Client银行电汇入金订单使用`TXN-*`，当前全局交易流水列表可读取系统TXN并打开对应法币转入详情。现有DP-003详情同名“交易编号”字段显示的是Client电汇指令参考号，不是列表系统TXN。Admin`入账认领`列表和操作抽屉没有Client TXN，搜索仅支持参考号、付款人和备注。

**当前缓解**：Client先按入金类型、账户、币种、精确金额和时间定位唯一记录，保存列表系统TXN并打开详情交叉验证；Admin使用匹配客户不可逆哈希、账户、币种、精确金额、状态、渠道和提交时间窗口形成业务指纹。两侧都只有`candidateCount===1`时才允许未来处理。现有11.97 USD申请已只读验证两侧候选均为1。

**风险**：共享环境出现相同客户、相同金额和相近提交时间时，自动化会安全停止，无法无人值守继续。

**建议**：Admin列表/详情回显Client `TXN-*`并支持精确搜索；提供Sandbox冲正或测试数据重置能力。
