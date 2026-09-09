import type { RegistrationApprovalAccountType } from './registration-admin-approval-journey';

export type RegistrationAccountType = 'PERSONAL' | 'BUSINESS';

export const REGISTRATION_KYC = {
  PERSONAL: {
    storageType: 'personal', tab: '个人用户', entityType: '1', clientStatusField: 'kyc_status',
    responsePath: '/admin-api/operation/kyc/process',
    flowId: 'personal-registration-admin-approval', caseId: 'REG-P-003',
    approvalSteps: ['info_review', 'doc_review']
  },
  BUSINESS: {
    storageType: 'corporate', tab: '企业用户', entityType: '2', clientStatusField: 'kyb_status',
    responsePath: '/admin-api/operation/kyb/application',
    flowId: 'corporate-registration-admin-approval', caseId: 'REG-C-003',
    approvalSteps: ['application_review']
  }
} as const satisfies Record<RegistrationAccountType, { storageType: RegistrationApprovalAccountType;
  tab: string; entityType: string; clientStatusField: string; responsePath: string;
  flowId: string; caseId: string; approvalSteps: readonly string[] }>;

export type RegistrationKycStage =
  | 'PERSONAL_REGISTRATION_SUBMITTED' | 'BUSINESS_REGISTRATION_SUBMITTED'
  | 'ADMIN_PERSONAL_CASE_FOUND' | 'ADMIN_BUSINESS_CASE_FOUND'
  | 'KYC_APPROVED' | 'CLIENT_KYC_APPROVED';

export type RegistrationKycSource = {
  accountType: RegistrationAccountType;
  runId: string;
  email: string;
  displayName: string;
  userId?: string;
  reviewId?: string;
  clientSubmittedAt?: string;
};

export type RegistrationKycCase = {
  accountType: RegistrationAccountType;
  reviewId: string;
  userId: string;
  email: string;
  displayName: string;
  processPath: string;
  applicationId?: string;
  step: string;
  status: string;
  approved: boolean;
  rejected: boolean;
  signed: boolean;
  completedSteps: string[];
};

export function normalizedRegistrationName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

export function assertRegistrationCaseIdentity(
  source: RegistrationKycSource,
  candidate: RegistrationKycCase,
  pinned: { reviewId?: string; userId?: string; applicationId?: string } = {}
): void {
  if (candidate.accountType !== source.accountType ||
      candidate.email.trim().toLowerCase() !== source.email.trim().toLowerCase() ||
      normalizedRegistrationName(candidate.displayName) !== normalizedRegistrationName(source.displayName)) {
    throw new Error('KYC_CASE_IDENTITY_MISMATCH: account type, email or accepted display name differs.');
  }
  for (const key of ['reviewId', 'userId'] as const) {
    if (!candidate[key] || (source[key] && source[key] !== candidate[key]) ||
        (pinned[key] && pinned[key] !== candidate[key])) {
      throw new Error(`KYC_CASE_IDENTITY_MISMATCH: ${key} does not match the original registration.`);
    }
  }
  if (pinned.applicationId && pinned.applicationId !== candidate.applicationId) {
    throw new Error('KYC_CASE_IDENTITY_MISMATCH: the Corporate application changed.');
  }
}

// Parse only business fields. Never retain the API body or authentication values.
export function decodeRegistrationKycCase(
  accountType: RegistrationAccountType,
  body: unknown,
  processPath: string
): RegistrationKycCase {
  const data = (body as { data?: Record<string, any> })?.data;
  const url = new URL(processPath, 'https://sandbox.test');
  const reviewId = url.searchParams.get('reviewId');
  if (!data || !reviewId) throw new Error('KYC_CASE_METADATA_MISSING');
  const pathUserId = url.pathname.match(/\/processingReviews\/([^/]+)\//)?.[1];
  if (accountType === 'BUSINESS') {
    const application = data.application;
    const userId = String(application?.userId ?? '');
    if (!application?.id || !application.email || !application.companyNameEn || !userId || !application.statusText) {
      throw new Error('KYB_APPLICATION_IDENTITY_OR_STATUS_MISSING');
    }
    if (userId !== pathUserId) throw new Error('KYB_APPLICATION_USER_ID_MISMATCH');
    const status = String(application.statusText).trim();
    return {
      accountType, reviewId, userId, email: application.email, displayName: application.companyNameEn,
      processPath, applicationId: String(application.id), step: 'application_review', status,
      approved: /^(已通过|审核通过|已批准|已完成|Approved)$/i.test(status),
      rejected: /拒绝|驳回|rejected/i.test(status), signed: Number(data.eSignature?.status) === 1,
      completedSteps: /^(已通过|审核通过|已批准|已完成|Approved)$/i.test(status) ? ['application_review'] : []
    };
  }
  const member = data.member;
  if (String(data.reviewId) !== reviewId || !data.userId || !member?.email || !member.fullName || !data.reviewStep) {
    throw new Error('KYC_PROCESS_IDENTITY_OR_STAGE_MISSING');
  }
  if (String(data.userId) !== pathUserId) throw new Error('KYC_PROCESS_USER_ID_MISMATCH');
  const stages = Array.isArray(data.stages) ? data.stages : [];
  const approved = Number(member.kycStatus) === 1 && stages.length > 0 &&
    stages.every(stage => stage.status === 'approved');
  return {
    accountType, reviewId, userId: String(data.userId), email: member.email, displayName: member.fullName,
    processPath, step: data.reviewStep,
    status: approved ? '审核通过' : stages.find(stage => stage.stage === data.reviewStep)?.statusLabel ?? 'unknown',
    approved, rejected: stages.some(stage => stage.status === 'rejected'),
    signed: Number(data.kyc?.clientAuthorizationStatus) === 1 ||
      (Array.isArray(data.documents) && data.documents.length > 0 &&
        data.documents.every((document: { statusLabel?: string }) => document.statusLabel === '已签署')),
    completedSteps: stages.filter(stage => stage.status === 'approved').map(stage => String(stage.stage))
  };
}

export function decodeClientKycStatus(body: unknown, source: Pick<RegistrationKycSource, 'accountType' | 'email' | 'userId'>) {
  const session = body as Record<string, any> | undefined;
  const config = REGISTRATION_KYC[source.accountType];
  if (!session?.user?.email || session.user.email.toLowerCase() !== source.email.toLowerCase() ||
      String(session.entityType) !== config.entityType) {
    throw new Error('CLIENT_KYC_SESSION_IDENTITY_MISMATCH');
  }
  if (source.userId && session.user.id != null && String(session.user.id) !== source.userId) {
    throw new Error('CLIENT_KYC_SESSION_USER_ID_MISMATCH');
  }
  const status = String(session[config.clientStatusField] ?? 'unknown');
  return { accountType: source.accountType, status, approved: status === '1', observedAt: new Date().toISOString() };
}
