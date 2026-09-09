# Fidere Business Oracle Model

## Result Model

| Result | 判定条件 | 是否确认业务结果 |
| --- | --- | --- |
| `PASS` | 全部Primary Oracle通过，Secondary Oracle无异常 | 成功 |
| `PASS_WITH_WARNING` | 全部Primary Oracle通过，一个或多个Secondary Oracle失败 | 成功，存在辅助异常 |
| `FAIL` | 一个或多个Primary Oracle明确失败 | 失败 |
| `MANUAL_REVIEW` | 已执行不可逆或资金写操作，但核心证据不足、矛盾或无法判断是否落库/重复提交 | 未知，需要人工核查 |

`safeToRerun`与`manualReviewRequired`是两个独立维度。资金业务已经成功时应设置`safeToRerun=false`，但不因此设置`manualReviewRequired=true`。

## Oracle Levels

**Primary Oracle**决定核心业务是否成功。余额、订单终态、Admin终态、实际成交/到账等能够直接证明业务结果的证据应归入Primary。

**Secondary Oracle**用于验证辅助展示、审计记录、非核心编号或附加页面字段。Secondary失败会生成警告并保留证据，但不会覆盖全部Primary已通过的业务结论。

未来的入金、出金、兑换、资金互转、理财认购和赎回必须在实现真实写操作前，在Flow Registry和测试报告元数据中定义两级Oracle。

## Manual Review Boundary

仅以下情况允许`MANUAL_REVIEW`：

1. Client安全密钥已提交，但无法判断是否创建订单。
2. Admin已点击批准，但无法读取Admin处理状态。
3. Client与Admin核心终态相互矛盾。
4. 余额发生变化，但找不到任何对应业务记录。
5. 无法判断是否发生重复提交。
6. 请求超时后无法判断资金操作是否落库。
7. 核心资金Oracle之间相互矛盾。

普通辅助字段缺失、全局列表未展示记录、辅助TXN不可读取等情况不得单独触发`MANUAL_REVIEW`。

## TR-003 Adjudication

Primary Oracle：

1. Client成功创建原TRF申请。
2. Admin候选唯一。
3. Admin详情匹配正确。
4. Admin最终状态为已批准。
5. Client原TRF最终状态为已完成。
6. 香港账户USD余额准确减少`requestedAmount`。
7. 手续费与页面确认一致。
8. 实际到账金额与确认页一致。

Secondary Oracle：

- Client全局交易流水出现对应Transfer记录。
- Client全局流水TXN编号。
- 其他不影响最终资金状态的展示记录。

本次八项Primary全部通过，全局流水Secondary失败，因此结果为`PASS_WITH_WARNING`。业务闭环已确认成功，无需人工核查；由于原资金业务已完成，不允许重跑。
