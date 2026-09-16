import { matchAdminTransferCandidates, requireUniqueAdminTransferCandidate,
  type AdminTransferCandidate, type TransferFingerprint } from './transfer-e2e';

export function isClientTransferCompleted(status: string): boolean {
  return /^(已完成|完成|completed)$/i.test(status.trim());
}

export function locateApprovableTransfer(
  records: readonly AdminTransferCandidate[], fingerprint: TransferFingerprint, windowMs: number
): AdminTransferCandidate {
  // Already-approved and pending records must be matched together: selecting
  // one status first could hide a second order with the same fingerprint.
  const candidates = ['待审核', '已批准'].flatMap(adminStatus =>
    matchAdminTransferCandidates(records, { ...fingerprint, adminStatus }, windowMs)
  ).filter(record => record.createdAtMs !== undefined &&
    record.createdAtMs >= Math.floor(fingerprint.runStartedAtMs / 60_000) * 60_000 &&
    record.createdAtMs <= fingerprint.clientSubmittedAtMs + windowMs);
  return requireUniqueAdminTransferCandidate(candidates);
}
