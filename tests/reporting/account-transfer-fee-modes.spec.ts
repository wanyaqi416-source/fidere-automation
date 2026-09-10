import { test, expect } from '../../fixtures/reporting.fixture';
import { AccountTypeConfigurationPage } from '../../pages/admin/AccountTypeConfigurationPage';
import { usdTransferFeeRule, snapshotUsdFeeRule, calculateExactTransferFee, withUsdTransferFeeRule,
  sameAccountTypeConfiguration, verifyTransferFeeQuote, TRANSFER_FEE_LABELS, type AccountTypeFeeSnapshot } from '../../src/transfer/account-transfer-fee';
import { FLOW_REGISTRY } from '../../config/flow-registry';

const original: AccountTypeFeeSnapshot = { accountType: '巴林账户', code: 'BH', fields: { openingFee: '100' },
  currencies: { USD: { enabled: true, fee: '40.00' }, EUR: { enabled: true, fee: '2.00', feeType: 'percent' } } };

test('Each real dropdown mode validates its own meaning, percentage range and two-decimal precision', () => {
  expect(usdTransferFeeRule('none', '0').value).toBe('0.00');
  expect(usdTransferFeeRule('fixed', '100.01').value).toBe('100.01');
  expect(usdTransferFeeRule('percent', '1.25')).toEqual({ type: 'percent', currency: 'USD', value: '1.25' });
  expect(usdTransferFeeRule('percent', '100').value).toBe('100.00');
  for (const [type, value] of [['none','1'], ['percent','100.01'], ['percent','-1'], ['percent','0.001'], ['fixed','-1'],
    ['fixed','1e2'], ['percent','NaN'], ['unknown','1'], ['__proto__','1'], ['percent',''], ['percent','1%']]) {
    expect(() => usdTransferFeeRule(type,value)).toThrow();
  }
});

test('Exact-cent arithmetic distinguishes free, fixed and percent without inventing a rounding rule', () => {
  for (const [type, value, first, second] of [['none','0','0.00','0.00'], ['fixed','0.37','0.37','0.37'], ['percent','1.25','1.25','2.50']]) {
    const rule = usdTransferFeeRule(type,value);
    expect(calculateExactTransferFee(rule,'100.00')).toBe(first);
    expect(calculateExactTransferFee(rule,'200.00')).toBe(second);
  }
  expect(() => calculateExactTransferFee(usdTransferFeeRule('percent','1.25'),'11.13')).toThrow(/ROUNDING_RULE_UNCONFIRMED/);
  expect(() => calculateExactTransferFee(usdTransferFeeRule('percent','100'),'100')).toThrow(/exceed/);
  expect(() => calculateExactTransferFee(usdTransferFeeRule('none','0'),'0')).toThrow();
});

test('Configuration restoration preserves fee TYPE as well as value and every unrelated currency', () => {
  expect(snapshotUsdFeeRule(original).type).toBe('fixed');
  const percentage = withUsdTransferFeeRule(original,usdTransferFeeRule('percent','1.25'));
  const fixed = withUsdTransferFeeRule(percentage,usdTransferFeeRule('fixed','0.37'));
  expect(fixed.currencies.EUR).toEqual(original.currencies.EUR);
  expect(sameAccountTypeConfiguration(withUsdTransferFeeRule(fixed,snapshotUsdFeeRule(percentage)),percentage)).toBe(true);
  expect(sameAccountTypeConfiguration(withUsdTransferFeeRule(percentage,usdTransferFeeRule('fixed','1.25')),percentage)).toBe(false);
  const free = withUsdTransferFeeRule(original,usdTransferFeeRule('none','0'));
  expect(sameAccountTypeConfiguration(free,withUsdTransferFeeRule(original,usdTransferFeeRule('fixed','0')))).toBe(false);
  expect(sameAccountTypeConfiguration(original,withUsdTransferFeeRule(original,usdTransferFeeRule('fixed','40')))).toBe(true);
});

test('Client quote checks percentage as a rate, with exact fee and net amounts, not as a fixed USD value', () => {
  const rule = usdTransferFeeRule('percent','5');
  const expected = { sourceAccount: '巴林账户', targetAccount: '香港账户', amount: '200.00' };
  const quote = { ...expected, currency: 'USD', fee: '10.00', received: '190.00' };
  expect(() => verifyTransferFeeQuote(quote,rule,expected)).not.toThrow();
  expect(() => verifyTransferFeeQuote({ ...quote, fee: '5.00', received: '195.00' },rule,expected)).toThrow();
  expect(() => verifyTransferFeeQuote({ ...quote, received: '200.00' },rule,expected)).toThrow();
});

test('All three mode cases are opt-in read-only and do not reuse the original completed money Run', () => {
  for (const type of Object.keys(TRANSFER_FEE_LABELS)) {
    expect(FLOW_REGISTRY.find(flow=>flow.id===`account-transfer-fee-${type}-dry-run`)).toMatchObject({
      changesData: false, affectsMoney: false, requiresSecurityKey: false, level: 'L3', realE2EVerified: null,
      defaultRegression: false, moneyRegression: false, safetySwitches: [] });
  }
  expect(FLOW_REGISTRY.find(flow=>flow.id==='account-transfer-fee')?.realE2EVerified).toBe(true);
});

test('Shared Page Object handles all dropdowns, preserves units and restores a percent form without saving', async ({ page }) => {
  const placeholders = ['例如：香港账户','例如：Hong Kong Account','例如：香港帳戶','例如：HK_ACCOUNT','例如：HK','例如：hk_bank','例如：offshore'];
  const values = ['巴林账户','Bahrain Account','巴林账户','BH','BH','EU_BLANK','offshore'];
  await page.setContent(`<dialog open aria-label="编辑账户类型">
    ${placeholders.map((p,i)=>`<input placeholder="${p}" value="${values[i]}">`).join('')}
    <label for="sort">展示排序 *</label><input id="sort" type="number" value="4"><label for="fee">开户费金额</label><input id="fee" value="100">
    ${['状态','开户是否需要资料','开户费币种'].map((label,i)=>`<div><label>${label}</label><div role="combobox">${['启用','否','USD 美元'][i]}</div></div>`).join('')}
    ${Object.entries({ EUR:'欧元', USD:'美元', HKD:'港币', SGD:'新币', CNY:'人民币', JPY:'日元', AED:'阿联酋迪拉姆', GBP:'英镑' }).map(([code,name])=>
      `<section><div><p>${code}</p><p>${name}</p></div><input type="checkbox" checked><div><label>手续费类型</label>
      <div role="combobox" tabindex="0" onclick="openMenu(this)">固定手续费</div><input type="number" min="0" step="0.01" value="40"><p data-unit="${code}">${code}</p></div></section>`).join('')}
    <button onclick="window.saved=true">保存配置</button><button>取消</button></dialog>
    <script>
      function openMenu(combo) {
        const menu=document.createElement('div'); menu.setAttribute('role','listbox');
        for (const mode of ['免手续费','固定手续费','百分比']) {
          const option=document.createElement('button'); option.setAttribute('role','option'); option.textContent=mode;
          option.onclick=()=>{
            const box=combo.parentElement, input=box.querySelector('input'), unit=box.querySelector('[data-unit]');
            combo.textContent=mode; input.disabled=mode==='免手续费';
            if(input.disabled)input.value='0';
            if(mode==='百分比')input.max='100';else input.removeAttribute('max');
            unit.textContent=mode==='百分比'?'%':mode==='免手续费'?mode:unit.dataset.unit; menu.remove();
          };
          menu.append(option);
        }
        document.querySelector('dialog').append(menu);
      }
      document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('[role=listbox]')?.remove()});
    </script>`);
  const admin = new AccountTypeConfigurationPage(page), first = await admin.readFeeConfiguration();
  expect((await admin.readUsdFeeOptions()).sort()).toEqual(Object.values(TRANSFER_FEE_LABELS).sort());
  let current = first;
  for (const [type,value] of [['percent','1.25'], ['fixed','0.37'], ['none','0'], ['percent','1.25']]) {
    const rule=usdTransferFeeRule(type,value);
    await admin.fillUsdTransferFeeRule(rule,current);
    current=await admin.readFeeConfiguration();
    expect(snapshotUsdFeeRule(current)).toEqual(rule);
    expect(current.currencies.EUR).toEqual(first.currencies.EUR);
  }
  expect((await admin.checkUsdFeeInputValidity('100.01')).overflow).toBe(true);
  expect((await admin.checkUsdFeeInputValidity('0.001')).stepMismatch).toBe(true);
  expect(await page.evaluate(()=>Boolean((window as unknown as {saved?:boolean}).saved))).toBe(false);
});
