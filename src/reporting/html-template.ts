import type {
  BusinessDiagnosticInput,
  BusinessEvidence,
  BusinessOracleRecord,
  BusinessReportCase,
  BusinessReportRun,
  BusinessStepRecord
} from './business-report.types';
import { formatDuration } from './business-report.utils';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function yesNo(value: boolean): string {
  return value ? '是' : '否';
}

function listText(values: string[]): string {
  return values.length > 0 ? values.map(escapeHtml).join('、') : '未提供';
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '未提供';
  }

  if (typeof value === 'object') {
    return escapeHtml(JSON.stringify(value));
  }

  return escapeHtml(value);
}

function renderBaselineComparison(report: BusinessReportRun): string {
  const comparison = report.baselineComparison;
  if (!comparison) {
    return '<section class="baseline-panel"><h2>Regression Baseline Comparison</h2><p class="empty">尚未建立Automation Baseline。</p></section>';
  }
  if (!comparison.applicable) {
    return `<section class="baseline-panel"><h2>Regression Baseline Comparison</h2>
      <div class="baseline-banner neutral">${escapeHtml(comparison.message)}</div>
      <div class="baseline-grid"><div><strong>Baseline Version</strong>${escapeHtml(comparison.baselineVersion)}</div><div><strong>Current Run</strong>${escapeHtml(comparison.currentRunId)}</div></div>
    </section>`;
  }

  const resultClass = comparison.hasNewRegression ? 'regression' : 'stable';
  const changeList = (label: string, values: typeof comparison.addedTests): string =>
    `<div><strong>${escapeHtml(label)}</strong><span>${values.length}</span>${values.length > 0 ? `<small>${values.map(item => escapeHtml(`${item.caseId} ${item.name}`)).join('<br>')}</small>` : ''}</div>`;

  return `<section class="baseline-panel"><h2>Regression Baseline Comparison</h2>
    <div class="baseline-banner ${resultClass}">${escapeHtml(comparison.message)}</div>
    <div class="baseline-grid">
      <div><strong>Baseline Version</strong>${escapeHtml(comparison.baselineVersion)}</div>
      <div><strong>Current Run</strong>${escapeHtml(comparison.currentRunId)}</div>
      <div><strong>总用例变化</strong>${escapeHtml(`${comparison.baselineTotal} -> ${comparison.currentTotal} (${comparison.totalDelta >= 0 ? '+' : ''}${comparison.totalDelta})`)}</div>
      ${changeList('新增测试', comparison.addedTests)}
      ${changeList('新增PASS', comparison.newPasses)}
      ${changeList('新增FAIL', comparison.newFailures)}
      ${changeList('新增WARNING', comparison.newWarnings)}
      ${changeList('已知WARNING', comparison.knownWarnings)}
      ${changeList('原有用例回归', comparison.regressions)}
      ${changeList('已恢复', comparison.recovered)}
      ${changeList('基线缺失用例', comparison.removedTests)}
    </div>
  </section>`;
}

const businessDataLabels: Record<string, string> = {
  digitalAddressName: '地址名称', digitalAddressAsset: '加密资产', digitalAddressNetwork: '地址网络',
  digitalWalletMasked: '钱包地址（脱敏）', digitalWhitelistReference: '白名单编号（脱敏）',
  digitalAddressCandidateCount: 'Admin候选数量', digitalAddressAdminBefore: 'Admin审核前状态',
  digitalAddressAdminAfter: 'Admin审核后状态', digitalAddressClientStatus: 'Client地址状态',
  digitalAddressSubmissionCount: '新增提交次数', digitalAddressVerificationCount: '安全密钥验证次数',
  digitalAddressApprovalCount: '最终审核次数',
  environment: '测试环境',
  accountType: '账户类型',
  sourceAccountType: '转出账户类型',
  targetAccountType: '转入账户类型',
  exchangePair: '兑换组合',
  fromCurrency: '转出币种',
  toCurrency: '转入币种',
  amount: '测试金额',
  sourceAmount: '转出金额',
  sourceBalanceBefore: '兑换前转出余额',
  sourceBalanceAfter: '兑换后转出余额',
  targetBalanceBefore: '兑换前转入余额',
  targetBalanceAfter: '兑换后转入余额',
  rate: '最终汇率',
  fee: '手续费',
  expectedReceivedAmount: '预计到账',
  actualReceivedAmount: '实际到账',
  ledgerTransactionId: '交易流水编号',
  exchangeOrderId: '兑换订单编号',
  exchangeCreatedAt: '兑换创建日期',
  exchangeCompletedAt: '兑换完成日期',
  transferDirection: '资金互转方向',
  transferCurrency: '互转币种',
  supportedCurrencies: '页面支持币种',
  transferAmount: '转账金额',
  transferSourceBalanceBefore: '互转前转出余额',
  transferSourceBalanceAfter: '互转后转出余额',
  transferTargetBalanceBefore: '互转前转入余额',
  transferTargetBalanceAfter: '互转后转入余额',
  clientTransferId: 'Client互转订单编号',
  transferOrderId: '资金互转订单编号',
  depositOrderId: '入金订单编号',
  systemTransactionId: '系统流水编号',
  wireReferenceId: '电汇指令参考号',
  depositCurrency: '入金币种',
  depositAmount: '申请入金金额',
  originalDepositAmount: 'Admin原始来账金额',
  actualDepositAmount: '实际入账金额',
  actualBalanceIncrease: '账户实际增加金额',
  balanceOracle: '余额Oracle',
  depositChannel: '打款渠道',
  depositPurpose: '打款用途',
  depositSourceOfFunds: '资金来源',
  depositBalanceBefore: '入金前账户余额',
  depositBalanceAfter: '入金后账户余额',
  depositBalanceCurrent: '当前目标账户余额',
  clientDepositStatus: 'Client入金状态',
  adminDepositStatus: 'Admin入账认领状态',
  clientDepositHistoryCandidateCount: 'Client历史候选数',
  clientDetailTransactionNumber: 'Client详情“交易编号”字段',
  existingDepositResume: '现有DP-003续跑状态',
  noNewDepositCreated: '是否未创建第二笔入金',
  payingBankOptionCount: '可用打款银行选项数',
  adminReference: 'Admin参考号',
  claimConfirmationClicks: '确认认领点击次数',
  rejectConfirmationClicks: '确认拒绝点击次数',
  withdrawalOrderId: '出金订单编号',
  withdrawalCurrency: '出金币种',
  requestedAmount: '申请金额',
  feeAmount: '手续费',
  expectedNetAmount: '预计到账金额',
  actualDebitAmount: '实际扣款金额',
  beneficiaryAccountSuffix: '收款账户尾号',
  withdrawalPurpose: '转账用途',
  beforeAvailableBalance: '提交前可用余额',
  beforeTotalBalance: '提交前总余额',
  submittedAvailableBalance: '提交后可用余额',
  submittedTotalBalance: '提交后总余额',
  afterRejectedAvailableBalance: '拒绝后可用余额',
  afterRejectedTotalBalance: '拒绝后总余额',
  afterApprovedAvailableBalance: '批准后可用余额',
  afterApprovedTotalBalance: '批准后总余额',
  frozenAmount: '冻结金额',
  releasedAmount: '拒绝后释放金额',
  clientWithdrawalStatus: 'Client出金状态',
  adminWithdrawalStatus: 'Admin出金状态',
  clientWithdrawalCandidateCount: 'Client出金候选数',
  clientCandidateStageCounts: 'Client候选逐层数量',
  confirmationClicks: '确认转账点击次数',
  senderLedgerTransactionId: '发送方流水编号',
  recipientLedgerTransactionId: '收款方流水编号',
  senderIdentity: '发送方',
  recipientIdentity: '收款方',
  securityVerificationClicks: '安全密钥验证点击次数',
  approvalClicks: 'Admin批准点击次数',
  allWithdrawalAmount: '全部出金金额',
  displayedLimits: '页面展示限额',
  overBalanceAmount: '超余额校验金额',
  overBalanceFormBehavior: '超余额表单行为',
  overBalanceFeeText: '超余额确认页手续费',
  securityInputCount: '安全密钥输入框数量',
  safeRequestEvidence: '安全请求证据',
  adminStatusOptions: 'Admin状态选项',
  historicalRejectedCount: '历史拒绝记录数',
  afterRejectedAvailableBalanceOracle: '拒绝后可用余额Oracle',
  historicalCompletedCount: '历史完成记录数',
  currentPendingActionableCount: '当前待处理可操作记录数',
  approvalRequiredFields: 'Admin批准必填字段',
  thirdPartyDependency: '第三方依赖',
  availablePaymentChannels: 'Sandbox可用打款渠道',
  availablePaymentBanks: 'Sandbox可用打款银行',
  selectedPaymentChannel: '已选择打款渠道',
  selectedPaymentBank: '已选择打款银行',
  paymentProofFileName: '打款凭证文件名',
  paymentProofType: '打款凭证类型',
  paymentProofSizeBytes: '打款凭证大小（字节）',
  paymentProofUploaded: 'Sandbox测试凭证已上传',
  approvalNoteFilled: '审批备注已填写',
  requiredApprovalFieldsSatisfied: '审批必填项已满足',
  approvalButtonEnabled: '批准按钮可用',
  mutationPerformed: '发生业务Mutation',
  investmentOrderId: '理财订单编号',
  openingBrokerCount: '券商账户数量',
  openingAvailableBrokerCount: '当前可申请券商数量',
  openingAccountTypes: '开户账户类型',
  openingFees: '页面开户费用',
  openingDocumentUploads: '美国开户Sandbox资料上传结果',
  taxFormStatus: 'FATCA税务表格状态',
  signingProvider: '第三方签署平台',
  signingOpeningMode: '第三方页面打开方式',
  signingMethod: '实际签名方式',
  signatureUploadAvailable: '支持上传签名图片',
  typedSignatureAvailable: '支持Typed Signature',
  initialsRequired: '需要Initials',
  dateHandling: '日期字段处理',
  checkboxHandling: 'Checkbox处理',
  identityChallengePresent: '存在OTP/Captcha身份校验',
  signingRequiredFieldsBefore: '签署前剩余必填字段数',
  signingRequiredFieldsAfter: '字段级签名后剩余必填字段数',
  signingFinalAction: '最终完成按钮',
  signingFinalActionLocator: '最终完成按钮Locator',
  signingFieldApplyClicks: '字段级Sign点击次数',
  signingFinalClicks: '最终Complete点击次数',
  finalSubmissionClicks: 'Client最终提交点击次数',
  adminOpeningRowCount: 'Admin开户记录行数',
  adminOpeningMatchedHistoryCount: 'Admin开户历史匹配数',
  usOpeningStatusBefore: '执行前美国账户状态',
  openingDocumentAssetCount: '开户固定资料数量',
  documensoCompleteClicks: 'Documenso Complete点击次数',
  documensoSigningConfirmationClicks: 'Documenso确认Sign点击次数',
  signingPromptTitle: 'Documenso签署确认框',
  documensoNetworkStatus: 'Documenso网络预检HTTP状态',
  existingUsOpeningApplicationCount: '执行前美国开户申请数',
  usOpeningChannel: '美国账户第三方渠道',
  usOpeningChannelEnabled: '美国账户第三方渠道已启用',
  signingFinalRequestPath: 'Documenso最终请求路径',
  signingFinalHttpStatus: 'Documenso最终请求HTTP状态',
  clientSubmissionEvidence: 'Client开户提交证据',
  clientSubmittedAt: 'Client开户提交时间',
  clientOpeningReference: 'Client开户申请编号',
  adminOpeningReference: 'Admin开户审核编号',
  adminOpeningDetailVerified: 'Admin开户详情二次核对',
  adminOpeningUploadedDocumentCount: 'Admin可见开户资料数量',
  adminFatcaDocumentAvailable: 'Admin可见FATCA签署文档',
  adminOpeningApprovalClicks: 'Admin审核通过点击次数',
  adminApprovalRequestPath: 'Admin审核请求路径',
  adminApprovalHttpStatus: 'Admin审核请求HTTP状态',
  displayName: '用户名称',
  adminApproveCount: 'Admin审核通过次数',
  approvalPreExisted: '审核是否在本Run前完成',
  pendingCandidateCount: '待审核候选数',
  candidateSearchMode: '候选搜索方式',
  adminReviewReference: 'Admin审核引用',
  clientSubmissionStatus: 'Client提交状态',
  adminFinalState: 'Admin最终状态',
  clientFinalState: 'Client最终状态',
  resumeEndStage: 'Resume结束阶段',
  noNewUserCreated: '未重新创建用户',
  noRepeatedSigning: '未重复签署',
  noRepeatedUpload: '未重新上传资料',
  noRepeatedClientSubmission: '未重复Client提交',
  adminApprovalCompletionEvidence: 'Admin审核完成证据',
  fidereStatusAfter: 'Fidere审核后状态',
  baasSubmissionConfirmed: '已进入BaaS处理阶段',
  baasFinalStatus: 'BaaS最终状态',
  baasFailureReason: 'BaaS失败原因',
  clientUsAccountFinalStatus: 'Client美国账户最终状态',
  recoveryRequired: '需要OPEN-US-004恢复',
  resumeStage: 'Resume阶段',
  noSecondOpeningApplication: '未创建第二条开户申请',
  usAccountOverviewRoute: '美国账户总览页面',
  resumeMode: '执行模式',
  resumeStartStage: 'Resume起始阶段',
  documentsUploaded: '五份资料已上传',
  signatureFieldsCompleted: 'Documenso签名字段已完成',
  signatureValue: 'Sandbox签名值',
  signerFullNamePresent: '文档预填Full Name存在',
  fidereModuleName: 'Fidere业务模块名称',
  documensoDocumentTitlePresent: 'Documenso文档标题存在',
  fieldsRemaining: 'Documenso剩余必填字段',
  documensoCompleted: 'Documenso最终完成',
  clientSubmitted: 'Client开户申请已提交',
  clientApplicationReference: 'Client开户申请引用',
  clientApplicationReferenceSource: 'Client开户申请引用来源',
  adminApproved: 'Fidere Admin已批准',
  noRepeatedDocumentSigning: '未重复Documenso签署',
  documentContext: '第三方文档上下文',
  openingFeeCurrency: '开户费币种',
  openingFeeAmount: '开户费金额',
  openingFeePaymentAccount: '弹窗付款账户',
  openingFeeBalanceAccountType: '余额核对账户',
  feeBalanceBefore: '开户费扣除前余额',
  feeBalanceAfter: '开户费扣除后余额',
  observedFeeDebit: '实际开户费扣款',
  feeBalanceSufficient: '开户费余额充足',
  feeConfirmationButtonText: '开户费确认按钮',
  openingFeeDescription: '开户费说明',
  openFeeConfirmationCount: '打开开户费确认弹窗次数',
  feeConfirmationClickCount: '开户费确认点击次数',
  securityVerificationStatus: '安全密钥验证状态',
  applicationCreateCount: '开户申请创建次数',
  applicationCreatedAfterFee: '扣费后创建开户申请',
  nextClientState: '费用确认后的Client状态',
  productCount: '理财产品数量',
  selectedProduct: '目标理财产品',
  purchaseAccount: '购入账户',
  subscriptionOrderId: '理财认购订单编号',
  wealthProductId: '理财产品编号',
  wealthClientStatus: 'Client认购状态',
  wealthAdminStatus: 'Admin认购状态',
  wealthBalanceSnapshots: '认购前、提交后、审核后资金快照',
  wealthRejectionReason: '认购拒绝原因',
  wealthHoldingEvidence: '原有与拒绝后持仓证据',
  minimumInvestment: '最低投资金额',
  maximumInvestment: '最高投资金额',
  paymentAccount: '付款账户类型',
  paymentBalance: '付款账户可用余额',
  wealthHistoryCount: '理财历史记录数',
  positionRecordCount: '持仓记录数',
  redeemablePositionCount: '可赎回持仓数',
  readinessStatus: 'E2E Readiness状态',
  blockerReason: 'Readiness阻塞原因',
  trustNumber: '信托编号',
  beneficiaryName: '受益人姓名',
  beneficiaryRelationship: '与信托人关系',
  beneficiaryPercentage: '受益比例',
  beneficiaryIdSuffix: '证件尾号',
  beneficiaryStatus: 'Client受益人状态',
  bankAccountSuffix: '受益人银行账户尾号',
  bankName: '银行名称',
  bankCurrency: '银行账户币种',
  bankAccountStatus: '受益人银行账户状态',
  clientCreateCount: 'Client受益人创建次数',
  beneficiaryConfirmationClickCount: '打开受益人安全验证次数',
  securityDialogObserved: '是否出现安全密钥弹窗',
  bankAccountCreateCount: 'Client银行账户创建次数',
  bankAccountConfirmationClickCount: 'Client银行账户确认次数',
  bankSecurityVerificationClicks: '银行账户安全密钥验证次数',
  beneficiaryApproveCount: 'Admin受益人审核次数',
  bankAccountApproveCount: 'Admin银行账户审核次数',
  clientMutationResponseCount: 'Client受益人Mutation响应数',
  clientBeneficiaryRecordObserved: 'Client是否观察到受益人记录',
  adminBeneficiaryRecordObserved: 'Admin是否观察到受益人记录',
  adminBeneficiaryCount: 'Admin信托受益人数',
  noDuplicateBeneficiaryCreated: '是否未创建第二个受益人',
  bankApprovalIndependent: '银行账户是否独立审核',
  adminTransactionId: 'Admin处理编号',
  runId: '业务Run ID',
  amountPrecision: '金额精度',
  candidateCount: 'Admin候选数',
  candidateStageCounts: '候选逐层数量',
  fingerprintFields: 'Admin业务指纹字段',
  rejectReason: '自动化拒绝原因',
  claimRemark: '自动化认领备注',
  jurisdictionBalanceBefore: '操作前法域账户余额',
  jurisdictionBalanceAfter: '操作后法域账户余额',
  brokerBalanceOracle: '券商余额Oracle',
  terminalState: '申请终态',
  rejectActionAvailable: 'Admin拒绝入口可见',
  rejectReasonDisplayed: 'Client是否展示拒绝原因',
  noNewWithdrawalCreated: '是否未创建第二笔出金',
  dryRun: 'Dry Run',
  businessOrderId: '业务编号',
  businessId: '业务编号',
  businessIdSource: '业务编号来源',
  transactionId: '业务编号',
  transactionType: '交易类型',
  recordOccurredAt: '交易时间',
  sourceAmountEvidence: '转出金额证据',
  transactionStatus: '最终交易状态',
  finalStatus: '最终状态',
  confirmed: '是否确认成交',
  resultSignal: '页面结果信号',
  documentOpened: 'Documenso文档已打开',
  documentIframeLoaded: 'Documenso iframe已加载',
  documentFrameUrl: 'Documenso iframe安全URL',
  documentCreationEvidence: '新文档创建证据',
  documentCreated: 'Documenso文档已创建',
  documentBelongsToCurrentJourney: '文档属于本次Journey',
  noOldDocumentReused: '未复用旧Documenso草稿',
  staleDraftDetected: '检测到旧签署草稿',
  fieldsRemainingBefore: '签署前Fields Remaining',
  fieldsRemainingAfter: '签署后Fields Remaining',
  testSignatureDrawn: 'TEST Canvas签名已绘制',
  signatureFieldCompleted: 'TEST签名字段已完成',
  documensoFieldSignCount: '字段级Sign点击次数',
  completeClickCount: 'Documenso Complete点击次数',
  signConfirmClickCount: 'Documenso确认Sign点击次数',
  signClickCount: 'Documenso Sign点击次数',
  documensoFinalStatus: 'Documenso最终状态',
  fidereSigningStatusBefore: 'Fidere签署前状态',
  fidereSigningStatusAfter: 'Fidere签署后状态',
  submitEnabledBeforeSigning: '签署前最终提交按钮可用',
  submitEnabledAfterSigning: '签署后最终提交按钮可用',
  fidereStatusSyncObserved: '观察到Fidere签署状态同步',
  fidereAutomaticStatusRequestObserved: '观察到Fidere页面状态请求',
  signingDiagnosticConclusion: '签署链路诊断结论',
  registrationFailureCategory: '注册失败分类',
  registrationFinalStatus: '新用户最终状态',
  registrationTestName: 'Test Name',
  registrationSequence: '内部测试序号',
  registrationNameSuffix: '字母姓名后缀',
  registrationNameFieldAccepted: '姓名字段完整接受',
  recoverablePreSubmitDisposition: '提交前错误分类',
  recoverablePreSubmitCorrectionCount: '提交前修正次数',
  registrationTestNameUnique: '测试姓名唯一',
  registrationEmailAdminPreflight: 'Admin邮箱预检',
  registrationSignerImplementation: 'Signer Implementation',
  registrationSignerType: 'Signer Type',
  registrationDocumentCreated: 'Registration Agreement已创建',
  registrationDocumentOpened: 'Registration Agreement已打开',
  registrationIframeLoaded: 'Registration Agreement iframe已加载',
  registrationFrameUrl: 'Registration Agreement安全URL',
  registrationDocumentCreationEvidence: 'Registration Agreement创建证据',
  registrationDocumentBelongsToJourney: '协议属于本次Fresh User',
  registrationNoOldDocumentReused: '未复用旧签署文档',
  registrationInitialRemainingFields: 'Initial Remaining Fields',
  registrationSignatureFieldLocated: 'Signature Field Located',
  registrationSignatureValue: 'Signature',
  registrationNamePreserved: 'Name Preserved',
  registrationTitleStatus: 'Title Status',
  registrationDateStatus: 'Date Status',
  registrationTestSignatureDrawn: 'TEST Signature Drawn',
  registrationSignatureApplied: 'TEST Signature Applied',
  registrationSignatureMethod: 'Signature Method',
  registrationFieldSignClickCount: 'Signature Apply Count',
  registrationAgreementActionClickCount: 'Agreement Completion Action Count',
  registrationAgreementConfirmationClickCount: 'Agreement Confirmation Count',
  registrationFinalRemainingFields: 'Final Remaining Fields',
  registrationAuthorizationStepCompleted: 'Authorization Step Completed',
  registrationSigningCompleted: 'Registration Signing Completed',
  registrationSubmitEnabledBeforeSigning: 'Submit Enabled Before Signing',
  registrationFinalSubmitClickCount: 'Final Submit Click Count',
  registrationFinalSubmitEvidence: 'Fidere最终资料提交证据',
  registrationSigningStatus: 'Registration Signing Status',
  iframeLoaded: 'Documenso iframe已加载',
  submitGateWarning: '签署前提交门禁警告',
  finalRegistrationSubmitCount: '最终资料提交次数',
  credentialSource: 'Password Source',
  credentialConfigured: 'Password Configured',
  resumeLoginAttemptCount: 'Resume登录尝试次数',
  resumeCredentialAccepted: 'CLIENT_PASSWORD凭证被接受',
  resumeClientAuthenticated: 'Resume Client认证成功',
  journeySessionActive: '原Journey会话仍有效',
  unfinishedKycRestored: '恢复未完成KYC流程',
  documensoDraftAvailable: '原Documenso草稿可读取',
  resumeSigningReady: '原草稿可继续签署',
  documentCreationRequestsBlocked: 'Preflight拦截文档创建请求数',
  accountCreationStatus: '账号创建状态',
  kycSubmissionStatus: 'KYC提交状态',
  documensoCompletionStatus: 'Documenso完成状态',
  quoteValidity: '报价有效期'
};

function renderSteps(steps: BusinessStepRecord[]): string {
  if (steps.length === 0) {
    return '<p class="empty">未记录业务步骤。</p>';
  }

  return `<div class="table-wrap"><table>
    <thead><tr><th>序号</th><th>测试步骤</th><th>预期结果</th><th>实际结果</th><th>状态</th><th>耗时</th></tr></thead>
    <tbody>${steps
      .map(
        (step, index) => `<tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(step.action)}</td>
          <td>${escapeHtml(step.expected)}</td>
          <td>${escapeHtml(step.actual)}</td>
          <td><span class="status ${step.status}">${step.status === 'passed' ? '通过' : step.status === 'warning' ? '警告' : '失败'}</span></td>
          <td>${escapeHtml(formatDuration(step.durationMs))}</td>
        </tr>`
      )
      .join('')}</tbody>
  </table></div>`;
}

function renderOracleGroup(oracles: BusinessOracleRecord[], level: 'primary' | 'secondary'): string {
  const records = oracles.filter(oracle => oracle.level === level);
  const title = level === 'primary' ? '核心业务验证（Primary Oracle）' : '辅助验证（Secondary Oracle）';

  if (records.length === 0) {
    return `<h4>${title}</h4><p class="empty">未记录。</p>`;
  }

  return `<h4>${title}</h4><div class="table-wrap"><table class="oracle-table">
    <thead><tr><th>验证项</th><th>预期结果</th><th>实际结果</th><th>状态</th></tr></thead>
    <tbody>${records.map(oracle => `<tr>
      <td>${escapeHtml(oracle.name)}</td>
      <td>${escapeHtml(oracle.expected)}</td>
      <td>${escapeHtml(oracle.actual)}</td>
      <td><span class="status ${oracle.status === 'passed' ? 'passed' : level === 'secondary' ? 'warning' : 'failed'}">${oracle.status === 'passed' ? '✅ 通过' : level === 'secondary' ? '⚠ 异常' : '失败'}</span></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderOracles(oracles: BusinessOracleRecord[]): string {
  return `${renderOracleGroup(oracles, 'primary')}${renderOracleGroup(oracles, 'secondary')}`;
}

function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) {
    return '<p class="empty">无辅助异常。</p>';
  }

  return `<ul class="warnings">${warnings.map(warning => `<li>⚠ ${escapeHtml(warning)}</li>`).join('')}</ul>`;
}

function renderDiagnostics(diagnostics: BusinessDiagnosticInput[]): string {
  if (diagnostics.length === 0) {
    return '<p class="empty">无辅助诊断。</p>';
  }
  return `<div class="oracle-list">${diagnostics.map(diagnostic => `
    <article class="oracle-card">
      <header><strong>INFO / DIAGNOSTIC · ${escapeHtml(diagnostic.name)}</strong></header>
      <dl class="data-grid">
        <div><dt>状态</dt><dd>${escapeHtml(diagnostic.status)}</dd></div>
        <div><dt>诊断结果</dt><dd>${escapeHtml(diagnostic.summary)}</dd></div>
        <div><dt>原因</dt><dd>${escapeHtml(diagnostic.reason ?? '无')}</dd></div>
        <div><dt>影响核心业务</dt><dd>否</dd></div>
      </dl>
    </article>`).join('')}</div>`;
}

function businessConclusion(testCase: BusinessReportCase): string {
  if (testCase.businessOutcome === 'PASS_WITH_WARNING') {
    return '核心业务已确认成功，辅助验证存在异常。';
  }
  if (testCase.businessOutcome === 'PASS') return '业务验证通过。';
  if (testCase.businessOutcome === 'MANUAL_REVIEW') return '现有核心证据不足，需人工核查业务结果。';
  if (testCase.businessOutcome === 'FAIL') return '核心业务验证失败。';
  if (testCase.businessOutcome === 'BLOCKED') return '环境、数据或外部条件阻塞，本次业务未执行。';
  return '本次业务未执行。';
}

function renderBusinessData(data: Record<string, unknown>): string {
  const entries = Object.entries(data).filter(([key]) => key in businessDataLabels);

  if (entries.length === 0) {
    return '<p class="empty">未提供结构化业务数据。</p>';
  }

  const signingEntries = entries.filter(([key]) => key.startsWith('registration'));
  const generalEntries = entries.filter(([key]) => !key.startsWith('registration'));
  const renderEntries = (values: Array<[string, unknown]>) =>
    `<dl class="data-grid">${values
      .map(
        ([key, value]) => `<div><dt>${escapeHtml(businessDataLabels[key])}</dt><dd>${displayValue(value)}</dd></div>`
      )
      .join('')}</dl>`;

  return [
    generalEntries.length > 0 ? renderEntries(generalEntries) : '',
    signingEntries.length > 0
      ? `<h4>Personal Registration Signing</h4>${renderEntries(signingEntries)}`
      : ''
  ].join('');
}

function renderEvidenceItem(evidence: BusinessEvidence): string {
  const value = evidence.href
    ? `<a href="${escapeHtml(evidence.href)}">${escapeHtml(evidence.displayPath ?? evidence.label)}</a>`
    : '<span class="muted">未生成</span>';
  const warning = evidence.warning ? `<small>${escapeHtml(evidence.warning)}</small>` : '';

  return `<div><dt>${escapeHtml(evidence.label)}</dt><dd>${value}${warning}</dd></div>`;
}

function renderCaseDetail(testCase: BusinessReportCase, index: number): string {
  const failed = testCase.statusKey === 'failed' || testCase.statusKey === 'timedOut';
  const warned = testCase.statusKey === 'passedWithWarning';
  const review = testCase.review;

  return `<details class="case-detail" id="case-${index}">
    <summary>${escapeHtml(testCase.caseId)} · ${escapeHtml(testCase.name)} <span class="status ${escapeHtml(testCase.statusKey)}">${escapeHtml(testCase.displayStatus)}</span></summary>
    <section>
      <h3>一、用例基本信息</h3>
      <dl class="data-grid">
        <div><dt>用例编号</dt><dd>${escapeHtml(testCase.caseId)}</dd></div>
        <div><dt>Flow</dt><dd>${escapeHtml(testCase.flowId)}</dd></div>
        <div><dt>模块</dt><dd>${escapeHtml(testCase.module)}</dd></div>
        <div><dt>用例名称</dt><dd>${escapeHtml(testCase.name)}</dd></div>
        <div><dt>用例描述</dt><dd>${escapeHtml(testCase.description)}</dd></div>
        <div><dt>优先级</dt><dd>${escapeHtml(testCase.priority)}</dd></div>
        <div><dt>测试层级</dt><dd>${escapeHtml(testCase.level)}</dd></div>
        <div><dt>测试类型</dt><dd>${listText(testCase.type)}</dd></div>
        <div><dt>标签</dt><dd>${listText(testCase.tags)}</dd></div>
        <div><dt>自动化范围</dt><dd>${escapeHtml(testCase.scope)}</dd></div>
        <div><dt>Owner</dt><dd>${escapeHtml(testCase.owner)}</dd></div>
        <div><dt>Requirement</dt><dd>${escapeHtml(testCase.requirement)}</dd></div>
        <div><dt>前置条件</dt><dd>${listText(testCase.preconditions)}</dd></div>
        <div><dt>测试目标</dt><dd>${escapeHtml(testCase.target)}</dd></div>
        <div><dt>预期最终结果</dt><dd>${escapeHtml(testCase.expectedResult)}</dd></div>
        <div><dt>改变服务端数据</dt><dd>${yesNo(testCase.changesData)}</dd></div>
        <div><dt>影响资金</dt><dd>${yesNo(testCase.affectsMoney)}</dd></div>
        <div><dt>依赖Admin</dt><dd>${yesNo(testCase.dependsOnAdmin)}</dd></div>
        <div><dt>依赖第三方</dt><dd>${yesNo(testCase.dependsOnThirdParty)}</dd></div>
        <div><dt>安全开关</dt><dd>${listText(testCase.safetySwitches)}</dd></div>
        <div><dt>当前执行结果</dt><dd>${escapeHtml(testCase.displayStatus)} <small>${escapeHtml(testCase.rawStatus)}</small></dd></div>
        <div><dt>业务结果代码</dt><dd>${escapeHtml(testCase.businessOutcome)}</dd></div>
        <div><dt>执行时间</dt><dd>${escapeHtml(testCase.startedAt)}</dd></div>
        <div><dt>执行耗时</dt><dd>${escapeHtml(formatDuration(testCase.durationMs))}</dd></div>
      </dl>
    </section>
    <section><h3>二、测试数据与业务执行结果</h3>${renderBusinessData(testCase.businessData)}</section>
    <section><h3>三、Oracle分级验证</h3>${renderOracles(testCase.oracles)}</section>
    <section><h3>四、辅助诊断（非计分）</h3>${renderDiagnostics(testCase.diagnostics)}</section>
    <section><h3>五、测试步骤</h3>${renderSteps(testCase.steps)}</section>
    <section class="failure ${failed || review.manualReviewRequired ? '' : warned ? 'warning-panel' : 'quiet'}">
      <h3>六、业务结论、异常与运行风险</h3>
      <dl class="data-grid">
        <div><dt>最终结果</dt><dd>${escapeHtml(testCase.displayStatus)}</dd></div>
        <div><dt>业务结论</dt><dd>${escapeHtml(businessConclusion(testCase))}</dd></div>
        <div><dt>失败步骤</dt><dd>${escapeHtml(testCase.failedStep)}</dd></div>
        <div><dt>业务失败摘要</dt><dd>${escapeHtml(testCase.failureSummary)}</dd></div>
        <div><dt>预期结果</dt><dd>${escapeHtml(testCase.failureExpected)}</dd></div>
        <div><dt>实际结果</dt><dd>${escapeHtml(testCase.failureActual)}</dd></div>
        <div><dt>可能已经提交</dt><dd>${yesNo(review.potentiallySubmitted)}</dd></div>
        <div><dt>重复提交风险</dt><dd>${yesNo(review.duplicateSubmissionRisk)}</dd></div>
        <div><dt>需要人工核查</dt><dd>${yesNo(review.manualReviewRequired)}</dd></div>
        <div><dt>建议核查位置</dt><dd>${escapeHtml(review.reviewLocation ?? '未提供')}</dd></div>
        <div><dt>可以安全重跑</dt><dd>${yesNo(review.safeToRerun)}</dd></div>
      </dl>
      <h4>辅助检查异常</h4>${renderWarnings(testCase.warnings)}
      <details class="technical"><summary>技术错误详情</summary><pre>${escapeHtml(testCase.technicalError)}</pre></details>
    </section>
    <section><h3>七、测试证据</h3><dl class="data-grid evidence">${testCase.evidence.map(renderEvidenceItem).join('')}</dl></section>
  </details>`;
}

function options(values: string[]): string {
  return [...new Set(values)]
    .sort()
    .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join('');
}

export function renderBusinessReport(report: BusinessReportRun): string {
  const summary = report.summary;
  const rows = report.cases
    .map(
      (testCase, index) => `<tr class="case-row" data-index="${index}" data-module="${escapeHtml(testCase.module)}" data-priority="${escapeHtml(testCase.priority)}" data-type="${escapeHtml(testCase.type.join('|'))}" data-status="${escapeHtml(testCase.statusKey)}" data-tags="${escapeHtml(testCase.tags.join('|'))}" data-search="${escapeHtml(`${testCase.caseId} ${testCase.name}`.toLowerCase())}">
        <td><button class="link-button" data-target="case-${index}">${escapeHtml(testCase.caseId)}</button></td>
        <td>${escapeHtml(testCase.module)}</td><td>${escapeHtml(testCase.name)}</td><td>${escapeHtml(testCase.priority)}</td>
        <td>${listText(testCase.type)}</td><td>${escapeHtml(testCase.scope)}</td>
        <td><span class="status ${escapeHtml(testCase.statusKey)}">${escapeHtml(testCase.displayStatus)}</span></td>
        <td>${escapeHtml(testCase.failedStep)}</td><td>${escapeHtml(formatDuration(testCase.durationMs))}</td>
        <td>${yesNo(testCase.changesData)}</td><td>${yesNo(testCase.review.manualReviewRequired)}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.title)}</title>
<style>
:root{color-scheme:light;--bg:#f5f6f7;--surface:#fff;--text:#202124;--muted:#667085;--line:#d9dee5;--green:#16794b;--red:#b42318;--orange:#b54708;--yellow:#8a6100;--gray:#59636e;--blue:#175cd3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Arial,"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55;letter-spacing:0}.shell{max-width:1600px;margin:0 auto;padding:24px}header{margin-bottom:20px}h1{font-size:28px;margin:0 0 14px}h2{font-size:20px;margin:28px 0 12px}h3{font-size:16px;margin:0 0 12px}h4{font-size:14px;margin:14px 0 8px}.run-meta,.data-grid,.baseline-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden}.run-meta div,.data-grid div,.baseline-grid div{background:var(--surface);padding:10px 12px;min-width:0}.run-meta strong,.data-grid dt,.baseline-grid strong{display:block;color:var(--muted);font-size:12px;margin-bottom:3px}.baseline-grid span{display:block;font-size:20px;font-weight:700}.baseline-grid small{display:block;margin-top:5px}.baseline-banner{padding:11px 13px;border-radius:5px;margin-bottom:10px;font-weight:700}.baseline-banner.stable{color:var(--green);background:#e8f5ee}.baseline-banner.regression{color:var(--red);background:#fdecea}.baseline-banner.neutral{color:var(--blue);background:#eef4ff}.data-grid dd{margin:0;overflow-wrap:anywhere}.summary{display:grid;grid-template-columns:repeat(9,minmax(110px,1fr));gap:10px;margin:18px 0}.metric{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px}.metric b{display:block;font-size:23px}.metric span{color:var(--muted)}.filters{display:grid;grid-template-columns:2fr repeat(5,1fr);gap:8px;margin:12px 0}.filters input,.filters select{width:100%;height:38px;border:1px solid #b9c0ca;border-radius:5px;background:#fff;padding:0 10px;color:var(--text)}.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef1f4;color:#394150;font-size:12px}tr:last-child td{border-bottom:0}.status{display:inline-block;padding:2px 7px;border-radius:4px;font-weight:700;white-space:nowrap}.status.passed{color:var(--green);background:#e8f5ee}.status.passedWithWarning,.status.warning{color:var(--yellow);background:#fff8d8}.status.failed,.status.timedOut{color:var(--red);background:#fdecea}.status.skipped,.status.interrupted{color:var(--gray);background:#eceff2}.status.blocked{color:var(--orange);background:#fff1e7}.status.manualReview{color:var(--yellow);background:#fff8d8}.link-button{border:0;background:transparent;color:var(--blue);padding:0;cursor:pointer;text-decoration:underline;font:inherit}.case-detail{margin-top:12px;background:var(--surface);border:1px solid var(--line);border-radius:6px}.case-detail>summary{cursor:pointer;padding:13px 15px;font-weight:700}.case-detail section{padding:15px;border-top:1px solid var(--line)}.failure{border-left:4px solid var(--red)}.failure.warning-panel{border-left-color:var(--yellow)}.failure.quiet{border-left-color:var(--line)}.oracle-table{table-layout:auto}.warnings{margin:8px 0;padding-left:22px;color:var(--yellow)}.technical{margin-top:12px}.technical pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f8fa;border:1px solid var(--line);padding:10px}.evidence small{display:block;color:var(--orange);margin-top:3px}.muted,.empty,small{color:var(--muted)}a{color:var(--blue)}
@media(max-width:1100px){.run-meta,.data-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.summary{grid-template-columns:repeat(4,1fr)}.filters{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.shell{padding:12px}.run-meta,.data-grid,.summary,.filters{grid-template-columns:1fr}table{min-width:980px}}
@media print{body{background:#fff}.shell{max-width:none;padding:0}.filters,.link-button{display:none}.case-detail{break-inside:avoid}.case-detail[open] summary{display:block}}
</style></head><body><main class="shell">
<header><h1>${escapeHtml(report.title)}</h1><div class="run-meta">
<div><strong>执行环境</strong>${escapeHtml(report.environment)}</div><div><strong>Client域名</strong>${escapeHtml(report.hostname)}</div>
<div><strong>开始时间</strong>${escapeHtml(report.startedAt)}</div><div><strong>结束时间</strong>${escapeHtml(report.endedAt)}</div>
<div><strong>总耗时</strong>${escapeHtml(formatDuration(report.durationMs))}</div><div><strong>Run ID</strong>${escapeHtml(report.runId)}</div>
<div><strong>Flow</strong>${escapeHtml(`${report.flowId} · ${report.flowName}`)}</div>
<div><strong>执行命令</strong>${escapeHtml(report.command)}</div><div><strong>Project / 浏览器</strong>${listText([...report.projects,...report.browsers])}</div>
<div><strong>运行方式</strong>${escapeHtml(report.executionMode)}</div></div></header>
<section class="summary">
${[['用例总数',summary.total],['通过',summary.passed],['通过（有警告）',summary.passedWithWarning],['失败',summary.failed],['跳过',summary.skipped],['阻塞',summary.blocked],['超时/中断',summary.timedOut+summary.interrupted],['需人工核查',summary.manualReview],['业务通过率',`${summary.passRate.toFixed(1)}%`]].map(([label,value])=>`<div class="metric"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('')}
</section>
${renderBaselineComparison(report)}
<h2>用例结果</h2><div class="filters">
<input id="search" type="search" placeholder="搜索用例编号或名称">
<select id="module"><option value="">全部模块</option>${options(report.cases.map(item=>item.module))}</select>
<select id="priority"><option value="">全部优先级</option>${options(report.cases.map(item=>item.priority))}</select>
<select id="type"><option value="">全部类型</option>${options(report.cases.flatMap(item=>item.type))}</select>
<select id="status"><option value="">全部结果</option>${options(report.cases.map(item=>item.statusKey))}</select>
<select id="tag"><option value="">全部标签</option>${options(report.cases.flatMap(item=>item.tags))}</select></div>
<div class="table-wrap"><table><thead><tr><th>用例编号</th><th>模块</th><th>用例名称</th><th>优先级</th><th>测试类型</th><th>范围</th><th>结果</th><th>失败步骤</th><th>耗时</th><th>改变数据</th><th>人工核查</th></tr></thead><tbody>${rows}</tbody></table></div>
<div id="details">${report.cases.map(renderCaseDetail).join('')}</div>
</main><script>
const controls=['search','module','priority','type','status','tag'].map(id=>document.getElementById(id));
function applyFilters(){const [search,module,priority,type,status,tag]=controls.map(el=>el.value.toLowerCase());document.querySelectorAll('.case-row').forEach(row=>{const show=(!search||row.dataset.search.includes(search))&&(!module||row.dataset.module.toLowerCase()===module)&&(!priority||row.dataset.priority.toLowerCase()===priority)&&(!type||row.dataset.type.toLowerCase().split('|').includes(type))&&(!status||row.dataset.status.toLowerCase()===status)&&(!tag||row.dataset.tags.toLowerCase().split('|').includes(tag));row.hidden=!show;document.getElementById('case-'+row.dataset.index).hidden=!show;});}
controls.forEach(el=>el.addEventListener('input',applyFilters));document.querySelectorAll('.link-button').forEach(button=>button.addEventListener('click',()=>{const detail=document.getElementById(button.dataset.target);detail.open=true;detail.scrollIntoView({behavior:'smooth',block:'start'});}));
</script></body></html>`;
}
