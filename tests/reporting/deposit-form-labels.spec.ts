import { expect, test, type Page } from '@playwright/test';
import { DepositPage } from '../../pages/client/DepositPage';
import { env } from '../../src/config/env';
import { resolveDepositFormLabels } from '../../src/deposit/deposit-form-labels';
import { getDepositTestConfig } from '../client/deposit/depositTestSupport';

test('legacy deposit configuration maps to the verified current labels without changing its source', () => {
  const input = { channel: '电汇', purpose: '账户操作', sourceOfFunds: '工资' };
  expect(resolveDepositFormLabels(input)).toEqual({
    channel: 'SWIFT', purpose: '账户操作', sourceOfFunds: '工资及薪酬收入'
  });
  expect(input).toEqual({ channel: '电汇', purpose: '账户操作', sourceOfFunds: '工资' });
});

for (const channel of ['SWIFT', 'LOCAL PAYMENT', 'FPS', '其他', 'UNSUPPORTED']) {
  test(`explicit channel ${channel} is preserved, never replaced with the first option`, () => {
    const input = { channel, purpose: '投资', sourceOfFunds: '投资收益' };
    expect(resolveDepositFormLabels(input)).toEqual(input);
  });
}

test('whitespace is normalized without fuzzy matching other labels', () => {
  expect(resolveDepositFormLabels({ channel: ' 电汇 ', purpose: ' 账户操作 ', sourceOfFunds: ' 工资 ' }))
    .toEqual({ channel: 'SWIFT', purpose: '账户操作', sourceOfFunds: '工资及薪酬收入' });
});

test('shared test configuration supplies the same labels to the form, report and Admin fingerprint', () => {
  const original = { ...env.deposit };
  try {
    Object.assign(env.deposit, {
      accountType: '香港账户', currency: 'USD', currencyLabel: '美元', testAmount: '11.23',
      uniqueAmountBase: '11', adminUserIdentity: 'TEST USER',
      channel: '电汇', purpose: '账户操作', sourceOfFunds: '工资'
    });
    const processValues = [process.env.DEPOSIT_CHANNEL, process.env.DEPOSIT_SOURCE_OF_FUNDS];
    expect(getDepositTestConfig()).toMatchObject({
      channel: 'SWIFT', purpose: '账户操作', sourceOfFunds: '工资及薪酬收入'
    });
    expect(env.deposit.channel).toBe('电汇');
    expect(env.deposit.sourceOfFunds).toBe('工资');
    expect([process.env.DEPOSIT_CHANNEL, process.env.DEPOSIT_SOURCE_OF_FUNDS]).toEqual(processValues);
  } finally { Object.assign(env.deposit, original); }
});

async function dropdowns(page: Page, channels = ['LOCAL PAYMENT', 'FPS', 'SWIFT', '其他']) {
  const fields = [
    { label: '打款渠道', options: channels },
    { label: '打款用途', options: ['账户操作', '投资'] },
    { label: '资金来源', options: ['工资及薪酬收入', '投资收益'] }
  ];
  await page.setContent(fields.map(field =>
    `<section><button role="combobox" aria-label="${field.label}">请选择</button>` +
    `<div role="listbox" hidden>${field.options.map(option => `<div role="option">${option}</div>`).join('')}</div></section>`
  ).join(''));
  await page.evaluate(() => {
    for (const section of document.querySelectorAll('section')) {
      const select = section.querySelector('button')!;
      const list = section.querySelector<HTMLElement>('[role="listbox"]')!;
      select.onclick = () => { list.hidden = false; };
      for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
        option.onclick = () => { select.textContent = option.textContent; list.hidden = true; };
      }
    }
  });
}

test('real Page Object selects SWIFT, unchanged purpose and the renamed source', async ({ page }) => {
  await dropdowns(page);
  const labels = resolveDepositFormLabels({ channel: '电汇', purpose: '账户操作', sourceOfFunds: '工资' });
  const form = new DepositPage(page);
  await form.selectChannel(labels.channel);
  await form.selectPurpose(labels.purpose);
  await form.selectSourceOfFunds(labels.sourceOfFunds);
  await expect(page.getByRole('combobox', { name: '打款渠道' })).toHaveText('SWIFT');
  await expect(page.getByRole('combobox', { name: '打款用途' })).toHaveText('账户操作');
  await expect(page.getByRole('combobox', { name: '资金来源' })).toHaveText('工资及薪酬收入');
  expect(form.submissionClicks()).toBe(0);
});

for (const channels of [['LOCAL PAYMENT', 'FPS'], ['SWIFT', 'SWIFT']]) {
  test(`missing or ambiguous SWIFT option cannot silently select another channel (${channels.length === 2 && channels[0] === 'SWIFT' ? 'ambiguous' : 'missing'})`, async ({ page }) => {
    await dropdowns(page, channels);
    const form = new DepositPage(page);
    await expect(form.selectChannel('SWIFT')).rejects.toThrow(/expected one option/);
    await expect(page.getByRole('combobox', { name: '打款渠道' })).toHaveText('请选择');
    expect(form.submissionClicks()).toBe(0);
  });
}
