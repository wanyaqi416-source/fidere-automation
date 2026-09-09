import { Decimal } from '../utils/money';
import { createHash } from 'node:crypto';

export const WEBULL_BROKER_NAME = 'Webull 微牛证券';
export const WEBULL_DOCUMENTS = [
  { id: 'w8ben', label: 'W-8BEN 表格' },
  { id: 'crs-controller', label: 'CRS 控制人表格' }
] as const;

export type WebullDocumentId = (typeof WEBULL_DOCUMENTS)[number]['id'];

// Only expose a completion flag and digested reference; init-sign can contain bearer URLs.
export function readWebullSigningResult(body: unknown) {
  let value = body;
  for (let depth = 0; depth < 8; depth++) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break;
    const record = value as Record<string, unknown>;
    if ('data' in record) { value = record.data; continue; }
    const documentId = record.documentId;
    return { signed: record.signed === true,
      documentReference: typeof documentId === 'string' || typeof documentId === 'number'
        ? createHash('sha256').update(String(documentId)).digest('hex') : undefined };
  }
  return { signed: false, documentReference: undefined };
}

export function getWebullSignerIdentity(configuration = {
  signatureText: process.env.OPENING_SIGNATURE_TEXT,
  initials: process.env.OPENING_INITIALS
}): { signatureText: string; initials: string } {
  if (configuration.signatureText !== 'TEST' || configuration.initials !== 'T') {
    throw new Error('Webull requires configured Sandbox TEST signature and T initials before opening a document.');
  }
  return { signatureText: configuration.signatureText, initials: configuration.initials };
}

export type WebullDocumentEvidence = {
  id: WebullDocumentId;
  // Use a non-secret provider reference or a digest, never the signing URL/token.
  documentReference: string;
  remainingFields: number;
  signatureCompleted: boolean;
  completeClicks: number;
  signClicks: number;
  providerCompleted: boolean;
  fidereCompleted: boolean;
};

export const WEBULL_OPENING_STEPS = [
  { action: '复用原Journey用户，预检Client与Admin认证', expected: '原用户KYC已通过，微牛未开户，没有重复申请。' },
  { action: '进入券商并读取微牛开户费用、付款账户和可用余额', expected: '金额使用Decimal；余额不足时先完成独立授权的入金及到账验证。' },
  { action: '签署W-8BEN表格并等待Fidere识别完成', expected: '使用TEST签名；记录独立文档引用、字段数、Complete和Sign次数及回写状态。' },
  { action: '签署CRS控制人表格并等待Fidere识别完成', expected: '第二份独立文档也完成；不能拿W-8BEN的结果代替CRS。' },
  { action: '核对双文档及开户确认页', expected: '两份文档均为0个剩余字段、第三方已完成且Fidere已确认，费用与当前页面一致。' },
  { action: '确认开户并执行一次安全密钥验证', expected: '复用SecurityKeyDialog，从CLIENT_SECURITY_KEY读取；真实申请证据出现前不判成功。' },
  { action: '保存原申请并唯一定位Admin微牛开户案件', expected: '邮箱、用户、微牛、账户类型、提交窗口和原申请引用匹配，candidateCount=1。' },
  { action: 'Admin详情二次核对并通过一次', expected: '复用券商审批表单，按真实必填项完成；已执行最终审批不得重复。' },
  { action: 'Client读取原微牛账户最终状态', expected: '原账户已开通，记录费用及冻结/扣费变化，不创建第二条申请。' }
] as const;

export function assessWebullFunding(input: { available: string; fee: string; currency: string }) {
  if (input.currency !== 'USD') throw new Error('Webull payment currency needs confirmation against the actual account.');
  const available = new Decimal(input.available);
  const fee = new Decimal(input.fee);
  if (!available.isFinite() || !fee.isFinite() || available.isNegative() || fee.lte(0)) {
    throw new Error('Webull requires a non-negative available balance and a positive observed fee.');
  }
  const shortfall = Decimal.max(fee.minus(available), 0);
  return { status: shortfall.isZero() ? 'BALANCE_READY' as const : 'FUNDING_REQUIRED' as const,
    shortfall: shortfall.toFixed(), currency: input.currency };
}

function isCompleted(evidence: WebullDocumentEvidence): boolean {
  return Boolean(evidence.documentReference.trim()) && evidence.remainingFields === 0 && evidence.signatureCompleted
    && evidence.completeClicks === 1 && evidence.signClicks === 1 && evidence.providerCompleted && evidence.fidereCompleted;
}

function validateDocumentEvidence(documents: readonly WebullDocumentEvidence[]): void {
  const ids = new Set<string>();
  const references = new Set<string>();
  for (const document of documents) {
    if (!WEBULL_DOCUMENTS.some(expected => expected.id === document.id) || ids.has(document.id)) {
      throw new Error('Webull requires separate, uniquely identified W-8BEN and CRS document evidence.');
    }
    ids.add(document.id);
    const reference = document.documentReference.trim();
    if (reference && references.has(reference)) throw new Error('The two Webull documents cannot share one document reference.');
    if (reference) references.add(reference);
    if (!Number.isInteger(document.remainingFields) || document.remainingFields < 0
      || ![0, 1].includes(document.completeClicks) || ![0, 1].includes(document.signClicks)) {
      throw new Error('Invalid Webull field count or repeated signing action.');
    }
    if (document.signClicks > document.completeClicks) throw new Error('A Sign confirmation requires the preceding Complete action.');
  }
}

export function assertWebullDocumentsReady(documents: readonly WebullDocumentEvidence[]): void {
  validateDocumentEvidence(documents);
  if (documents.length !== WEBULL_DOCUMENTS.length || !documents.every(isCompleted)) {
    throw new Error('Both Webull documents must be independently signed and recognized by Fidere before fee submission.');
  }
}

export function nextWebullSigningStep(documents: readonly WebullDocumentEvidence[]): {
  documentId?: WebullDocumentId;
  action: 'OPEN_DOCUMENT' | 'FILL_FIELDS' | 'COMPLETE' | 'CONFIRM_SIGN' | 'READONLY_RECONCILIATION' | 'DOCUMENTS_READY';
} {
  validateDocumentEvidence(documents);
  // An uncertain final signing attempt takes precedence over opening the other document.
  const uncertain = documents.find(document => document.signClicks === 1 && !isCompleted(document));
  if (uncertain) return { documentId: uncertain.id, action: 'READONLY_RECONCILIATION' };
  for (const definition of WEBULL_DOCUMENTS) {
    const document = documents.find(item => item.id === definition.id);
    if (!document) return { documentId: definition.id, action: 'OPEN_DOCUMENT' };
    if (isCompleted(document)) continue;
    if (document.completeClicks === 1) return { documentId: definition.id,
      action: document.signatureCompleted && document.remainingFields === 0 ? 'CONFIRM_SIGN' : 'READONLY_RECONCILIATION' };
    return { documentId: definition.id, action: document.signatureCompleted && document.remainingFields === 0 ? 'COMPLETE' : 'FILL_FIELDS' };
  }
  assertWebullDocumentsReady(documents);
  return { action: 'DOCUMENTS_READY' };
}
