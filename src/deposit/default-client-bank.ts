import type { Page } from '@playwright/test';
import { AdminFiatAccountReviewPage, type AdminFiatAccountCandidate } from '../../pages/admin/AdminFiatAccountReviewPage';
import { AdminClientUsersPage } from '../../pages/admin/AdminClientUsersPage';
import { RegistrationKycStatusPage } from '../../pages/client/RegistrationKycStatusPage';

export function approvedBankNumber(bank: { accountNumber?: string; accountText: string }): string {
  return (bank.accountNumber ?? bank.accountText.split(/\s+SWIFT\s*:/i)[0]).replace(/\s/g, '');
}

export function chooseApprovedBank<T extends Pick<AdminFiatAccountCandidate, 'accountId' | 'bankName' | 'accountText' | 'holderText'>>(
  records: T[], selection: { accountId?: string; accountSuffix?: string; holder?: string; selectForFresh?: boolean } = {}
): T {
  const candidates = records.filter(row => selection.accountId ? row.accountId === selection.accountId :
    (!selection.accountSuffix || approvedBankNumber(row).endsWith(selection.accountSuffix)) &&
    (!selection.holder || row.holderText.replace(/\s+/g, ' ').trim() === selection.holder.replace(/\s+/g, ' ').trim()));
  if (candidates.length > 1 && selection.selectForFresh && !selection.accountId && !selection.accountSuffix && !selection.holder) {
    if (new Set(candidates.map(row => row.accountId)).size !== candidates.length) throw new Error('Duplicate bank references cannot be selected.');
    return [...candidates].sort((a, b) => a.accountId.localeCompare(b.accountId, 'en'))[0];
  }
  if (candidates.length !== 1) throw new Error(`PRECONDITION_NOT_MET: approved bank candidateCount=${candidates.length}; select an existing bank, never create one.`);
  return candidates[0];
}

// Shared only by the two standalone fiat flows; no menu-wide user resolution.
export async function readDefaultFiatUser(input: {
  clientPage: Page; adminPage: Page; clientBase: string; adminBase: string; email: string; runId: string;
}) {
  const identity = await new AdminClientUsersPage(input.adminPage).readDepositCustomerIdentityByEmail(input.adminBase, input.email);
  const source = { email: input.email, runId: input.runId, displayName: identity.name,
    userId: identity.userId, accountType: identity.accountType };
  await new RegistrationKycStatusPage(input.clientPage).expectApproved(source, input.clientBase);
  const banks = await new AdminFiatAccountReviewPage(input.adminPage).readApprovedAccountsForEmail(input.adminBase, input.email);
  return { source, banks };
}
