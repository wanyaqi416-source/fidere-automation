import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FlowStateStore, advanceFlowState, createPreparedFlowState, matchCandidatesByStages, type FlowStage } from '../flow-engine';

export const DIGITAL_ADDRESS_FLOW = 'digital-address-approval';
export const DIGITAL_ASSETS = {
  BTC: { option: 'BTC - Bitcoin', asset: 'BTC', network: 'Bitcoin' },
  ETH: { option: 'ETH - Ethereum', asset: 'ETH', network: 'Ethereum' },
  USDT_ERC20: { option: 'USDT - Ethereum', asset: 'USDT', network: 'Ethereum' },
  USDT_TRC20: { option: 'USDT - Tron', asset: 'USDT', network: 'Tron' }
} as const;
export type DigitalAssetKey = keyof typeof DIGITAL_ASSETS;
export type DigitalAddressInput = { label: string; address: string; assetKey: DigitalAssetKey };
export type DigitalAddressCandidate = {
  id: string; customerText: string; address: string; asset: string;
  network: string; label: string; status: string; enabledState?: string; submittedAt: string;
};
export type DigitalAddressFingerprint = DigitalAddressInput & { email: string; userId: string; reference?: string };

export function validateDigitalAddressInput(input: DigitalAddressInput): void {
  if (!input.label.trim() || input.label.length > 50) throw new Error('Address label must contain 1-50 characters.');
  if (!input.address.trim() || input.address.length > 200 || /\s/.test(input.address)) throw new Error('Wallet address must contain 1-200 non-whitespace characters.');
  if (!(input.assetKey in DIGITAL_ASSETS)) throw new Error('Unsupported digital address asset/network.');
}

export function maskWalletAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}****${address.slice(-4)}` : '****';
}

export function matchDigitalAddresses<T extends DigitalAddressCandidate>(rows: T[], fingerprint: DigitalAddressFingerprint, status?: string, matchLabel = true) {
  const asset = DIGITAL_ASSETS[fingerprint.assetKey];
  return matchCandidatesByStages(rows, [
    { id: 'customer', label: '列表用户（详情再次核对ID）', matches: row => {
      const emails: string[] = row.customerText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      const id = row.customerText.match(/(?:用户\s*ID|\bID)\s*[:：#]?\s*(\d+)/i)?.[1];
      if (emails.length && !emails.some(email => email.toLowerCase() === fingerprint.email.toLowerCase())) return false;
      if (id && fingerprint.userId && id !== fingerprint.userId) return false;
      // Some rows expose only a display name; the detail's userId remains mandatory before approval.
      return true;
    } },
    { id: 'address', label: '完整钱包地址', matches: row => row.address === fingerprint.address },
    { id: 'asset', label: '币种', matches: row => row.asset === asset.asset },
    { id: 'network', label: '网络', matches: row => row.network === asset.network },
    { id: 'label', label: '本次地址名称', matches: row => !matchLabel || row.label === fingerprint.label },
    { id: 'reference', label: '原白名单ID', matches: row => !fingerprint.reference || row.id === fingerprint.reference },
    { id: 'status', label: '审核状态', matches: row => !status || row.status === status }
  ]);
}

export function decodeDigitalAddressReceipt(body: unknown): { accepted: boolean; reference?: string } {
  if (!body || typeof body !== 'object') return { accepted: false };
  const value = body as Record<string, unknown>;
  const accepted = [0, 200, '0', '200'].includes(value.code as string | number) && value.success !== false && value.data !== false;
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {};
  const id = data.id ?? data.whitelistId;
  return { accepted, reference: accepted && /^\d+$/.test(String(id)) ? String(id) : undefined };
}

// Bind Resume to the same Journey and address without persisting identity or wallet data.
export class DigitalAddressRun {
  private readonly store: FlowStateStore;
  constructor(readonly runId: string, identity: DigitalAddressFingerprint & { sourceRunId: string }, root?: string) {
    this.store = new FlowStateStore(root);
    const path = this.store.pathFor(DIGITAL_ADDRESS_FLOW, runId);
    mkdirSync(dirname(path), { recursive: true });
    const binding = createHash('sha256').update(JSON.stringify([identity.sourceRunId, identity.email.toLowerCase(), identity.userId, identity.assetKey, identity.address, identity.label])).digest('hex');
    const bindingPath = `${path}.binding`;
    if (existsSync(bindingPath)) {
      if (readFileSync(bindingPath, 'utf8') !== binding) throw new Error('Digital address Resume identity mismatch.');
    } else {
      writeFileSync(bindingPath, binding, { flag: 'wx' });
    }
    if (!this.store.load(DIGITAL_ADDRESS_FLOW, runId)) this.store.save(createPreparedFlowState({ flowId: DIGITAL_ADDRESS_FLOW, runId, currency: identity.assetKey }));
  }
  state() { return this.store.load(DIGITAL_ADDRESS_FLOW, this.runId)!; }
  advance(stage: FlowStage, updates: Parameters<typeof advanceFlowState>[2] = {}) {
    const current = this.state();
    const next = advanceFlowState(current, stage, updates);
    this.store.save(next);
    return next;
  }
  attempted(action: 'client' | 'security' | 'admin'): boolean {
    return existsSync(`${this.store.pathFor(DIGITAL_ADDRESS_FLOW, this.runId)}.${action}.attempt`);
  }
  attempt(action: 'client' | 'security' | 'admin'): void {
    if (this.state().stage === 'COMPLETED') throw new Error('Completed digital address Run cannot be repeated.');
    writeFileSync(`${this.store.pathFor(DIGITAL_ADDRESS_FLOW, this.runId)}.${action}.attempt`, JSON.stringify({ runId: this.runId, attemptedAt: new Date().toISOString() }), { flag: 'wx' });
  }
}
