import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Decimal } from '../utils/money';
import { clientDepositIdPattern } from './deposit-e2e';

export function loadDepositClaimResumeSource(environment: NodeJS.ProcessEnv = process.env) {
  const archive = environment.DEPOSIT_RESUME_REPORT_PATH?.trim();
  const transactionId = environment.DEPOSIT_RESUME_TXN?.trim();
  if (!archive && !transactionId) return undefined;
  if (!archive || !transactionId || !clientDepositIdPattern.test(transactionId)) {
    throw new Error('Deposit Resume requires both an original report and an exact Client TXN.');
  }
  const report = JSON.parse(readFileSync(resolve(archive), 'utf8'));
  const cases = report.cases?.filter((item: { caseId: string }) => item.caseId === 'DP-003');
  if (cases?.length !== 1) throw new Error('Original DP-003 report case must be unique.');
  const original = cases[0];
  const data = original.businessData;
  if (data?.confirmationClicks !== 1 || data.claimConfirmationClicks !== 0 || data.confirmed === true) {
    throw new Error('Deposit Resume requires one original Client submission and no Admin claim attempt.');
  }
  const amount = new Decimal(data.depositAmount);
  const before = new Decimal(data.depositBalanceBefore);
  const parseTime = (value: string) => Date.parse(value.replaceAll('/', '-').replace(' ', 'T') + '+08:00');
  const from = parseTime(original.startedAt);
  const to = parseTime(report.endedAt);
  if (!amount.isFinite() || !amount.isPositive() || !before.isFinite() ||
      !data.accountType || !data.depositCurrency || !data.depositChannel ||
      !Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    throw new Error('Original Deposit report fingerprint or balance is incomplete.');
  }
  return { transactionId, amount: amount.toString(), balanceBefore: before.toString(),
    accountType: String(data.accountType), currency: String(data.depositCurrency),
    channel: String(data.depositChannel), submittedFromMs: from, submittedToMs: to };
}
