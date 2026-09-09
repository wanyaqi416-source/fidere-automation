# Fidere Business Order ID Model

客户端业务订单编号按业务域区分：

| 业务 | 订单编号前缀 | 自动化字段名 |
| --- | --- | --- |
| 资金互转 / 用户互转 | `TRF-*` | `transferOrderId`或现有兼容字段`clientTransferId` |
| 兑换 | `OTC-*` | `exchangeOrderId` |
| 入金 | `TXN-*` | `depositOrderId` |
| 出金 | `TXN-*` | `withdrawalOrderId` |
| 理财认购 / 赎回 | `INV-*` | `investmentOrderId` |

## Auxiliary IDs

`TXN-*`还可能出现在交易流水或Admin处理记录中。必须按页面语义分别保存：

- 交易流水编号：`ledgerTransactionId`
- Admin资金互转处理编号：`adminTransactionId`
- 入金订单编号：`depositOrderId`
- 出金订单编号：`withdrawalOrderId`

因此不能只根据`TXN-*`前缀推断业务类型。兑换列表中的`TXN-*`是流水编号，兑换详情中的`OTC-*`才是兑换订单编号；Client资金互转订单`TRF-*`与Admin资金互转记录`TXN-*`也是两个独立编号。

## Rules

1. 所有编号必须从真实页面或接口读取，不通过替换前缀生成。
2. 不同语义的编号使用不同字段保存，不统一塞入模糊的`transactionId`。
3. 定位订单时结合业务类型、账户、币种、金额、状态和时间窗口，不能只依赖前缀。
4. 报告、日志和证据中的`OTC-*`、`TXN-*`、`TRF-*`、`INV-*`全部脱敏。
5. `TRX-*`不是当前资金互转订单规则，自动化不得继续使用。
