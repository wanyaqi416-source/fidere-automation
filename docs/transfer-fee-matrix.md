# 三模式 × 两类转账真实结果

## 范围与结果

批次 `ATFM6-20260910-01`，2026-09-10：六个独立原订单均已完成，六项能力 Ready，Real E2E Verified=Yes。
默认Client发送方；既有测试收款用户 `e7***@qq.com`，不注册、不造余额。
资金互转：巴林 -> 香港；用户转账：巴林 -> 原订单确认的收款用户巴林账户。
用户转账成功仅表示原Admin审批提交成功，不宣称独立验证双方余额或最终清算到账。

HKD固定200的示例因巴林HKD可用200.66不足以承担两笔而未执行；SGD/CNY为0，EUR为0.32。
实际采用已说明的USD方案：固定0.37、百分比5%、免手续费。不是三个不同币种的真实覆盖。

| 模式 | 类型 | 金额 USD | 手续费 USD | Admin实际到账 USD | 原TRF（脱敏） | 原TXN（脱敏） | 结果 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 固定0.37 | 资金互转 | 11.20 | 0.37 | 10.83 | TRF-****7917 | TXN-****fb37 | 通过，原订单只读核查 |
| 固定0.37 | 用户转账 | 11.40 | 0.37 | 11.03 | TRF-****7d58 | TXN-****5ce9 | 通过 |
| 百分比5% | 资金互转 | 20.20 | 1.01 | 19.19 | TRF-****0781 | TXN-****1a6e | 通过 |
| 百分比5% | 用户转账 | 20.40 | 1.02 | 19.38 | TRF-****ad50 | TXN-****b8f0 | 通过，原批准状态只读核查 |
| 免手续费 | 资金互转 | 11.60 | 0.00 | 11.60 | TRF-****5eba | TXN-****c3f3 | 通过 |
| 免手续费 | 用户转账 | 11.80 | 0.00 | 11.80 | TRF-****e188 | TXN-****0849 | 通过，原订单Admin Resume |

全部计算使用Decimal；选择无需猜测舍入规则的比例金额。以上净额来自明确的Admin实际到账标签，不使用原始API `actualAmount` 冒充净额。
用户转账批准前候选均为1，双方、方向、币种、金额、费用、净额和原创建时间全部匹配。

## 去重与恢复

- 六笔Client确认各1次、安全验证各1次；三个用户转账批准各1次，二次确认均0次。
- 固定/免手续费各保存测试配置两次、恢复两次，合计保存4次、恢复4次。百分比原本为5%，不做无意义的重复保存。
- 每笔结束原完整配置回读一致，最终仍为巴林USD百分比5%，其他币种与开户费等未改变。
- 全部六个原Run为 `COMPLETED`，没有替代订单、重提或重复批准。
- `.env`未修改，所有执行进程的三个Mutation开关结束时均恢复false。
- 共享费率不是服务端事务锁；修改前/提交前/恢复前比对全量快照，检测外部改动不得覆盖。

三次自动化中断均保留原历史结果，不将原失败报告改写为通过：

1. 固定资金互转已安全验证，原页面跳转使历史响应体不可读取。只读历史改用同一认证上下文的独立查询页；原订单已批准后仅恢复配置，未重交。
2. 比例用户转账批准后，Admin列表仍处于加载状态，旧读取器过早读取临时0条/翻页。现在等待真实progressbar消失；批准后按原TXN读取，不重新启动客户搜索。原TXN已批准，只读确认，未再次批准。
3. 免手续费用户转账的完整分页收集超过原25秒期限，未产生最终候选结果，不代表candidateCount=0。扫描期限调整为90秒，完整唯一匹配及详情核对实际35.1秒；仅Resume原订单批准一次。

## 历史报告

- [原固定订单核查与配置恢复：PASS](../reports/business/history/2026-09-10_16-47-19-cdb6bbaf/report.html)
- [固定用户转账、比例资金互转：PASS；比例用户转账当时待核查](../reports/business/history/2026-09-10_16-51-08-a9befc31/report.html)
- [比例原批准订单只读核查：PASS](../reports/business/history/2026-09-10_16-53-53-41fff1bb/report.html)
- [免手续费资金互转：PASS；用户转账当时扫描超时](../reports/business/history/2026-09-10_16-57-37-b2873405/report.html)
- [最后原用户转账审批Resume：PASS](../reports/business/history/2026-09-10_17-00-25-c34a2d77/report.html)

首笔原中断报告：`2026-09-10_16-44-20-369a59ad`。另一次加载中的只读失败报告`2026-09-10_16-52-49-9ef98a89`同样保留。
业务六笔成功不等于首次测试进程毫无中断；确认完成后不再要求人工资金核查，但原Run均禁止重跑。

## 执行入口

- `test:transfer-fee-matrix`：三模式六笔批次，仅具名授权后运行，不在默认回归。
- `test:transfer-fee-matrix:<fixed|percent|none>:<internal|p2p>`：单项入口，只选一项，不暗中执行六笔。
- `TRANSFER_FEE_MATRIX_RUN_ID`、`TRANSFER_FEE_MATRIX_PLAN=USD_ONLY`、`U2U_RECIPIENT_EMAIL`、`ACCOUNT_TRANSFER_RESTORE_ORIGINAL=true`明确批次上下文。
- 主执行要求进程Money/Admin/Client三个开关true，workers=1/retries=0/repeatEach=1。资金动作尝试标记以排他文件持久化。
- `test:transfer-fee-matrix:approve-resume`：只处理指定原p2p且从未批准的订单，Client开关false，无新提交、密钥或改费。
- `test:transfer-fee-matrix:approved-readonly`：已尝试批准订单的只读核查，三个开关false。
- `test:transfer-fee-matrix:reconcile-restore`：首笔固定USD原订单只读核查，唯一允许的写操作为原配置恢复。仅Admin开关true。
- 恢复入口使用 `TRANSFER_FEE_MATRIX_RECONCILE_RUN_ID`，保留原身份、计划、TRF/TXN和尝试标记。

不得重复使用本次六个已完成Run。原ATF-002、券商Transfer以及旧U2U用例均保留。
