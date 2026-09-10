import { test, expect } from '../../fixtures/reporting.fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import type { AdminTransferDetail } from '../../pages/admin/TransferDetailPage';
import { AccountInternalTransferPage } from '../../pages/client/AccountInternalTransferPage';
import { fixedUsdFee, parseUsdDisplay, verifyFixedTransferQuote, withUsdTransferFee, sameAccountTypeConfiguration,
  matchFeeRunTransfers, verifyCompletedAccountTransfer, type AccountTypeFeeSnapshot } from '../../src/transfer/account-transfer-fee';
import { AccountTransferFeeRun, type FeeRunEvidence, type InternalTransferRecord } from '../../src/transfer/account-transfer-fee-run';
import { FLOW_REGISTRY } from '../../config/flow-registry';
import { sanitizeBusinessData } from '../../src/reporting/sensitive-data-mask';

const configuration: AccountTypeFeeSnapshot = { accountType: '巴林账户', code: 'BH', fields: { openingFee: '100', status: '启用' },
  currencies: { USD: { enabled: true, fee: '40.00' }, HKD: { enabled: true, fee: '200.00' } } };
const record: InternalTransferRecord = { orderNo: 'TRF-UNIT1', txNo: 'TXN-UNIT1', transferType: 'internal', fromRegion: 'BH', toRegion: 'HK',
  currency: 'USD', amount: '11.13', fee: '0.37', actualAmount: '11.13', status: 'approved', remark: 'AUTO_TRANSFER_FEE_UNIT', appliedAt: Date.parse('2026-09-10T03:00:00Z') };
const quote = { sourceAccount: '巴林账户', targetAccount: '香港账户', currency: 'USD', amount: '11.13', fee: '0.37', received: '10.76' };
const detail: AdminTransferDetail = { adminTransactionId: record.txNo, recordType: '信托账户互转', userIdentity: 'UNIT TEST',
  sourceAccountType: '巴林账户', targetAccountType: '香港账户', currency: 'USD', amount: '11.13', fee: '0.37', receivedAmount: '10.76', status: '已批准' };
const evidence: FeeRunEvidence = { identityHash: 'unit', fixedFee: '0.37', amount: '11.13', targetAccount: '香港账户', stage: 'CLIENT_CREATED',
  applied: true, restored: false, submittedAt: '2026-09-10T03:00:00Z', originalOrderIds: [], order: record, quotes: [quote] };

test('Completed transfer uses labelled Admin net against the saved Client preview, not raw API actualAmount', () => {
  expect(verifyCompletedAccountTransfer(record, evidence, detail, true)).toMatchObject({
    orderNo: record.orderNo, txNo: record.txNo, received: '10.76', fee: '0.37', receivedSource: 'Admin 实际到账金额' });
  expect(verifyCompletedAccountTransfer({ ...record, actualAmount: '999' }, evidence, detail, true).received).toBe('10.76');
  expect(() => verifyCompletedAccountTransfer(record, evidence, detail, false)).toThrow();
  expect(() => verifyCompletedAccountTransfer(record, { ...evidence, quotes: undefined }, detail, true)).toThrow();
  expect(() => verifyCompletedAccountTransfer(record, { ...evidence, quotes: [{ ...quote, received: '11.13' }] }, detail, true)).toThrow();
  for (const wrong of [{ adminTransactionId: 'TXN-OTHER' }, { recordType: '信托转券商' }, { sourceAccountType: '香港账户' },
    { targetAccountType: '新加坡账户' }, { currency: 'HKD' }, { amount: '11.14' }, { fee: '0.38' },
    { receivedAmount: '11.13' }, { receivedAmount: undefined }, { fee: undefined }, { status: '待审核' }]) {
    expect(() => verifyCompletedAccountTransfer(record, evidence, { ...detail, ...wrong }, true)).toThrow();
  }
  expect(() => verifyCompletedAccountTransfer({ ...record, actualAmount: '10.76' }, evidence, { ...detail, receivedAmount: '11.13' }, true)).toThrow();
  for (const wrong of [{ orderNo: 'TRF-OTHER' }, { txNo: '' }, { status: 'pending' }, { fee: '0.38' }, { amount: '11.14' },
    { transferType: 'p2p' }, { fromRegion: 'HK' }, { toRegion: 'SG' }, { currency: 'HKD' }]) {
    expect(() => verifyCompletedAccountTransfer({ ...record, ...wrong }, evidence, detail, true)).toThrow();
  }
});

test('Fixed USD fee supports zero/two decimals and rejects percentage, negative, malformed and excess precision', () => {
  expect(fixedUsdFee('0')).toEqual({ type: 'fixed', currency: 'USD', amount: '0.00' });
  expect(fixedUsdFee('0.37').amount).toBe('0.37');
  for (const value of ['-1', '0.001', 'NaN', '1e3', '1%', '', 'Infinity']) expect(() => fixedUsdFee(value)).toThrow();
  expect(() => fixedUsdFee('1', 'percentage')).toThrow(/UNSUPPORTED_FEE_TYPE/);
  expect(parseUsdDisplay('USD 1,001.30')).toBe('1001.30');
  for (const value of ['-', 'USDT 1', 'USD 1%', 'USD -1', '1.00']) expect(() => parseUsdDisplay(value)).toThrow();
});

test('Fixed transfer fee does not scale with amount; net amount uses exact Decimal and accounts stay distinct', () => {
  const quote = { sourceAccount: '巴林账户', targetAccount: '香港账户', currency: 'USD', amount: '11.13', fee: '0.37', received: '10.76' };
  const expected = { sourceAccount: quote.sourceAccount, targetAccount: quote.targetAccount, amount: quote.amount };
  expect(() => verifyFixedTransferQuote(quote, fixedUsdFee('0.37'), expected)).not.toThrow();
  expect(() => verifyFixedTransferQuote({ ...quote, amount: '11.30', received: '10.93' }, fixedUsdFee('0.37'), { ...expected, amount: '11.30' })).not.toThrow();
  expect(() => verifyFixedTransferQuote({ ...quote, fee: '0', received: '11.13' }, fixedUsdFee('0'), expected)).not.toThrow();
  for (const wrong of [{ fee: '0.38' }, { received: '11.50' }, { amount: '11.14' }, { sourceAccount: '香港账户' }, { currency: 'USDT' }]) {
    expect(() => verifyFixedTransferQuote({ ...quote, ...wrong }, fixedUsdFee('0.37'), expected)).toThrow();
  }
  expect(() => verifyFixedTransferQuote(quote, fixedUsdFee('12'), expected)).toThrow(/exceed/);
});

test('Bahrain USD edit preserves every other field; restore detects concurrent edits, including another currency', () => {
  const changed = withUsdTransferFee(configuration, '0.37');
  expect(configuration.currencies.USD.fee).toBe('40.00');
  expect(changed.currencies.HKD.fee).toBe('200.00');
  expect(sameAccountTypeConfiguration(withUsdTransferFee(changed, '40'), configuration)).toBe(true);
  expect(sameAccountTypeConfiguration({ ...changed, fields: { openingFee: '500', status: '启用' } }, changed)).toBe(false);
  expect(sameAccountTypeConfiguration({ ...changed, currencies: { ...changed.currencies, HKD: { enabled: true, fee: '10' } } }, changed)).toBe(false);
  expect(() => withUsdTransferFee({ ...configuration, code: 'HK' }, '1')).toThrow();
  expect(() => withUsdTransferFee({ ...configuration, currencies: { USD: { enabled: false, fee: '0' } } }, '1')).toThrow();
});

test('Original transfer matcher excludes p2p, old orders, wrong directions/amounts/times and retains duplicate candidates even after pinning', () => {
  expect(matchFeeRunTransfers([record], evidence, 'UNIT')).toHaveLength(1);
  for (const wrong of [{ transferType: 'p2p' }, { fromRegion: 'HK' }, { toRegion: 'SG' }, { currency: 'HKD' },
    { amount: '11.14' }, { remark: 'OTHER' }, { appliedAt: record.appliedAt + 600_000 }]) {
    expect(matchFeeRunTransfers([{ ...record, ...wrong }], evidence, 'UNIT')).toHaveLength(0);
  }
  expect(matchFeeRunTransfers([record], { ...evidence, originalOrderIds: [record.orderNo] }, 'UNIT')).toHaveLength(0);
  expect(matchFeeRunTransfers([record, { ...record, orderNo: 'TRF-UNIT2' }], evidence, 'UNIT')).toHaveLength(2);
});

test('Fee Run persists each attempt, pins identity/fee/amount and never repeats change, transfer or restore on Resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'account-fee-unit-'));
  try {
    const options = { runId: 'UNIT', email: 'unit@example.test', fixedFee: '0.37', amount: '11.13', targetAccount: '香港账户' };
    const run = new AccountTransferFeeRun(options, false, root);
    expect(() => run.attempt('apply')).toThrow();
    run.evidence.original = configuration; run.evidence.originalOrderIds = []; run.save();
    const stale = new AccountTransferFeeRun(options, true, root);
    run.attempt('apply'); expect(() => stale.attempt('apply')).toThrow(/EEXIST/);
    expect(() => new AccountTransferFeeRun({ ...options, runId: 'REPLACEMENT' }, false, root)).toThrow(/earlier shared fee/);
    expect(() => new AccountTransferFeeRun({ ...options, fixedFee: '1' }, true, root)).toThrow(/preserve/);
    expect(() => new AccountTransferFeeRun({ ...options, email: 'other@example.test' }, true, root)).toThrow(/preserve/);
    expect(() => run.attempt('confirm')).toThrow(); run.evidence.applied = true; run.save();
    run.attempt('confirm'); run.attempt('security'); run.created(record);
    expect(() => run.created({ ...record, orderNo: 'TRF-OTHER' })).toThrow(/replace/);
    run.attempt('restore');
    const resumed = new AccountTransferFeeRun(options, true, root);
    for (const phase of ['apply', 'confirm', 'security', 'restore'] as const) expect(() => resumed.attempt(phase)).toThrow();
    expect(() => resumed.complete()).toThrow(); resumed.evidence.restored = true;
    expect(() => resumed.complete()).toThrow();
    resumed.evidence.quotes = [quote];
    resumed.evidence.settlement = verifyCompletedAccountTransfer(record, resumed.evidence, detail, true);
    resumed.complete();
    expect(() => new AccountTransferFeeRun(options, true, root)).toThrow(/completed/);
  } finally {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('account-fee-unit-')) throw new Error('Unsafe temporary cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});

test('Real MUI-style currency rows remain label scoped when reordered; save callbacks enforce distinct apply/restore actions', async ({ page }) => {
  const placeholders = ['例如：香港账户','例如：Hong Kong Account','例如：香港帳戶','例如：HK_ACCOUNT','例如：HK','例如：hk_bank','例如：offshore'];
  const values = ['巴林账户','Bahrain Account','巴林账户','BH','BH','EU_BLANK','offshore'];
  const rows = Object.entries({ EUR:'欧元', USD:'美元', HKD:'港币', SGD:'新币', CNY:'人民币', JPY:'日元', AED:'阿联酋迪拉姆', GBP:'英镑' });
  await page.setContent(`<dialog open aria-label="编辑账户类型">${placeholders.map((p,i)=>`<input placeholder="${p}" value="${values[i]}">`).join('')}
    <label for="sort">展示排序 *</label><input id="sort" type="number" value="4"><label for="openingFee">开户费金额</label><input id="openingFee" value="100">
    ${['状态','开户是否需要资料','开户费币种'].map((label,i)=>`<div><label>${label}</label><div role="combobox">${['启用','否','USD 美元'][i]}</div></div>`).join('')}
    ${rows.map(([code,name])=>`<div><div><p>${code}</p><p>${name}</p></div><input type="checkbox" checked><div><label>手续费类型</label><div role="combobox">固定手续费</div><input type="number" min="0" step="0.01" value="${code==='USD'?'40':'0'}"><p>${code}</p></div></div>`).join('')}
    <button onclick="window.saves=(window.saves||0)+1;document.querySelector('dialog').close()">保存配置</button><button>取消</button></dialog>`);
  const admin = new AccountTypeConfigurationPage(page), original = await admin.readFeeConfiguration();
  await admin.fillUsdTransferFee('0.37', original);
  const expected = withUsdTransferFee(original, '0.37');
  await expect(admin.saveFeeOnce('apply', expected, () => { throw new Error('authorization closed'); })).rejects.toThrow(/authorization/);
  expect(await page.evaluate(() => (window as unknown as { saves?: number }).saves ?? 0)).toBe(0);
  await admin.saveFeeOnce('apply', expected, () => {});
  await expect(admin.saveFeeOnce('apply', expected, () => {})).rejects.toThrow(/already attempted/);
  expect(await page.evaluate(() => (window as unknown as { saves: number }).saves)).toBe(1);
});

test('Client uses separately nested visible account labels and the real h6 net amount without submitting', async ({ page }) => {
  await page.setContent(`<main>
    ${[['转出账户','巴林账户'],['转入账户','香港账户'],['币种','USD']].map(([label,value]) =>
      `<section><div><p>${label}</p></div><div><div role="combobox">${value}</div></div></section>`).join('')}
    <div><p>转账金额</p><p>USD 80.13</p></div><div><p>手续费</p><p>USD 40.00</p></div>
    <div><p>预估到账金额</p><h6>USD 40.13</h6></div><button>提交审核</button></main>`);
  const client = new AccountInternalTransferPage(page);
  await client.selectAccounts('巴林账户','香港账户');
  expect(await client.readQuote()).toEqual({ sourceAccount: '巴林账户', targetAccount: '香港账户',
    currency: 'USD', amount: '80.13', fee: '40.00', received: '40.13' });
  await client.expectNoSubmission();
});

for (const duplicate of [false, true]) test(`Read-only transfer history scans all pages and rejects duplicate pages: ${duplicate}`, async ({ page }) => {
  // Serve all pages locally so pagination never depends on Sandbox data or connectivity.
  const server = createServer((request, response) => {
    if (request.url === '/api/transfer/records') {
      if (request.headers.authorization !== 'Bearer UNIT_ONLY') { response.statusCode = 401; response.end(); return; }
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const { currentPage } = JSON.parse(body);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ code: 0, data: { total: 2, list: [{ ...record, orderNo: currentPage === 1 || duplicate ? 'TRF-UNIT1' : 'TRF-UNIT2' }] } }));
      });
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>fetch('/api/transfer/records',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer UNIT_ONLY'},body:JSON.stringify({currentPage:1,pageSize:1})})</script>`);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new AccountInternalTransferPage(page);
    const sourceUrl = page.url();
    if (duplicate) await expect(client.readRecords(origin)).rejects.toThrow(/duplicated/);
    else expect(await client.readRecords(origin)).toHaveLength(2);
    expect(page.url(), 'Read-only history must not navigate the original submission page').toBe(sourceUrl);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('Fee tests stay independent, excluded from default regression, and reports retain masked configuration evidence', () => {
  const real = FLOW_REGISTRY.find(flow => flow.id === 'account-transfer-fee')!;
  expect(real).toMatchObject({ defaultRegression: false, requiresSecurityKey: true, requiresAdmin: true, realE2EVerified: true, status: 'Ready' });
  expect(real.safetySwitches).toEqual(['ALLOW_ADMIN_MUTATION_TESTS','ALLOW_MONEY_TESTS']);
  expect(FLOW_REGISTRY.find(flow => flow.id === 'account-transfer-fee-reconciliation')).toMatchObject({
    level: 'L2', changesData: false, affectsMoney: false, defaultRegression: false, safetySwitches: [] });
  expect(FLOW_REGISTRY.find(flow => flow.id === 'transfer-jurisdiction-to-broker')?.status).toBe('Ready');
  const data = sanitizeBusinessData({ originalTransferFee: '40.00', configuredTransferFee: '0.37', transferFeeType: '固定金额',
    configurationSaveClicks: 1, configurationRestoreClicks: 1, configurationRestored: true,
    accountTransferFeeEvidence: JSON.stringify({ order: record, email: 'unit@example.test' }) });
  expect(data).toMatchObject({ originalTransferFee: '40.00', configurationRestored: true });
  expect(JSON.stringify(data)).not.toContain('TRF-UNIT1'); expect(JSON.stringify(data)).not.toContain('unit@example.test');
});
