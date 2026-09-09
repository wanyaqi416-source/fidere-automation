import { matchCandidatesByStages } from '../flow-engine';
import type { BrokerOpeningRow } from '../../pages/admin/BrokerOpeningReviewPage';

export function matchTigerOpening(rows: BrokerOpeningRow[], input: {
  email: string; displayName: string; submittedFrom?: string; submittedTo?: string; reference?: string;
}) {
  return matchCandidatesByStages(rows, [
    { id: 'email', label: '原Journey邮箱', matches: row => {
      const emails = row.customerText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      return emails.some(email => email.toLowerCase() === input.email.toLowerCase());
    } },
    { id: 'name', label: '原用户名称', matches: row => row.customerText.includes(input.displayName) },
    { id: 'broker', label: '老虎证券', matches: row => /^(Tiger|老虎证券|TIGER（老虎证券）)$/i.test(row.broker) },
    { id: 'type', label: '个人账户', matches: row => /^(个人|个人用户|Personal)$/i.test(row.accountType) },
    { id: 'reference', label: '原申请引用（如已取得）', matches: row => !input.reference || row.reference === input.reference },
    { id: 'time', label: '本次Client提交时间', matches: row => {
      if (!input.submittedFrom || !input.submittedTo) return true;
      const match = row.submittedAt.match(/(\d{4})[-/](\d{2})[-/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (!match) return false;
      const observed = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+08:00`);
      return observed >= Date.parse(input.submittedFrom) - 60_000 && observed <= Date.parse(input.submittedTo) + 60_000;
    } }
  ]);
}
