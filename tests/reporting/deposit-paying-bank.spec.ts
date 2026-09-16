import { expect, test, type Page } from '@playwright/test';
import { DepositPage } from '../../pages/client/DepositPage';

const summary = '<div role="button" tabindex="0" aria-expanded="false"><div><h6>选择打款银行</h6><p>TEST BANK / TEST HOLDER</p></div></div>';
const details = '<div><p>银行名称</p><div><h6>TEST BANK</h6></div></div>' +
  '<div><p>账户名称</p><div><h6>TEST HOLDER</h6></div></div>' +
  '<div><p>账户号码</p><div><h6>9900001234</h6></div></div>';
const unrelated = '<section><h6>收款银行信息</h6><p>OTHER BANK</p></section>' +
  '<section><h6>币种</h6><button role="combobox">美元</button></section>';

async function singleBank(page: Page, bankDetails = details) {
  await page.setContent(unrelated + `<section class="MuiAccordion-root">${summary}<div role="region" hidden>${bankDetails}</div></section>`);
  await page.evaluate(() => {
    document.body.dataset.clicks = '0';
    document.addEventListener('click', () => {
      document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1);
    });
  });
}

async function multipleBanks(page: Page, accordion: boolean) {
  const select = '<button role="combobox" id="paying-bank">请选择</button>';
  await page.setContent(unrelated + (accordion
    ? `<section class="MuiAccordion-root">${summary}<div role="region" hidden>${select}</div></section>`
    : `<section><h6>选择打款银行</h6>${select}</section>`) +
    '<div role="listbox" hidden><div role="option">TEST BANK A / 1234</div><div role="option">TEST BANK B / 5678</div></div>');
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const select = document.querySelector<HTMLElement>('#paying-bank')!;
    select.addEventListener('click', () => { list.hidden = false; });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') list.hidden = true; });
    document.body.dataset.selected = '0';
    for (const option of list.querySelectorAll('[role="option"]')) {
      option.addEventListener('click', () => {
        select.textContent = option.textContent;
        list.hidden = true;
        document.body.dataset.selected = String(Number(document.body.dataset.selected) + 1);
      });
    }
    const summary = document.querySelector<HTMLElement>('[aria-expanded]');
    summary?.addEventListener('click', () => {
      summary.setAttribute('aria-expanded', 'true');
      document.querySelector<HTMLElement>('[role="region"]')!.hidden = false;
    });
  });
}

test('单银行自动选中：数量为1，不展开或点击选择，也不误用收款银行', async ({ page }) => {
  await singleBank(page);
  const form = new DepositPage(page);
  expect(await form.readPayingBankCount()).toBe(1);
  await form.selectFirstPayingBank();
  expect(await form.selectPayingBank('TEST BANK')).toBe('TEST BANK / TEST HOLDER');
  expect(await form.selectPayingBank('unlisted label', '1234')).toBe('TEST BANK / TEST HOLDER');
  await expect(page.locator('[aria-expanded]')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-clicks', '0');
  expect(form.submissionClicks()).toBe(0);
});

test('单银行不匹配时不能用页面其他区域的银行文案冒充', async ({ page }) => {
  await singleBank(page);
  await expect(new DepositPage(page).selectPayingBank('OTHER BANK', '9999'))
    .rejects.toThrow('default paying bank does not match');
  await expect(page.locator('body')).toHaveAttribute('data-clicks', '0');
});

test('选中银行后按详情核对真实账号，不要求下拉文案包含账号', async ({ page }) => {
  await singleBank(page);
  const form = new DepositPage(page);
  await form.expectPayingBankDetails('TEST BANK', '9900001234');
  await expect(page.locator('body')).toHaveAttribute('data-clicks', '0');
  expect(form.submissionClicks()).toBe(0);
});

test('单银行资料为空不能仅因没有下拉框就认定已配置', async ({ page }) => {
  await singleBank(page, details.replace('TEST BANK', '-'));
  await expect(new DepositPage(page).readPayingBankCount()).rejects.toThrow('missing 银行名称');
  await expect(page.locator('body')).toHaveAttribute('data-clicks', '0');
});

for (const accordion of [false, true]) {
  test(`${accordion ? '折叠面板' : '原下拉框'}多银行仍可读取数量、选择默认银行或指定银行`, async ({ page }) => {
    await multipleBanks(page, accordion);
    const form = new DepositPage(page);
    expect(await form.readPayingBankCount()).toBe(2);
    await form.selectFirstPayingBank();
    await expect(page.locator('#paying-bank')).toHaveText('TEST BANK A / 1234');
    expect(await form.selectPayingBank('TEST BANK B')).toBe('TEST BANK B / 5678');
    await expect(page.locator('#paying-bank')).toHaveText('TEST BANK B / 5678');
    await expect(page.locator('body')).toHaveAttribute('data-selected', '2');
    expect(form.submissionClicks()).toBe(0);
  });
}

test('多个匹配银行保留唯一性检查，不通过静态文案回退绕过', async ({ page }) => {
  await multipleBanks(page, false);
  await expect(new DepositPage(page).selectPayingBank('TEST BANK')).rejects.toThrow('found 2');
  await expect(page.locator('body')).toHaveAttribute('data-selected', '0');
});
