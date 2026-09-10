import { test, expect } from '../../fixtures/reporting.fixture';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fundedUsdMatrix, TRANSFER_FEE_MATRIX, describeTransferFeeMatrixRow } from '../../src/transfer/transfer-fee-matrix';
import { TransferFeeMatrixRun, matchMatrixOrders } from '../../src/transfer/transfer-fee-matrix-run';
import { calculateExactTransferFee, parseTransferCurrencyDisplay, snapshotFeeRule, transferFeeRule,
  withTransferFeeRule, sameAccountTypeConfiguration, type AccountTypeFeeSnapshot } from '../../src/transfer/account-transfer-fee';
import { FLOW_REGISTRY } from '../../config/flow-registry';
import type { InternalTransferRecord } from '../../src/transfer/account-transfer-fee-run';
import { TransferListPage } from '../../pages/admin/TransferListPage';

const original: AccountTypeFeeSnapshot = { accountType: '巴林账户', code: 'BH', fields: { openingFee: '100' }, currencies: {
  USD: { enabled: true, fee: '5.00', feeType: 'percent' }, HKD: { enabled: true, fee: '200.00', feeType: 'fixed' } } };
const plan = fundedUsdMatrix()[0];

test('Six independent small plans cover both kinds and three exact fee modes', () => {
  const plans = fundedUsdMatrix();
  expect(plans).toHaveLength(6);
  expect(new Set(plans.map(p => p.amount)).size).toBe(6);
  expect(plans.map(p => p.fee)).toEqual(['0.37','0.37','1.01','1.02','0.00','0.00']);
  expect(plans.map(p => p.expectedCredit)).toEqual(['10.83','11.03','19.19','19.38','11.60','11.80']);
  for (const p of plans) expect(calculateExactTransferFee(transferFeeRule(p.currency,p.feeType,p.feeValue),p.amount)).toBe(p.fee);
  expect(() => describeTransferFeeMatrixRow(TRANSFER_FEE_MATRIX[0], '200.66')).toThrow(/BLOCKED_TEST_DATA/);
  for (const p of plans) expect(FLOW_REGISTRY.find(f => f.id === `transfer-fee-matrix-${p.feeType}-${p.kind}`)).toMatchObject({
    level: 'L4', defaultRegression: false, affectsMoney: true, requiresSecurityKey: true,
    npmScript: `test:transfer-fee-matrix:${p.feeType}:${p.kind}` });
});

test('Generic currency configuration changes preserve all other data and restore the original mode', () => {
  const changed = withTransferFeeRule(original, transferFeeRule('HKD','none','0'));
  expect(snapshotFeeRule(changed,'USD')).toEqual(snapshotFeeRule(original,'USD'));
  expect(sameAccountTypeConfiguration(withTransferFeeRule(changed,snapshotFeeRule(original,'HKD')),original)).toBe(true);
  expect(parseTransferCurrencyDisplay('HKD 1,200.00','HKD')).toBe('1200.00');
  expect(() => parseTransferCurrencyDisplay('USD 1,200.00','HKD')).toThrow();
});

test('Attempts survive failure and block replacement, repeat submission, repeat approval and original-order replacement', () => {
  const parent = resolve('.tmp/fee-matrix-unit'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, 'run-'));
  try {
    const run = new TransferFeeMatrixRun('UNIT', plan, 'sender@example.test', 'recipient@example.test', root);
    expect(() => run.attempt('confirm')).toThrow();
    expect(() => new TransferFeeMatrixRun('UNIT',plan,'sender@example.test','recipient@example.test',root)).toThrow(/Existing/);
    expect(() => new TransferFeeMatrixRun('REPLACEMENT',plan,'sender@example.test','recipient@example.test',root)).toThrow(/Incomplete/);
    run.evidence.original = original; run.evidence.baselineIds = ['TRF-OLD'];
    run.attempt('apply'); expect(() => run.attempt('apply')).toThrow();
    run.evidence.applied = true;
    run.evidence.quote = { sourceAccount:'巴林账户', targetAccount:'香港账户', currency:'USD', amount:plan.amount, fee:plan.fee, received:plan.expectedCredit };
    run.attempt('confirm'); run.attempt('security');
    expect(() => run.attempt('confirm')).toThrow(); expect(() => run.attempt('security')).toThrow(); expect(() => run.attempt('restore')).toThrow();
    const record: InternalTransferRecord = { orderNo:'TRF-UNIT',txNo:'TXN-UNIT',transferType:'internal',fromRegion:'BH',toRegion:'HK',
      currency:'USD',amount:plan.amount,fee:plan.fee,actualAmount:plan.amount,status:'approved',remark:'AUTO_TRANSFER_FEE_UNIT',appliedAt:Date.parse(run.evidence.submittedAt!) };
    expect(matchMatrixOrders([record],run.evidence,'UNIT')).toHaveLength(1);
    expect(matchMatrixOrders([record,{...record,orderNo:'TRF-SECOND'}],run.evidence,'UNIT')).toHaveLength(2);
    for (const wrong of [{orderNo:'TRF-OLD'},{fromRegion:'HK'},{toRegion:'SG'},{amount:'99'},{currency:'HKD'},
      {transferType:'p2p'},{remark:'OTHER'},{appliedAt:record.appliedAt+600_000}]) {
      expect(matchMatrixOrders([{...record,...wrong}],run.evidence,'UNIT')).toHaveLength(0);
    }
    run.created(record); expect(() => run.created({...record,orderNo:'TRF-SECOND'})).toThrow();
    expect(() => run.attempt('approve')).toThrow();
    expect(() => run.complete()).toThrow();
    run.advance('CLIENT_FINALIZED'); run.attempt('restore'); run.evidence.restored=true;
    run.evidence.verified=true; run.evidence.adminStatus='已批准'; run.complete();
    expect(TransferFeeMatrixRun.readEvidence('UNIT',root).order?.orderNo).toBe('TRF-UNIT');
    expect(() => new TransferFeeMatrixRun('UNIT',plan,'sender@example.test','recipient@example.test',root)).toThrow(/Existing/);
  } finally {
    if (!root.startsWith(parent + sep)) throw new Error('Unit cleanup outside intended directory.');
    rmSync(root, { recursive: true });
  }
});

test('Admin loading row is not an empty business result', async ({page}) => {
  const headers=['申请编号','记录类型','转出客户','收款人','转出账户','转入账户','币种','转账金额','手续费','实际到账金额','状态','提交时间'];
  const cells=['TXN-UNIT','用户间互转','SENDER TEST','RECIPIENT TEST','巴林账户','巴林账户','USD','USD 11.80','USD 0.00','USD 11.80','已批准','2026-09-10 17:00:00'];
  await page.setContent(`<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td><div role="progressbar">Loading</div>加载资金互转数据中...</td></tr></tbody></table>`);
  const reading=new TransferListPage(page).readCurrentPageRecords();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.evaluate(values=>{document.querySelector('tbody')!.innerHTML=`<tr>${values.map(value=>`<td>${value}</td>`).join('')}</tr>`;},cells);
  expect(await reading).toMatchObject([{adminTransactionId:'TXN-UNIT',status:'已批准',netAmount:'11.8'}]);
});
