import { expect, type Locator, type Page } from '@playwright/test';

import { Decimal, decimalFromText } from '../../src/utils/money';

export type ClientDepositHistoryRecord = {
  clientDepositId?: string;
  currency: string;
  requestedAmount: string;
  receivingBankText: string;
  submittedAtText: string;
  submittedAtMs: number;
  status: string;
  rejectionReason?: string;
};

export type ClientDepositHistoryCriteria = {
  currency: string;
  requestedAmount: string;
  status: string;
  submittedAtMs?: number;
  matchWindowMs?: number;
};

export type ObservedClientDepositRecord = {
  clientDepositId: string;
  currency?: string;
  requestedAmount?: string;
  status?: string;
  submittedAtText?: string;
  submittedAtMs?: number;
  safeFieldNames: string[];
};

export class DepositHistoryPage {
  constructor(readonly page: Page) {}

  async installSafeRecordObserver(): Promise<void> {
    await this.page.addInitScript(() => {
      type SafeRecord = {
        clientDepositId: string;
        currency?: string;
        requestedAmount?: string;
        status?: string;
        submittedAtText?: string;
        safeFieldNames: string[];
      };
      type ObserverWindow = Window & {
        __fidereDepositRecords?: SafeRecord[];
      };
      type ObserverPrototype = SubtleCrypto & {
        __fidereDepositObserverInstalled?: boolean;
      };

      const observerWindow = window as ObserverWindow;
      observerWindow.__fidereDepositRecords = [];
      const prototype = SubtleCrypto.prototype as ObserverPrototype;
      if (prototype.__fidereDepositObserverInstalled) return;

      const originalDecrypt = prototype.decrypt;
      const txnPattern = /\bTXN-[A-Z0-9-]+\b/i;
      const safeText = (value: unknown): string | undefined => {
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
        return undefined;
      };
      const findDirectValue = (
        entries: Array<[string, unknown]>,
        keyPattern: RegExp,
        valuePattern?: RegExp
      ): string | undefined => {
        for (const [key, value] of entries) {
          if (!keyPattern.test(key)) continue;
          const text = safeText(value);
          if (text && (!valuePattern || valuePattern.test(text))) return text;
        }
        return undefined;
      };
      const collect = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }

        const entries = Object.entries(value as Record<string, unknown>);
        const transactionId = entries
          .map(([, item]) => safeText(item))
          .find(item => item && txnPattern.test(item))
          ?.match(txnPattern)?.[0];
        if (transactionId) {
          const amountEntry = entries.find(([key, item]) =>
            /(?:fiat|requested|request|deposit|transaction)?amount/i.test(key) &&
            /^-?[\d,.]+$/.test(safeText(item) ?? '')
          );
          const safeFieldNames = entries
            .filter(([key]) => /^(?:id|txNo|currency|amount|status|state|createdAt|submittedAt|operateTime|time)$/i.test(key))
            .map(([key]) => key)
            .sort();
          const record: SafeRecord = {
            clientDepositId: transactionId,
            currency: findDirectValue(entries, /currency|coin|asset/i, /^[A-Z]{3}$/i),
            requestedAmount: amountEntry ? safeText(amountEntry[1])?.replace(/,/g, '') : undefined,
            status: findDirectValue(entries, /status|state/i),
            submittedAtText: findDirectValue(entries, /created|submitted|date|time/i),
            safeFieldNames
          };
          const records = observerWindow.__fidereDepositRecords ?? [];
          const key = JSON.stringify(record);
          if (!records.some(item => JSON.stringify(item) === key)) records.push(record);
          observerWindow.__fidereDepositRecords = records;
        }
        entries.forEach(([, item]) => collect(item));
      };

      Object.defineProperty(prototype, '__fidereDepositObserverInstalled', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
      });
      prototype.decrypt = async function (...args: Parameters<SubtleCrypto['decrypt']>) {
        const result = await originalDecrypt.apply(this, args);
        try {
          const text = new TextDecoder().decode(result);
          collect(JSON.parse(text));
        } catch {
          // Only valid decrypted JSON is inspected; all other plaintext is discarded.
        }
        return result;
      };
    });
  }

  async readObservedRecords(): Promise<ObservedClientDepositRecord[]> {
    const records = await this.page.evaluate(() => {
      const observerWindow = window as Window & {
        __fidereDepositRecords?: ObservedClientDepositRecord[];
      };
      return observerWindow.__fidereDepositRecords ?? [];
    });
    return records
      .filter(record => clientDepositIdPattern.test(record.clientDepositId))
      .map(record => ({
        ...record,
        submittedAtMs: this.parseObservedTime(record.submittedAtText)
      }));
  }

  async observedRecordById(clientDepositId: string): Promise<ObservedClientDepositRecord | undefined> {
    return (await this.readObservedRecords()).find(
      record => record.clientDepositId.toUpperCase() === clientDepositId.toUpperCase()
    );
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page.getByText('最近提交记录', { exact: true })).toBeVisible();
  }

  async readRecords(): Promise<ClientDepositHistoryRecord[]> {
    await this.expectLoaded();
    const headings = this.page.getByRole('heading').filter({ hasText: /^[A-Z]{3}\s+[\d,.]+$/ });
    const records: ClientDepositHistoryRecord[] = [];

    for (const heading of await headings.all()) {
      if (!(await heading.isVisible())) continue;
      const card = await this.resolveRecordCard(heading);
      const text = (await card.innerText()).trim();
      const amountLine = (await heading.innerText()).trim();
      const currency = amountLine.match(/^[A-Z]{3}/)?.[0];
      const timeText = text.match(/提交时间\s*[:：]?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/)?.[1];
      const status = text.match(/\b(?:pending|processing|failed|rejected)\b|已完成|已拒绝|已取消|处理失败/i)?.[0];
      if (!currency || !timeText || !status) {
        throw new Error('Client Deposit history card is missing currency, submission time, or status.');
      }

      const submittedAtMs = this.parseClientTime(timeText);
      const clientDepositId = text.match(/\bTXN-[A-Z0-9-]+\b/i)?.[0];
      const bank = text.match(/收款银行\s*[:：]?\s*([^\r\n]+)/)?.[1]?.trim() ?? '';
      records.push({
        clientDepositId,
        currency,
        requestedAmount: decimalFromText(amountLine, 'Client Deposit history amount').toString(),
        receivingBankText: bank,
        submittedAtText: timeText,
        submittedAtMs,
        status,
        rejectionReason: text.match(/(?:拒绝原因|驳回原因)\s*[:：]?\s*([^\r\n]+)/)?.[1]?.trim()
      });
    }
    return records;
  }

  async findCandidates(criteria: ClientDepositHistoryCriteria): Promise<ClientDepositHistoryRecord[]> {
    const expectedAmount = new Decimal(criteria.requestedAmount);
    const normalizedStatus = this.normalized(criteria.status);
    const records = await this.readRecords();
    return records.filter(record => {
      const timeMatches = criteria.submittedAtMs === undefined || (
        record.submittedAtMs >= criteria.submittedAtMs - (criteria.matchWindowMs ?? 60_000) &&
        record.submittedAtMs <= criteria.submittedAtMs + (criteria.matchWindowMs ?? 60_000)
      );
      return record.currency === criteria.currency.toUpperCase() &&
        new Decimal(record.requestedAmount).equals(expectedAmount) &&
        this.normalized(record.status) === normalizedStatus &&
        timeMatches;
    });
  }

  private async resolveRecordCard(heading: Locator): Promise<Locator> {
    let container = heading;
    for (let level = 0; level < 5; level += 1) {
      container = container.locator('..');
      const text = await container.innerText();
      if (text.includes('收款银行') && text.includes('提交时间')) return container;
    }
    throw new Error('Client Deposit history card container was not found.');
  }

  private parseClientTime(value: string): number {
    const timestamp = Date.parse(value.replace(' ', 'T') + '+08:00');
    if (!Number.isFinite(timestamp)) {
      throw new Error('Client Deposit submission time could not be parsed.');
    }
    return timestamp;
  }

  private parseObservedTime(value: string | undefined): number | undefined {
    if (!value) return undefined;
    if (/^\d{12,13}$/.test(value)) {
      const timestamp = Number(value);
      return Number.isFinite(timestamp) ? timestamp : undefined;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private normalized(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }
}

const clientDepositIdPattern = /^TXN-[A-Z0-9-]+$/i;
