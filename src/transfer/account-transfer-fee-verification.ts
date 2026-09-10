import { expect, type Page } from '@playwright/test';
import { TransferListPage, type AdminTransferListRecord } from '../../pages/admin/TransferListPage';
import { TransferDetailPage } from '../../pages/admin/TransferDetailPage';
import { matchesAdminCustomerIdentity } from './transfer-e2e';
import { verifyCompletedAccountTransfer } from './account-transfer-fee';
import type { FeeRunEvidence, InternalTransferRecord } from './account-transfer-fee-run';
import type { BusinessReportApi } from '../reporting/business-report.types';

export async function readVerifiedAccountTransferSettlement(input: {
  page: Page; baseURL: string; email: string; evidence: FeeRunEvidence; record: InternalTransferRecord; business: BusinessReportApi;
}) {
  const { page, baseURL, email, evidence, record, business } = input;
  if (!record.txNo || !evidence.order || record.orderNo !== evidence.order.orderNo) throw new Error('Original TRF/TXN association is required.');
  const list = new TransferListPage(page);
  await page.goto(new URL('/zh-CN/operation/fiatAssets', baseURL).toString(), { waitUntil: 'domcontentloaded' });
  await list.goto(baseURL);
  let rows: AdminTransferListRecord[] = [];
  await expect.poll(async () => {
    rows = (await list.readAllFilteredRecords()).filter(row => row.adminTransactionId === record.txNo);
    business.setBusinessData({ candidateCount: rows.length, candidateStageCounts: { '原Client TXN精确对应': rows.length } });
    if (rows.length > 1) throw new Error('Original Admin TXN is not unique.');
    return rows.length;
  }, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(1);
  const row = rows[0];
  const listed = verifyCompletedAccountTransfer(record, evidence, { adminTransactionId: row.adminTransactionId,
    recordType: row.recordType, userIdentity: row.userIdentity, sourceAccountType: row.sourceAccountType,
    targetAccountType: row.targetAccountType, currency: row.currency, amount: row.requestedAmount,
    fee: row.feeAmount, receivedAmount: row.netAmount, status: row.status }, matchesAdminCustomerIdentity(row.userIdentity, email));
  const detailPage = new TransferDetailPage(page);
  await detailPage.openFromList(list, record.txNo);
  const detail = await detailPage.readDetail();
  const verified = verifyCompletedAccountTransfer(record, evidence, detail, matchesAdminCustomerIdentity(detail.userIdentity, email));
  expect(verified.received).toBe(listed.received);
  await detailPage.close();
  business.setBusinessData({ adminTransactionId: verified.txNo, adminFinalStatus: verified.adminStatus,
    receivedAmount: verified.received, rawApiActualAmount: record.actualAmount, receivedAmountSource: verified.receivedSource });
  return verified;
}
