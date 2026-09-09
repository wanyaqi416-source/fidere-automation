import { expect, type Browser, type Page } from '@playwright/test';
import { TransactionsPage, type UserTransferLedgerRecord } from '../../pages/client/TransactionsPage';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { Decimal } from '../utils/money';
import { maskBusinessId } from '../reporting/sensitive-data-mask';
import { loginU2uParticipant, readU2uBalance } from './u2u-participant';
import { formatU2uBalance } from './u2u-summary';
import { saveU2uEvidence, type U2uEvidence } from './u2u-evidence';

export function matchesU2uLedger(record: Omit<UserTransferLedgerRecord, 'row'>, input: {
  currency: string; accountType: string; signedAmount: string; submittedAt: string; excludedIds: string[];
}) {
  const occurredAt = new Date(record.occurredAt.replace(' ', 'T')).getTime();
  return record.currency === input.currency && record.accountType === input.accountType &&
    new Decimal(record.signedAmount).eq(input.signedAmount) && !input.excludedIds.includes(record.ledgerTransactionId) &&
    Number.isFinite(occurredAt) && occurredAt >= new Date(input.submittedAt).getTime() - 60_000;
}

export async function locateU2uLedger(page: Page, baseURL: string, evidence: U2uEvidence, side: 'sender' | 'recipient', recipientEmail: string) {
  if (!evidence.submittedAt) throw new Error('U2U submission window is missing.');
  const transactions = new TransactionsPage(page);
  let matches: UserTransferLedgerRecord[] = [];
  await expect.poll(async () => {
    await transactions.gotoUserTransferHistory(baseURL);
    matches = (await transactions.readVisibleUserTransferRecords()).filter(record => matchesU2uLedger(record, {
      currency: evidence.currency,
      accountType: side === 'sender' ? evidence.sourceAccountType : evidence.targetAccountType,
      signedAmount: side === 'sender' ? new Decimal(evidence.amount).negated().toFixed() : evidence.expectedCredit,
      submittedAt: evidence.submittedAt!,
      excludedIds: side === 'sender' ? evidence.senderLedgerIdsBefore : evidence.recipientLedgerIdsBefore
    }));
    if (matches.length > 1) throw new Error(`U2U ${side} ledger candidateCount=${matches.length}; do not choose the first record.`);
    return matches.length;
  }, { timeout: 45_000, message: `U2U ${side} unique new ledger record` }).toBe(1);
  const [record] = matches;
  const detail = await transactions.openUserTransferDetail(record);
  if (evidence.orderId) expect(detail.orderId === evidence.orderId, 'Ledger links to the original TRF').toBe(true);
  expect(detail.recipient.toLowerCase() === recipientEmail.toLowerCase(), 'Detail recipient matches configured recipient').toBe(true);
  expect(detail.regions).toEqual([evidence.sourceAccountType, evidence.targetAccountType]);
  expect(record.status).toBe('已完成');
  expect(detail.status).toBe('已完成');
  expect(detail.feeCurrency).toBe(evidence.currency);
  if (side === 'sender') expect(new Decimal(detail.fee).eq(evidence.fee), 'Sender fee matches quote').toBe(true);
  return { record, detail };
}

export async function reconcileU2u(input: {
  browser: Browser; baseURL: string; sender: string; recipient: string; evidence: U2uEvidence; business: BusinessReportApi;
}) {
  const { browser, baseURL, sender, recipient, evidence, business } = input;
  for (const side of ['sender', 'recipient'] as const) {
    const participant = await loginU2uParticipant(browser, baseURL, side === 'sender' ? sender : recipient);
    try {
      await business.step({ action: `${side === 'sender' ? '发送方扣款' : '收款方到账'}余额验证`, expected: '重新干净登录，按本次页面报价及费用规则用Decimal核对余额' }, async ({ setActual }) => {
        const before = new Decimal(side === 'sender' ? evidence.senderBefore : evidence.recipientBefore);
        const expected = side === 'sender' ? before.minus(evidence.amount) : before.plus(evidence.expectedCredit);
        let after = '';
        await expect.poll(async () => {
          after = await readU2uBalance(participant.page, baseURL,
            side === 'sender' ? evidence.sourceAccountType : evidence.targetAccountType, evidence.currency);
          if (side === 'sender') evidence.senderAfter = after; else evidence.recipientAfter = after;
          saveU2uEvidence(evidence);
          return new Decimal(after).eq(expected);
        }, { timeout: 45_000, message: `U2U ${side} settled balance matches the real quote` }).toBe(true);
        const actual = side === 'sender'
          ? `${formatU2uBalance(before.toFixed())} - ${formatU2uBalance(after)} = ${evidence.amount} ${evidence.currency}（手续费内扣）`
          : `${formatU2uBalance(after)} - ${formatU2uBalance(before.toFixed())} = ${evidence.expectedCredit} ${evidence.currency}`;
        setActual(actual);
        business.recordPrimaryOracle({ id: `${side}-balance`, name: side === 'sender' ? '发送方余额' : '收款方到账余额', expected: '实际余额变化与页面报价一致', actual, status: 'passed' });
        business.setBusinessData(side === 'sender' ? { sourceBalanceAfter: formatU2uBalance(after) } : { targetBalanceAfter: formatU2uBalance(after), actualReceivedAmount: evidence.expectedCredit });
      });
      await business.step({ action: `${side === 'sender' ? '发送方' : '收款方'}原订单及流水核对`, expected: '用户、账户、币种、方向、精确金额、时间、原TRF和新TXN匹配，状态已完成' }, async ({ setActual }) => {
        const { record, detail } = await locateU2uLedger(participant.page, baseURL, evidence, side, recipient);
        evidence.orderId ??= detail.orderId;
        if (side === 'sender') evidence.senderLedgerId = record.ledgerTransactionId; else evidence.recipientLedgerId = record.ledgerTransactionId;
        evidence.status = detail.status;
        saveU2uEvidence(evidence);
        setActual(`候选=1；${maskBusinessId(detail.orderId)}；${maskBusinessId(record.ledgerTransactionId)}；${record.signedAmount} ${record.currency}；${detail.status}；收款用户及双方账户地区匹配。`);
        business.recordPrimaryOracle({ id: `${side}-record`, name: `${side}订单及流水`, expected: '同一真实TRF、唯一新TXN和已完成状态', actual: `candidateCount=1；${maskBusinessId(detail.orderId)}；已完成`, status: 'passed' });
        business.setBusinessData({ transferOrderId: detail.orderId, transactionStatus: detail.status,
          ...(side === 'sender' ? { senderLedgerTransactionId: record.ledgerTransactionId } : { recipientLedgerTransactionId: record.ledgerTransactionId }) });
      });
    } finally {
      await participant.context.close();
    }
  }
}
