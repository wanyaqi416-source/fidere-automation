import type { Page } from '@playwright/test';

import {
  TransactionsPage,
  type WithdrawalTransactionCriteria,
  type WithdrawalTransactionDiagnostics,
  type WithdrawalTransactionRecord
} from './TransactionsPage';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';

export class WithdrawalHistoryPage {
  readonly transactions: TransactionsPage;

  constructor(readonly page: Page) {
    this.transactions = new TransactionsPage(page);
  }

  async goto(baseURL: string): Promise<void> {
    await this.transactions.goto(baseURL);
    await this.transactions.selectWithdrawalType();
  }

  async diagnose(
    criteria: WithdrawalTransactionCriteria
  ): Promise<WithdrawalTransactionDiagnostics> {
    return this.transactions.diagnoseWithdrawalRecords(criteria);
  }

  async findUnique(
    criteria: WithdrawalTransactionCriteria
  ): Promise<WithdrawalTransactionRecord> {
    return this.transactions.findUniqueWithdrawalRecord(criteria);
  }

  async readRecords(): Promise<WithdrawalTransactionRecord[]> {
    return this.transactions.readVisibleWithdrawalRecords();
  }

  async recordById(clientWithdrawalId: string): Promise<WithdrawalTransactionRecord | undefined> {
    return this.transactions.withdrawalRecordById(clientWithdrawalId);
  }

  async openDetail(record: WithdrawalTransactionRecord): Promise<TransactionDetailDrawer> {
    return this.transactions.openWithdrawalDetail(record);
  }
}
