import { expect, test } from '@playwright/test';
import { WithdrawalPage } from '../../pages/client/WithdrawalPage';
import { Decimal } from '../../src/utils/money';
import { withdrawalDebitFromSettlement } from '../../src/withdrawal/withdrawal-balance-oracle';

test.describe('Journey Withdrawal compatibility @readonly @L2', () => {
  test('fixed source account is verified without selecting another account', async ({ page }) => {
    await page.setContent('<section><h2>本次转账摘要</h2><div><p>付款账户</p><h3>香港账户</h3></div><div><p>实际扣款</p><h3>-</h3></div></section><section><h2>币种</h2><button role="combobox">美元</button></section>');
    const withdrawal = new WithdrawalPage(page);
    expect(await withdrawal.readAccountOptions()).toEqual(['香港账户']);
    await withdrawal.selectAccount('香港账户');
    await expect(withdrawal.selectAccount('新加坡账户')).rejects.toThrow();
    expect(withdrawal.confirmationClicks()).toBe(0);
    expect(withdrawal.securityVerificationClicks()).toBe(0);
  });
  for (const data of [
    { amount: '1.43', fee: '0.20', net: '1.43', debit: '1.63', rule: 'FEE_ADDED' },
    { amount: '1.43', fee: '0.20', net: '1.23', debit: '1.43', rule: 'FEE_INCLUDED' },
    { amount: '1.43', fee: '0', net: '1.43', debit: '1.43', rule: 'FEE_ADDED' }
  ]) {
    test(`order settlement ${data.rule} fee=${data.fee}`, () => {
      const value = withdrawalDebitFromSettlement(new Decimal(data.amount), new Decimal(data.fee), new Decimal(data.net));
      expect(value.debit.toString()).toBe(data.debit);
      expect(value.rule).toBe(data.rule);
    });
  }
  test('inconsistent order amounts never become a guessed balance formula', () => {
    expect(() => withdrawalDebitFromSettlement(new Decimal('1.43'), new Decimal('2'), new Decimal('1'))).toThrow();
    expect(() => withdrawalDebitFromSettlement(new Decimal('1'), new Decimal('-1'), new Decimal('1'))).toThrow();
  });
});
