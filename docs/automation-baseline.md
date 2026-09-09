# FIDERE AUTOMATION BASELINE V1

Baseline只能通过`npm run baseline:update`显式更新。普通Validation、Dry Run或Regression只读取并比较，不会覆盖本文件或机器基线。

| 指标 | Baseline V1 |
| --- | ---: |
| Smoke | 10/10 |
| Validation | 16/16 |
| Readonly | 7/7 |
| Dry Run | 4/4 |
| Regression | 34/34 |
| PASS | 32 |
| PASS_WITH_WARNING | 2 |
| FAIL | 0 |
| MANUAL_REVIEW | 0 |

## Known Warnings

| Case | 用例 | 原因 |
| --- | --- | --- |
| TR-003 | 资金互转审核通过闭环 - Oracle分级裁决 | 资金互转已确认完成，但客户端全局交易流水未找到对应Transfer记录。 |
| TR-003 | TR-003批准后Client只读后查 | 资金互转已确认完成，但客户端全局交易流水未找到唯一对应Transfer记录。 |

两个Warning均来自同一个已知产品展示问题：TR-003资金互转的Admin状态、Client TRF终态、源账户余额、手续费和实际到账等Primary Oracle均已通过，但Client全局交易流水未展示唯一对应Transfer记录。该问题不影响Transfer业务成功结论。

## Source

- Version: FIDERE AUTOMATION BASELINE V1
- Source Run: 2026-08-28_16-11-38-c459b1e5
- Source Command: `npm run regression`
- Created At: 2026-08-28T09:23:37.201Z
