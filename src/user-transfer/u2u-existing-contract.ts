import type { InternalTransferRecord } from '../transfer/account-transfer-fee-run';
import type { FlowResumeState } from '../flow-engine/resume-state';
import { Decimal } from '../utils/money';
import { requireU2uRecipient } from '../utils/runtime-email';
import { participantHash, type U2uEvidence } from './u2u-evidence';

export const U2U_EXISTING_FLOW_ID = 'user-to-user-transfer-existing';
const regions: Readonly<Record<string, string>> = {
  '香港账户': 'HK', '巴林账户': 'BH', '新加坡账户': 'SG', '美国账户': 'US'
};

export function existingU2uConfig(values: Readonly<Record<string, string | undefined>>) {
  const sender = values.CLIENT_USERNAME?.trim().toLowerCase() ?? '';
  const recipient = requireU2uRecipient(sender, values.U2U_RECIPIENT_EMAIL ?? values.U2U_DEFAULT_RECIPIENT_EMAIL);
  const runId = values.U2U_RUN_ID?.trim() ?? '';
  const account = values.U2U_SOURCE_ACCOUNT_TYPE?.trim() ?? '';
  const targetAccount = values.U2U_TARGET_ACCOUNT_TYPE?.trim() || account;
  const currency = values.U2U_CURRENCY?.trim() ?? '';
  const amount = values.U2U_TEST_AMOUNT?.trim() ?? '';
  if (!/^[A-Z0-9._-]+$/i.test(runId) || !regions[account] || !regions[targetAccount] ||
      !/^[A-Z][A-Z0-9_]*$/.test(currency) || !/^\d+(?:\.\d+)?$/.test(amount) || !new Decimal(amount).gt(0)) {
    throw new Error('U2U_RUN_CONFIG_REQUIRED: configure U2U_RUN_ID, U2U_SOURCE_ACCOUNT_TYPE, U2U_CURRENCY and positive U2U_TEST_AMOUNT.');
  }
  return { sender, recipient, runId, account, targetAccount, currency, amount };
}

export function assertExistingU2uResume(state: FlowResumeState, evidence: U2uEvidence, config: ReturnType<typeof existingU2uConfig>) {
  if (state.stage === 'COMPLETED') throw new Error('U2U Run already completed; do not replay it.');
  if (state.stage === 'PREPARED' && (evidence.confirmationClicks || evidence.verificationClicks || evidence.orderId || evidence.adminApprovalClicks)) {
    throw new Error('U2U attempted evidence cannot resume as a new submission.');
  }
  if (!['PREPARED', 'CLIENT_SUBMIT_ATTEMPTED', 'SECURITY_KEY_VERIFICATION_ATTEMPTED', 'CLIENT_CREATED',
    'ADMIN_LOCATED', 'FIDERE_APPROVAL_ATTEMPTED', 'ADMIN_ACTION_DONE', 'CLIENT_FINALIZED'].includes(state.stage)) {
    throw new Error('Unsupported original U2U Resume stage.');
  }
  if (evidence.runId !== config.runId || evidence.senderHash !== participantHash(config.sender) ||
      evidence.recipientHash !== participantHash(config.recipient) || evidence.sourceAccountType !== config.account ||
      evidence.targetAccountType !== config.targetAccount || evidence.currency !== config.currency ||
      !new Decimal(evidence.amount).eq(config.amount) || state.amount !== evidence.amount || state.currency !== evidence.currency ||
      (state.clientReference && state.clientReference !== evidence.orderId) ||
      (state.adminReference && state.adminReference !== evidence.senderLedgerId)) {
    throw new Error('U2U Resume must preserve the original participants, accounts, amount and order.');
  }
}

export function matchExistingU2uOrders(records: readonly InternalTransferRecord[], evidence: U2uEvidence) {
  if (!evidence.orderIdsBefore || !evidence.submittedAt) throw new Error('Original U2U baseline and submission time are required.');
  return records.filter(row => !evidence.orderIdsBefore!.includes(row.orderNo) && row.transferType === 'p2p' &&
    row.fromRegion === regions[evidence.sourceAccountType] && row.toRegion === regions[evidence.targetAccountType] &&
    row.currency === evidence.currency && new Decimal(row.amount).eq(evidence.amount) &&
    row.remark === `AUTO_TRANSFER_FEE_${evidence.runId}` &&
    Math.abs(row.appliedAt - Date.parse(evidence.submittedAt!)) <= 300_000);
}
