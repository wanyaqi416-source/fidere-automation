# 微牛证券开户 Flow

## 已确认页面

- 入口：Client 投资 -> 券商 -> Webull 微牛证券。
- 开户分为确认费用、上传资料、提交审核三个阶段，不执行老虎证券开户。
- 2026-09-09原TEST SANDBOX AH只读检查：香港账户USD可用余额894.62；页面开户费100.00 USD；微牛待开户。当前不需入金。金额仅为当次快照，代码每次读取页面。
- 确认费用页的勾选和“确认并继续上传资料”只是进入资料页，不代表扣费或申请已创建。
- 资料页有两份独立电子签署文件：W-8BEN 表格、CRS 控制人表格。两份各有一个“去签署”，通过字段名称关联，禁止依赖按钮顺序。
- 两份未签署时“下一步：提交审核”禁用。当前进度显示“0 / 0 已完成”，作为展示Diagnostic记录，不能因此判为双文档完成。

## 用例

| 用例 | 范围 | 当前能力 |
| --- | --- | --- |
| OPEN-WEBULL-001 | 双文档开户提交前校验 | 可执行：读取费用、余额、两个独立签署入口和下一步门禁；不创建或签署文档 |
| OPEN-WEBULL-003 | Client + Documenso + Admin完整开户 | Ready；原两份签署恢复后完成单笔开户和Admin审核，Client已开通 |
| OPEN-WEBULL-RO | 原文档只读复核 | 读取原Run文档状态及余额，不点击任何签署、费用或审核按钮 |

## 完整业务步骤

1. 复用原Journey用户，预检Client/Admin认证、KYC以及微牛尚未开户且无重复申请。
2. 读取页面实际开户费、币种、付款账户和该账户可用余额。付款账户必须明确，不能仅凭“信托账户”文案猜测扣款法域。
3. 如余额不足，进入`FUNDING_REQUIRED`。复用现有Client入金+Admin认领；明确授权为测试余额Fixture时可使用既有Admin手动入金。入金使用独立Run/Resume，验证到账后重新读取余额，禁止开户用例循环入金。此预检不会自动运行入金。
4. 进入微牛资料页，按名称打开本次W-8BEN文档。验证实际iframe/popup和本次用户/文档关联后使用Sandbox TEST签名，保留预填姓名。
5. 记录字段数归零、Complete一次、最终Sign一次，等待该文档的第三方完成证据和Fidere回写。
6. 独立完成CRS控制人表格的同一生命周期。两份文档不能共享引用，不能用第一份回写代替第二份。
7. 两份文档均完成后，进入提交审核，核对真实费用摘要及所有必填项。
8. 按真实页面确认开户一次，复用`SecurityKeyDialog`读取`CLIENT_SECURITY_KEY`，验证最多一次。
9. 确认真实开户申请已创建，保存原引用、用户关联与提交窗口。Toast、页面跳转或HTTP 200单独不能证明业务创建。
10. Admin券商开户管理按邮箱、用户、Webull语义、账户类型、时间及原引用匹配，candidateCount严格等于1；详情二次核对。
11. 复用`BrokerOpeningReviewPage`既有审批表单能力；微牛特有必填项和状态须先实际验证。审核最终确认最多一次。
12. Client重新查询同一微牛账户成功终态，记录实际费用/冻结/扣费结果及中文报告。不得重复申请、签署、扣费或审批。

## 双文档门禁与Resume

`src/journey/webull-opening.ts`提供业务步骤、Decimal资金准备判断和独立文档证据判定。

每份记录：文档类型、非敏感文档引用（或摘要）、剩余字段、签名完成、Complete次数、Sign次数、Documenso完成、Fidere识别完成。不得持久化可访问文档的URL、签署Token或文档正文。

- 第一份完成只进入第二份，不重复第一份。
- 已完成字段但未Complete：从Complete继续，不重绘签名。
- Complete只打开确认框，必须与最终Sign区分。
- 已最终Sign但回写未知：只读复核当前文档，不再次Sign，不继续创建其他文档。
- 两份均已完成及回写后才进入费用/安全验证。
- 已有开户申请：后续只Resume原申请；不可通过新的runId绕开去重。

本次逐文档状态和动作尝试已写入现有`FlowStateStore`，按原Journey隔离，文档引用只保存SHA256摘要。`nextWebullSigningStep`输出只是下一步分类，不是自动点击授权；`CONFIRM_SIGN`仍须现场确认当前弹窗后才能执行。原Run的签署尝试不得删除或重置。

## 本次安全边界

只读预检从登录结束后拦截业务写请求；仅放行本次已观察到的五个同源POST查询接口。没有点击“去签署”，因此没有创建Documenso草稿，没有最终签署、开户、安全密钥或Admin操作。

微牛使用独立`pages/client/WebullDocumentSigner.ts`。不导入个人`RegistrationAgreementSigner`、企业Signer或US `DocumentSigningPage`，不修改这些组件的具体DOM契约。CRS实际包含3页PDF，按签名字段的ARIA关联及其所在PDF页定位Canvas，不假设整个iframe只有一个Canvas。

两份页面均为Documenso跨域iframe，真实操作为Next Field -> Canvas TEST -> 字段Sign -> Complete -> 确认Sign。Full Name保留当前Journey预填值。第一份原执行曾使用经核对的旧适配器，此后已拆除该依赖；最终代码不再复用US具体Locator。

## 运行

```powershell
$env:BROKER_SOURCE_RUN_ID = '<现有Journey runId>'
npm run test:broker-opening:webull:dry-run -- --headed
npm run test:broker-opening:webull:unit
$env:BROKER_OPENING_RUN_ID = '<已有微牛Run>'
npm run test:broker-opening:webull:reconciliation -- --headed
```

Dry Run保持三个Mutation开关false；不修改`.env`，不加入默认资金回归。报表复用Fidere Business Report和共享Live Observer；逐文档报告中的PASS仅表示入口检查通过，不是签署通过。

## 验证结果

- `npm run typecheck`通过。
- `npm run test:broker-opening:webull:unit`：19/19通过（微牛14条、既有老虎5条），只使用本地模拟页面。
- `npm run test:broker-opening:webull:dry-run -- --headed`：1/1通过，真实AH页面，三个Mutation开关false。
- [最终中文预检报告](../reports/business/history/2026-09-09_10-59-29-1abff197/report.html)：Total=1、Pass=1、Fail=0、Pass Rate=100%。
- 初始只读拦截曾误阻止采用POST的账户查询，导致余额表为空；已通过同源精确查询路径白名单修正，非真实余额不足。历史失败报告保留，不改写。

## OPEN-WEBULL-AH-20260909早期执行记录

- 始终使用原TEST SANDBOX AH；没有新用户、入金、第二条开户申请或老虎开户操作。
- W-8BEN：初始字段1 -> 0；TEST Canvas、字段Sign、Complete、确认Sign各1次；当时Fidere该文档显示已完成/已签署。
- CRS：初始字段1 -> 0；独立三页文档TEST Canvas、字段Sign、Complete、确认Sign各1次；确认界面退出后，Fidere字段完成标识读取失败。不能据此认定第三方回写已成功。
- 后续干净登录只读等待45秒：两份文档都显示去签署，进度0/0，下一步禁用。只能确认Fidere未展示可继续提交状态，尚不能区分回调未持久化、页面状态恢复问题或文档结果关联问题。
- 香港USD可用余额、总额均894.62，冻结0。费用确认0次、安全密钥验证0次、Client申请创建0次、Admin审批0次；三个Mutation开关恢复false。
- 当时W-8BEN子状态`DOCUMENT_SIGNED`；CRS子状态`DOCUMENT_COMPLETE_ATTEMPTED`且已存在最终Sign动作标记。不得重复签署或从头运行。
- 首次调试用的分阶段动态加载入口已经移除，不把依赖忽略目录的脚本作为正式Flow执行器。当时完整开户仍In Progress；最终续跑结果见下一节。
- [真实执行失败报告](../reports/business/history/2026-09-09_11-39-06-4b54f0aa/report.html)。该历史报告的`noMutationPerformed`未计入第三方签署动作，不能解读为没有签署；以上明确列出实际签署动作。历史结果不改写。
- [最终只读回写复核报告](../reports/business/history/2026-09-09_11-43-19-65c5bc5c/report.html)：Business Result=BLOCKED；余额未变，不需要核查重复扣费，缺少的是签署结果回写证据。
- 拆分后验证：`npm run typecheck`通过；微牛/老虎本地测试25/25通过，包含禁止引入其他业务Signer、三页CRS字段Canvas定位、Full Name保留、Complete/Sign单次保护及逐文档状态隔离。个人、企业和US原签署文件无修改；未重跑真实开户。

## 2026-09-09原文档Resume完成

- Run仍为`OPEN-WEBULL-AH-20260909`，用户仍为TEST SANDBOX AH。实际申请引用30，最终状态COMPLETED。
- 真实Client发布代码表明：文档任务初始化依赖已创建开户申请的fileNos。尚未创建申请时，重新进入页面的两个“去签署”不代表第三方未签完；0/0统计上传文件，不统计签署。
- 原生“去签署”会调用`POST /api/brokerage/init-sign`查询当前用户和对应purpose。W-8BEN、CRS均真实返回`signed=true`，各显示“第三方签署已确认 / 你已完成签署”。关闭确认面板后分别显示已完成。没有重绘签名、Complete或最终Sign。
- 双文档完成后进入“提交审核”，勾选资料声明，点击“确认提交开户申请”1次，共享SecurityKeyDialog验证1次。
- Admin邮箱/原姓名初筛2条，微牛条件缩小到1条，其后个人账户/时间窗口仍1条。固定申请30，详情二次核对后复用既有券商审批表单。
- “保存处理结果”打开确认框；填写本次Sandbox占位券商账号、原姓名及执行日期；“确认通过”1次。Admin原申请已开户，Client微牛已开通。
- 香港USD可用余额894.62 -> 794.62，实际减少100.00，与页面开户费一致。没有额外入金、第二条申请、重复扣费或老虎操作。
- `pages/client/WebullOpeningPage.ts`恢复原签署结果；`tests/e2e/broker-opening/webull-opening.resume.spec.ts`提供正式强类型执行链，使用原FlowStateStore及最终动作持久化标记。已完成Run拒绝任何重新扣费或审批。
- 命令`test:broker-opening:webull:resume`仅处理原已签署文档且尚未扣费的Run，当前AH已完成，不得再次运行。`test:broker-opening:webull:reconciliation`可读取已完成账户而不重新进入开户。
- [最终中文历史报告](../reports/business/history/2026-09-09_12-10-49-be616b1e/report.html)：PASS；Total=1、Pass=1、Fail=0、Pass Rate=100%；无需人工核查，不允许重跑。
- 实际Resume耗时30.8秒；执行前typecheck和27项本地测试通过。三个进程Mutation开关均恢复false，`.env`未修改。原历史失败报告保留，不改写。
