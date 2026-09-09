import {
  MoneyMutationGuard,
  FlowStateStore,
  advanceFlowState,
  createPreparedFlowState,
  matchCandidatesByStages,
  matchesConfiguredCustomerIdentity,
  stageIndex,
  type CandidateMatchStage,
  type FlowResumeState,
  type MutationRuntime
} from '../flow-engine';

export const ACCOUNT_OPENING_CASES = {
  validation: 'OPEN-US-001',
  rejectReadonly: 'OPEN-US-002',
  approve: 'OPEN-US-003',
  recovery: 'OPEN-US-004'
} as const;

export const US_ACCOUNT_OPENING_FLOW_ID = 'account-opening-us-approve';

export type AccountOpeningCandidate = {
  applicationId?: string;
  customerText: string;
  accountType?: string;
  status: string;
  detailUrl?: string;
  processUrl?: string;
  createdAtMs?: number;
};

export type AccountOpeningFingerprint = {
  customerIdentity: string;
  accountType: string;
  status: string;
  submittedAtMs?: number;
  matchWindowMs?: number;
};

export function diagnoseAccountOpeningCandidates(
  records: readonly AccountOpeningCandidate[],
  fingerprint: AccountOpeningFingerprint
) {
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const stages: CandidateMatchStage<AccountOpeningCandidate>[] = [
    {
      id: 'status',
      label: '审核状态',
      matches: record => normalized(record.status) === normalized(fingerprint.status)
    },
    {
      id: 'customer',
      label: '测试客户',
      matches: record => matchesConfiguredCustomerIdentity(record.customerText, fingerprint.customerIdentity)
    },
    {
      id: 'timeWindow',
      label: '提交时间窗口',
      matches: record => {
        if (!fingerprint.submittedAtMs || !fingerprint.matchWindowMs) return true;
        if (!record.createdAtMs) return false;
        return Math.abs(record.createdAtMs - fingerprint.submittedAtMs) <= fingerprint.matchWindowMs;
      }
    }
  ];
  if (records.some(record => record.accountType && record.accountType !== '页面未提供')) {
    stages.splice(0, 0, {
      id: 'accountType',
      label: '账户类型',
      matches: record => normalized(record.accountType ?? '') === normalized(fingerprint.accountType)
    });
  }
  return matchCandidatesByStages(records, stages);
}

export function prepareAccountOpeningResume(
  runId: string,
  accountType: string
): FlowResumeState {
  if (!accountType.trim()) {
    throw new Error('Account Opening Resume requires the account type selected on Client.');
  }
  return createPreparedFlowState({
    runId,
    flowId: US_ACCOUNT_OPENING_FLOW_ID
  });
}

export function activeUsAccountOpeningStates(
  store = new FlowStateStore()
): FlowResumeState[] {
  return store.list(US_ACCOUNT_OPENING_FLOW_ID).filter(state =>
    stageIndex(state.stage) >= stageIndex('DOCUMENTS_UPLOADED') &&
    state.stage !== 'COMPLETED'
  );
}

export function advanceUsAccountOpeningState(
  store: FlowStateStore,
  current: FlowResumeState,
  nextStage: FlowResumeState['stage'],
  updates: Parameters<typeof advanceFlowState>[2] = {}
): FlowResumeState {
  const next = advanceFlowState(current, nextStage, updates);
  store.save(next);
  return next;
}

export class UsAccountOpeningExecutionGuard {
  private readonly mutation = new MoneyMutationGuard(US_ACCOUNT_OPENING_FLOW_ID, true, true);
  private authenticationReady = false;
  private documentSigningReady = false;
  private documentCompleteClicks = 0;
  private documentSigningConfirmations = 0;
  private openFeeConfirmationClicks = 0;

  validateRuntime(runtime: MutationRuntime): void {
    this.mutation.validateRuntime(runtime);
  }

  markAuthenticationReady(clientReady: boolean, adminReady: boolean): void {
    this.mutation.markAuthenticationReady(clientReady, adminReady);
    this.authenticationReady = true;
  }

  assertDocumentCompletionAllowed(safetySwitches: Readonly<Record<string, boolean>>): void {
    this.assertAuthenticatedSwitches(safetySwitches);
    if (this.documentCompleteClicks > 0) {
      throw new Error('OPEN-US-003 Documenso Complete is limited to once per run.');
    }
  }

  recordDocumentCompleteClick(): void {
    if (this.documentCompleteClicks > 0) {
      throw new Error('OPEN-US-003 Documenso Complete was already recorded.');
    }
    this.documentCompleteClicks += 1;
  }

  assertDocumentSigningConfirmationAllowed(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    this.assertAuthenticatedSwitches(safetySwitches);
    if (this.documentCompleteClicks !== 1) {
      throw new Error('OPEN-US-003 Documenso Sign requires one preceding Complete click.');
    }
    if (this.documentSigningConfirmations > 0) {
      throw new Error('OPEN-US-003 Documenso confirmation Sign is limited to once per run.');
    }
  }

  recordDocumentSigningConfirmation(): void {
    if (this.documentSigningConfirmations > 0) {
      throw new Error('OPEN-US-003 Documenso confirmation Sign was already recorded.');
    }
    this.documentSigningConfirmations += 1;
    this.documentSigningReady = true;
  }

  markExistingDocumentSigned(): void {
    this.documentSigningReady = true;
  }

  assertOpenFeeConfirmationAllowed(): void {
    if (!this.authenticationReady) {
      throw new Error('OPEN-US-003 authentication preflight has not completed.');
    }
    if (!this.documentSigningReady) {
      throw new Error(
        'OPEN-US-003 fee confirmation requires completed Documenso signing evidence.'
      );
    }
    if (this.openFeeConfirmationClicks > 0) {
      throw new Error('OPEN-US-003 opening fee dialog is limited to once per run.');
    }
  }

  recordOpenFeeConfirmation(): void {
    if (this.openFeeConfirmationClicks > 0) {
      throw new Error('OPEN-US-003 opening fee dialog was already recorded.');
    }
    this.openFeeConfirmationClicks += 1;
  }

  assertFeeConfirmationAllowed(safetySwitches: Readonly<Record<string, boolean>>): void {
    if (this.openFeeConfirmationClicks !== 1) {
      throw new Error('OPEN-US-003 fee confirmation requires one opened fee dialog.');
    }
    this.mutation.assertClientMoneyConfirmationAllowed(safetySwitches);
  }

  recordFeeConfirmationClick(): void {
    this.mutation.recordClientMoneyConfirmation();
  }

  assertSecurityKeyVerificationAllowed(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    this.mutation.assertSecurityKeyVerificationAllowed(safetySwitches);
  }

  recordSecurityKeyVerification(): void {
    this.mutation.recordSecurityKeyVerification();
  }

  assertApplicationCreationAllowed(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    this.mutation.assertClientSubmissionAllowed(safetySwitches);
  }

  recordApplicationCreated(): void {
    this.mutation.recordClientSubmission();
  }

  /** @deprecated Account Opening must use the explicit opening-fee and Security Key sequence. */
  assertClientSubmissionAllowed(
    _safetySwitches: Readonly<Record<string, boolean>>
  ): never {
    throw new Error(
      'OPEN-US-003 direct Client submission is disabled; use fee confirmation, Security Key verification, and application creation evidence.'
    );
  }

  /** @deprecated Account Opening creation is recorded only after fee and Security Key evidence. */
  recordClientSubmission(): never {
    throw new Error(
      'OPEN-US-003 direct Client submission recording is disabled; use recordApplicationCreated().'
    );
  }

  recordUniqueAdminCandidate(candidateCount: number): void {
    this.mutation.recordUniqueAdminCandidate(candidateCount);
  }

  assertAdminApprovalAllowed(safetySwitches: Readonly<Record<string, boolean>>): void {
    this.mutation.assertAdminActionAllowed(safetySwitches);
  }

  recordAdminApproval(): void {
    this.mutation.recordAdminAction();
  }

  snapshot() {
    return {
      ...this.mutation.snapshot(),
      documentSigningReady: this.documentSigningReady,
      documentCompleteClicks: this.documentCompleteClicks,
      documentSigningConfirmations: this.documentSigningConfirmations,
      openFeeConfirmationClicks: this.openFeeConfirmationClicks
    };
  }

  private assertAuthenticatedSwitches(
    safetySwitches: Readonly<Record<string, boolean>>
  ): void {
    if (!this.authenticationReady) {
      throw new Error('OPEN-US-003 authentication preflight has not completed.');
    }
    const disabled = Object.entries(safetySwitches)
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    if (disabled.length > 0) {
      throw new Error(`OPEN-US-003 mutation safety switches are closed: ${disabled.join(', ')}.`);
    }
  }
}

export const ACCOUNT_OPENING_PRIMARY_ORACLES = {
  approve: [
    '5份开户资料上传成功',
    'Documenso真实Complete成功',
    'Client只创建一条开户申请',
    'Admin候选唯一',
    'Fidere Admin审核通过',
    '申请真实推送Interlace/BaaS',
    'BaaS最终返回成功状态',
    'Client美国账户最终显示已开户',
    '美国账户真实详情可以打开',
    '没有创建第二条开户申请',
    '开户费金额从真实确认弹窗读取',
    '付款账户USD余额足够支付开户费',
    '开户费确认只点击一次',
    '安全密钥验证只执行一次',
    '开户费扣减符合页面实际金额'
  ]
} as const;

export const ACCOUNT_OPENING_SECONDARY_ORACLES = [
  '通知记录',
  '预计处理时长展示',
  '非核心资料展示字段'
] as const;
