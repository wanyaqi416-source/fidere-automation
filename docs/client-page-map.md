# Fidere Client Page Map

本页基于已登录测试账号在真实客户端测试环境中的实际勘察结果整理。勘察只浏览页面、打开菜单、切换 tab、查看弹窗和提交前表单；未点击任何会产生订单、申请或资料变更的最终提交按钮。

## 页面总览

| 页面/模块 | 页面入口 | 页面 URL | 当前状态 | Page Object 建议 |
| --- | --- | --- | --- | --- |
| 首页 / 仪表板 | 顶部导航 `仪表板`；登录成功后默认进入 | `https://sandbox.portal.trust.wtf.ceo/zh-CN/dashboard` | 可正常访问；新账号展示非零资产、最近交易、投资组合、资产配置、资产分布表 | `pages/client/DashboardPage.ts` |
| 账户 | 顶部导航 `账户` | `https://sandbox.portal.trust.wtf.ceo/zh-CN/account-detail` | 可正常访问；用于查看资产分布和最近活动 | `pages/client/AccountDetailPage.ts` |
| 交易流水 | 顶部导航 `交易`；首页最近交易 `查看全部` | `https://sandbox.portal.trust.wtf.ceo/zh-CN/trading` | 可正常访问；支持交易编号搜索、类型/状态/时间筛选；新账号最近交易含兑换、理财申购、用户转账、开户费等记录 | `pages/client/TradingPage.ts` |
| 信托服务 | 顶部导航 `信托服务` | `https://sandbox.portal.trust.wtf.ceo/zh-CN/trust` | 可正常访问；展示信托信息、关系经理、受益人、文件管理、文档中心 | `pages/client/TrustServicesPage.ts` |
| 投资 - 基金 / 理财 | 顶部导航 `投资` 下拉 `基金`；首页 `开始投资` / `探索产品` / 投资组合入口 | `https://sandbox.portal.trust.wtf.ceo/zh-CN/investment/trading/funds` | 可正常访问；`产品目录` 稳定显示 4 个产品；可进入 GLDB 申购页；`我的投资` 当前只显示标题，持仓列表未渲染 | `pages/client/FundTradingPage.ts` |
| 投资 - 券商 / 开户 | 顶部导航 `投资` 下拉 `券商` | `https://sandbox.portal.trust.wtf.ceo/zh-CN/investment/trading/securities` | 可正常访问；Webull、IBKR 为待开户；老虎证券为已开通并可查看详情 | `pages/client/SecuritiesTradingPage.ts` |
| 券商详情 / 资金互转 | 券商页老虎证券卡片 `查看详情` | `https://sandbox.portal.trust.wtf.ceo/zh-CN/investment/trading/securities?status=opened&accountId=TIGER` | 展示券商账户信息、信托账户关联信息、最近资金划转记录；有两个资金划转按钮 | `pages/client/SecuritiesAccountDetailPage.ts` |
| 首页快捷 - 兑换 | 首页总资产区 `兑换` 大图标；首页资产分布表行级 `兑换` 按钮；账户页资产分布圆形按钮悬浮后点击 `兑换` | `dashboard` 或 `account-detail` 上打开弹层 | 可打开正常 `资产兑换` 弹层；包含 `你卖出`、`你获得`、资产下拉、金额输入、交换按钮和 `获取报价` | `pages/client/components/ExchangeDialog.ts` |
| 首页快捷 - 发送 / 提现 | 首页资产分布表行级 `提现` 按钮；首页总资产区 `发送` 大图标 | `dashboard` 上打开弹层 | 行级按钮有 `aria-label=提现`；后续为出金/发送资产流程，未在本轮继续提交 | `pages/client/components/SendAssetDialog.ts` |
| 首页快捷 - 接收 / 转入 | 首页资产分布表行级 `转入` 按钮；首页总资产区 `接收` 大图标 | `dashboard` 上打开弹层 | 打开 `数字资产注入` 弹层；展示数字钱包与资产搜索；行级按钮有 `aria-label=转入` | `pages/client/components/ReceiveAssetDialog.ts` |
| 银行电汇入金 | `账户`页`存入资金` / `银行存入` | `/zh-CN/account/fund-in?fromAccountType=trust` | 账户/币种、平台收款银行、打款银行、申请表单和最近提交记录 | `DepositPage` + `DepositHistoryPage` |
| 法币转出 | `账户`页法域账户详情`法币转出` | `/zh-CN/account/transfer?mode=beneficiary&fromAccountType=trust` | 付款账户/币种、已保存银行收款人、金额/用途/备注、手续费、确认态、最近转账记录；Client订单为`TXN-*` | `WithdrawalPage` + `WithdrawalHistoryPage` |
| 个人中心菜单 | 顶部右侧头像 | 当前页面浮层 | 菜单含账号头像、邮箱、`个人资料`、`设置`、`退出登录`；头像触发器仍缺少稳定可访问名称 | `pages/client/components/UserMenu.ts` |
| 语言菜单 | 顶部右侧 `语言` 按钮 | 当前页面浮层 | 可切换 `简体中文`、`English`、`繁體中文` | `pages/client/components/LanguageMenu.ts` |
| 页脚外链 | 页面底部 | `https://www.fideretrust.com/...` | `联系我们`、`使用条款`、`隐私政策`、`风险披露` 外链 | 通常不纳入客户端核心业务 PO |

## 页面关系

| 来源 | 动作 | 目标 |
| --- | --- | --- |
| 登录页 | 邮箱、密码、OTP 登录成功 | 首页 / 仪表板 |
| 首页 / 仪表板 | 顶部导航 `账户` | 账户 |
| 首页 / 仪表板 | 顶部导航 `交易` 或最近交易 `查看全部` | 交易流水 |
| 首页 / 仪表板 | 顶部导航 `信托服务` | 信托服务 |
| 首页 / 仪表板 | 顶部导航 `投资` -> `基金` | 投资 - 基金 / 理财 |
| 首页 / 仪表板 | 顶部导航 `投资` -> `券商` | 投资 - 券商 / 开户 |
| 首页 / 仪表板 | 资产分布行级 `转入` | 数字资产注入弹层 |
| 首页 / 仪表板 | 资产分布行级 `提现` | 发送资产弹层 |
| 首页 / 仪表板 | 资产分布行级 `兑换` | 资产兑换弹层 |
| 账户 | `存入资金` / `银行存入` | 银行电汇入金 |
| 账户 | 资产分布圆形按钮悬浮后点击 `兑换` | 资产兑换弹层 |
| 投资 - 券商 | 老虎证券 `查看详情` | 券商详情 / 资金互转 |
| 券商详情 / 资金互转 | `从信托账户转入券商账户` | 信托转券商资金划转申请弹层 |
| 券商详情 / 资金互转 | `从券商账户转出至信托账户` | 券商转信托资金划转申请弹层 |
| 投资 - 基金 | tab `产品目录` | 产品列表和资金类型筛选 |
| 投资 - 基金 | 产品卡片 `申购` | `/zh-CN/investment/trading/funds/subscribe?id=...` |
| 投资 - 基金 | tab `我的投资` | 当前持仓区域 |
| 投资 - 基金 | tab `交易历史` | 申购/赎回/收益交易历史 |
| 信托服务 | `添加受益人` | 添加受益人弹层 |

## Locator 与可测性备注

| 区域 | 稳定 Locator 优先级 | 当前风险 |
| --- | --- | --- |
| 顶部主导航 | `getByRole('link', { name })` | 现有 `Navigation.ts` 文件显示中文可能存在编码显示问题，后续维护时需确认源码编码 |
| 基金 tab / 信托文档 tab | `getByRole('tab', { name })` | 较稳定 |
| 券商详情按钮 | `getByRole('button', { name: '查看详情' })` | 点击后 URL 变为 `?status=opened&accountId=TIGER`，可等待资金划转标题 |
| 资金互转按钮 | `getByRole('button', { name: '从信托账户转入券商账户' })`；`getByRole('button', { name: '从券商账户转出至信托账户' })` | 较稳定；最终按钮 `提交审核` 会创建真实申请，禁止自动点击 |
| 资产分布行级快捷按钮 | `getByRole('button', { name: '转入'/'提现'/'兑换' })`，结合所在资产行过滤 | 行内按钮比首页大图标稳定；资产名如 `USD` 会被 `USDT` 包含，行过滤要更精确 |
| 资产兑换弹层 | 打开后等待 `getByRole('dialog').filter({ hasText: '你卖出' })`，并断言 `getByRole('button', { name: '获取报价' })` | MUI 弹层动画期间 `role=dialog` 会先出现，不能只等标题；需等待业务字段入场 |
| 首页兑换/发送/接收大图标 | 当前大图标按钮无可访问名称，文字标签为相邻文本 | 需要补 aria-label 或 test id；优先用资产表行级按钮 |
| 顶部头像菜单 | 当前头像为无 aria-label 的 `MuiAvatar` | 需要补 aria-label/test id |
| 交易页搜索 | `getByPlaceholder('搜索交易编号')` | 较稳定 |
| 信托文件搜索 | `getByPlaceholder('搜索文件名称...')` | 较稳定 |

## 当前业务数据状态

| 数据域 | 当前观察 |
| --- | --- |
| 总资产/资产分布 | 新账号有非零资产；资产分布表包含 USDT、USD、BTC、EUR、AED、CNY、HKD、JPY、SGD 等资产行 |
| 最近交易 | 首页最近交易可见数字币转出、兑换、理财申购、用户转账、开户费等类型 |
| 券商账户 | 老虎证券已开通；Webull 与 IBKR 为待开户 |
| 资金互转记录 | 券商详情页可见最近资金划转记录，包含信托转券商、券商转信托两类 |
| 基金产品 | 产品目录显示 4 个产品，包含 Galaxy Digital Lending、GLDB USD 1-Month Fixed Deposit 等 |
| 基金申购页 | GLDB 申购页可见金额输入、付款账户、协议勾选、投资详情和 `确认并提交` |
| 基金持仓 | 首页投资组合显示 GLDB 持仓摘要；基金页 `我的投资` tab 当前未渲染持仓列表 |
| 兑换 | `资产兑换` 弹层可从首页大图标、首页资产分布行级按钮和账户页资产分布入口打开；当前确认完整表单可见，默认资产对为 USDT-Tron -> HKD，`获取报价` 在零金额时禁用 |
