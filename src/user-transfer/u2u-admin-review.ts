import { expect, type Page } from '@playwright/test';
import { TransferListPage, type AdminTransferListRecord } from '../../pages/admin/TransferListPage';
import { TransferDetailPage } from '../../pages/admin/TransferDetailPage';
import { TransferApprovalReview } from '../../pages/admin/TransferApprovalReview';
import type { BusinessReportApi } from '../reporting/business-report.types';
import { matchesAdminCustomerIdentity } from '../transfer/transfer-e2e';
import { Decimal } from '../utils/money';
import type { U2uEvidence } from './u2u-evidence';

export async function readOriginalU2uApproval(list: TransferListPage, baseURL: string, sender: string, transactionId: string) {
  await list.page.goto(new URL('/zh-CN/operation/fiatAssets', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await list.goto(baseURL);
  // The pre-approval fingerprint already established uniqueness. Query that exact
  // TXN now; restarting a debounced customer search can race pagination refresh.
  const record = await list.waitForRecordStatus(transactionId, /^已批准$/);
  expect(matchesAdminCustomerIdentity(record.userIdentity, sender), 'Original approved Sender unchanged').toBe(true);
  return record;
}

export async function openOriginalU2uReview(input: {
  page: Page; baseURL: string; sender: string; recipient: string;
  evidence: Pick<U2uEvidence, 'senderLedgerId' | 'submittedAt' | 'sourceAccountType' | 'targetAccountType' | 'currency' | 'amount' | 'fee' | 'expectedCredit'>; business: BusinessReportApi;
}) {
  const { page, baseURL, sender, recipient, evidence, business } = input;
  if (!evidence.senderLedgerId || !evidence.submittedAt) throw new Error('Original Client TXN and submission time are required.');
  const list = new TransferListPage(page);
  await page.goto(new URL('/zh-CN/operation/fiatAssets', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await list.goto(baseURL);
  await list.applySupportedFilters({ userKeyword: sender });
  let unique: AdminTransferListRecord | undefined;
  await expect.poll(async () => {
    let records = await list.readAllFilteredRecords();
    const stages: Record<string, number> = {};
    const filter = (label: string, predicate: (record: AdminTransferListRecord) => boolean) => {
      records = records.filter(predicate); stages[label] = records.length;
    };
    filter('Client TXN精确对应', row => row.adminTransactionId === evidence.senderLedgerId);
    filter('记录类型', row => row.recordType === '用户间互转');
    filter('发送方', row => matchesAdminCustomerIdentity(row.userIdentity, sender));
    filter('收款方', row => matchesAdminCustomerIdentity(row.recipientIdentity ?? '', recipient));
    filter('方向', row => row.sourceAccountType === evidence.sourceAccountType && row.targetAccountType === evidence.targetAccountType);
    filter('币种', row => row.currency === evidence.currency);
    filter('金额', row => new Decimal(row.requestedAmount).eq(evidence.amount));
    filter('费用到账', row => new Decimal(row.feeAmount).eq(evidence.fee) && new Decimal(row.netAmount).eq(evidence.expectedCredit));
    filter('时间', row => row.createdAtMs !== undefined && Math.abs(row.createdAtMs - Date.parse(evidence.submittedAt!)) <= 60_000);
    filter('待审核', row => row.status === '待审核');
    business.setBusinessData({ candidateStageCounts: stages, candidateCount: records.length });
    if (records.length > 1) throw new Error('U2U Admin candidateCount>1; approval is forbidden.');
    unique = records.length === 1 ? records[0] : undefined;
    return records.length;
  }, { timeout: 90_000, message: 'Original U2U Admin candidateCount=1 (complete paginated collection)' }).toBe(1);
  const detailPage = new TransferDetailPage(page);
  await detailPage.openFromList(list, unique!.adminTransactionId);
  const detail = await detailPage.readDetail();
  expect(detail.adminTransactionId === evidence.senderLedgerId, 'Original Client/Admin TXN matches').toBe(true);
  expect(detail.recordType).toBe('用户间互转');
  expect(matchesAdminCustomerIdentity(detail.userIdentity, sender), 'Detail Sender matches').toBe(true);
  expect(matchesAdminCustomerIdentity(detail.recipientIdentity ?? '', recipient), 'Detail Recipient matches').toBe(true);
  expect(detail.sourceAccountType).toBe(evidence.sourceAccountType);
  expect(detail.targetAccountType).toBe(evidence.targetAccountType);
  expect(detail.currency).toBe(evidence.currency);
  expect(new Decimal(detail.amount).eq(evidence.amount)).toBe(true);
  expect(new Decimal(detail.fee!).eq(evidence.fee)).toBe(true);
  expect(new Decimal(detail.receivedAmount!).eq(evidence.expectedCredit)).toBe(true);
  expect(detail.status).toBe('待审核');
  const review = new TransferApprovalReview(page);
  await review.open(detailPage);
  business.setBusinessData({ adminTransactionId: detail.adminTransactionId, adminStatus: detail.status });
  return { list, review, detail };
}
