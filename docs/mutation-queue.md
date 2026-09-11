# Fidere Mutation Queue

本队列只登记尚未真实完成的候选Flow。进入队列不等于获得执行授权；任何Mutation仍要求指定单次Run、进程级安全开关、`workers=1`、`retries=0`和禁止自动重跑。

| 顺序 | Flow | 状态 | 风险 | 数据可恢复 | 推荐执行 |
| --- | --- | --- | --- | --- | --- |
| 1 | WS-002 理财认购拒绝闭环 | BLOCKED_ADMIN_FORM / BALANCE_RULE | 高：Client会创建真实INV并可能预扣资金；Admin拒绝表单尚未用可控待审核订单验证 | 未确认；拒绝余额恢复规则尚无真实证据 | 否；先提供可重置待审核fixture并验证拒绝表单/余额恢复 |
| 2 | WS-003 理财认购批准闭环 | BLOCKED_ADMIN_FORM / HOLDING_ORACLE | 高：真实扣款和持仓变化；当前持仓不可直接观察 | 否；赎回不是等价回滚 | 否；先验证待审核批准入口与持仓Oracle |
| 3 | WR-002/003 理财赎回 | BLOCKED_TEST_DATA | 高：真实持仓和结算余额变化 | 否 | 否；需要已到期或明确支持提前赎回的页面可见持仓 |

## Readiness Evidence

- OPEN-BH-003：2026-09-11已由`OPEN-BH-003-AF-20260911`真实验证并移出待执行队列；原AF用户已开户，原Run不得重跑。
- WS-002/003：Client有9条历史`INV-*`，其中1条已在Admin按同一INV取得唯一候选并打开详情；跨端关联成立，但历史终态无Approve/Reject入口，且持仓仍不可观测。
- WR：基金页`我的投资`持仓行0、赎回动作0；WS-003即使成功，也必须等待产品进入可赎回窗口，除非页面明确支持提前赎回。
