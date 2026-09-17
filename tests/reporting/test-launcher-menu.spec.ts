import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { collectLauncherEmail } from '../../scripts/launcher-email-input';

import {
  TEST_LAUNCHER_ENTRIES,
  getLauncherEntry,
  validateLauncherMenu
} from '../../config/test-launcher-menu';

test.describe('统一中文测试启动器菜单', () => {
  test('每次启动都清理旧编译产物并显示本次代码身份', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const launcher = readFileSync('scripts/test-menu.ts', 'utf8');
    const cleaner = readFileSync('scripts/clean-test-launcher.cjs', 'utf8');

    expect(packageJson.scripts.test).toContain('node scripts/clean-test-launcher.cjs && tsc');
    expect(launcher).toContain('启动代码版本：');
    expect(launcher).toContain('process.pid');
    expect(cleaner).toContain("resolve(workspace, '.tmp', 'test-launcher')");
    expect(cleaner).toContain('Refusing to clean an unexpected launcher path');
  });

  test('编号唯一且所有入口映射到已有 npm script', () => {
    expect(() => validateLauncherMenu()).not.toThrow();
    expect(TEST_LAUNCHER_ENTRIES.map(entry => entry.number)).toEqual([
      1, 2, 3, 4, 5,
      6, 7, 8,
      9,
      10, 11, 12,
      13, 14, 15, 16, 17,
      18, 19, 20,
      90, 91
    ]);
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    for (const entry of TEST_LAUNCHER_ENTRIES) {
      expect(entry.npmScript).toBeTruthy();
      expect(scripts[entry.npmScript]).toBeTruthy();
    }
  });

  test('关键业务编号指向当前正式 Case', () => {
    expect(getLauncherEntry(1)?.npmScript).toBe('test:registration:personal');
    expect(getLauncherEntry(2)?.npmScript).toBe('test:registration:corporate');
    expect(getLauncherEntry(3)?.npmScript).toBe('test:deposit:claim');
    expect(getLauncherEntry(4)?.npmScript).toBe('test:deposit:rejection-journey');
    expect(getLauncherEntry(5)?.npmScript).toBe('test:journey:personal:withdrawal');
    expect(getLauncherEntry(6)?.npmScript).toBe('test:u2u:existing');
    expect(getLauncherEntry(7)?.npmScript).toBe('test:transfer:approve');
    expect(getLauncherEntry(8)?.npmScript).toBe('test:client:exchange');
    expect(getLauncherEntry(9)?.npmScript).toBe('test:trust:beneficiary');
    expect(getLauncherEntry(10)?.npmScript).toBe('test:wealth:subscribe:approve');
    expect(getLauncherEntry(11)?.npmScript).toBe('test:wealth:redeem:approve');
    expect(getLauncherEntry(11)?.name).toBe('理财产品赎回');
    expect(getLauncherEntry(12)?.npmScript).toBe('test:wealth:subscribe:reject');
    expect(getLauncherEntry(13)?.npmScript).toBe('test:broker-opening:tiger');
    expect(getLauncherEntry(14)?.npmScript).toBe('test:broker-opening:webull');
    expect(getLauncherEntry(15)?.npmScript).toBe('test:account-opening:bh-approve');
    expect(getLauncherEntry(16)?.npmScript).toBe('test:account-opening:us-approve:resume');
    expect(getLauncherEntry(17)?.npmScript).toBe('test:account-opening:sg-approve');
    expect(getLauncherEntry(18)?.npmScript).toBe('test:admin:manual-deposit');
    expect(getLauncherEntry(19)?.npmScript).toBe('test:admin:manual-withdrawal');
    expect(getLauncherEntry(20)?.npmScript).toBe('test:admin:opening:dry-run');
    expect(getLauncherEntry(90)?.npmScript).toBe('test:smoke');
    expect(getLauncherEntry(91)?.npmScript).toBe('regression');
    expect(getLauncherEntry(92)).toBeUndefined();
    expect(getLauncherEntry(93)).toBeUndefined();
  });

  test('菜单13余额不足时自动补款且不单独确认补款', () => {
    const launcher = readFileSync('scripts/test-menu.ts', 'utf8');
    expect(launcher).toContain('余额不足时将自动补足测试余额');
    expect(launcher).toContain('确认执行老虎证券开户？Y/N');
    expect(launcher).not.toContain('余额不足，是否通过管理端手动入金补充测试余额？');
    expect(launcher).not.toContain('确认执行完整老虎证券开户流程？Y/N');
    expect(launcher).not.toContain('topUpChoice');
  });

  test('菜单15和17各只确认一次且余额不足时自动补款', () => {
    const launcher = readFileSync('scripts/test-menu.ts', 'utf8');
    expect(getLauncherEntry(15)?.safetySwitches).toEqual([
      'ALLOW_MONEY_TESTS', 'ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS'
    ]);
    expect(getLauncherEntry(17)?.safetySwitches).toEqual([
      'ALLOW_MONEY_TESTS', 'ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS'
    ]);
    expect(launcher).toContain('确认执行${accountName}开户？Y/N');
    expect(launcher).toContain('余额不足时将自动补足测试余额；补款完成后自动复核并继续开户，不再询问。');
    expect(launcher).not.toContain('是否通过管理端手动入金补充');
    expect(launcher).not.toContain('是否继续开户');
  });
});

test.describe('启动器运行时邮箱', () => {
  for (const [number, key] of [[1, 'PERSONAL_REGISTRATION_EMAIL'], [2, 'CORPORATE_REGISTRATION_EMAIL']] as const) {
    test(`${number} 注册邮箱只采用运行人员输入`, async () => {
      const environment = { [key]: 'old@example.test' };
      const values = await collectLauncherEmail(
        { question: async () => ' New.User@example.test ' }, getLauncherEntry(number)!, environment, () => undefined
      );
      expect(values).toEqual({ [key]: 'new.user@example.test' });
      expect(environment[key]).toBe('old@example.test');
      for (const invalid of ['', 'bad', 'a@b..test', 'a@example.test\nnext']) {
        await expect(collectLauncherEmail(
          { question: async () => invalid }, getLauncherEntry(number)!, environment, () => undefined
        )).rejects.toThrow('REGISTRATION_EMAIL_REQUIRED');
      }
    });
  }

  test('转账可覆盖默认邮箱，回车使用默认邮箱，且环境不被修改', async () => {
    const environment = {
      CLIENT_USERNAME: 'sender@example.test',
      U2U_DEFAULT_RECIPIENT_EMAIL: 'default@example.test',
      U2U_RECIPIENT_EMAIL: 'previous@example.test'
    };
    for (const [answer, expected] of [['', 'default@example.test'], [' other@example.test ', 'other@example.test']]) {
      expect(await collectLauncherEmail({ question: async () => answer }, getLauncherEntry(6)!, environment, () => undefined))
        .toEqual({ U2U_RECIPIENT_EMAIL: expected });
    }
    expect(environment.U2U_RECIPIENT_EMAIL).toBe('previous@example.test');
    for (const invalid of ['SENDER@example.test', 'invalid']) {
      await expect(collectLauncherEmail({ question: async () => invalid }, getLauncherEntry(6)!, environment, () => undefined))
        .rejects.toThrow(/U2U_RECIPIENT/);
    }
    await expect(collectLauncherEmail({ question: async () => '' }, getLauncherEntry(6)!, {
      CLIENT_USERNAME: environment.CLIENT_USERNAME
    }, () => undefined)).rejects.toThrow('U2U_RECIPIENT_EMAIL_REQUIRED');
  });

  test('菜单11可输入测试用户，回车使用CLIENT_USERNAME且不修改原环境', async () => {
    const environment = Object.freeze({ CLIENT_USERNAME: 'Default.User@example.test' });
    for (const [answer, expected] of [['', 'default.user@example.test'], [' Other.User@example.test ', 'other.user@example.test']]) {
      const messages: string[] = [];
      expect(await collectLauncherEmail({ question: async prompt => {
        expect(prompt).toContain('请输入测试用户邮箱');
        expect(prompt).toContain('默认：Default.User@example.test');
        expect(prompt).toContain('直接按 Enter');
        return answer;
      } }, getLauncherEntry(11)!, environment, message => messages.push(message))).toEqual({
        CLIENT_USERNAME: expected,
        WEALTH_REDEEM_USERNAME: expected
      });
      expect(messages).toEqual([`测试用户：${expected}`]);
    }
    expect(environment.CLIENT_USERNAME).toBe('Default.User@example.test');
    await expect(collectLauncherEmail({ question: async () => 'bad' }, getLauncherEntry(11)!, environment, () => undefined))
      .rejects.toThrow('WEALTH_REDEEM_USER_REQUIRED');
    await expect(collectLauncherEmail({ question: async () => '' }, getLauncherEntry(11)!, {}, () => undefined))
      .rejects.toThrow('WEALTH_REDEEM_USER_REQUIRED');
  });

  test('菜单18可输入手动入金用户，回车使用CLIENT_USERNAME且仅覆盖子进程变量', async () => {
    const environment = Object.freeze({ CLIENT_USERNAME: 'Default.User@example.test' });
    for (const [answer, expected] of [['', 'default.user@example.test'], [' Other.User@example.test ', 'other.user@example.test']]) {
      expect(await collectLauncherEmail({ question: async () => answer }, getLauncherEntry(18)!, environment, () => undefined))
        .toEqual({ CLIENT_USERNAME: expected, MANUAL_DEPOSIT_USER_EMAIL: expected });
    }
    expect(environment.CLIENT_USERNAME).toBe('Default.User@example.test');
    await expect(collectLauncherEmail({ question: async () => 'bad' }, getLauncherEntry(18)!, environment, () => undefined))
      .rejects.toThrow('MANUAL_DEPOSIT_USER_REQUIRED');
  });

  test('菜单13必须输入本次老虎开户用户且仅覆盖子进程变量', async () => {
    const environment = Object.freeze({ CLIENT_USERNAME: 'default@example.test' });
    expect(await collectLauncherEmail(
      { question: async prompt => {
        expect(prompt).toContain('请输入本次测试用户邮箱');
        return ' Tiger.User@example.test ';
      } },
      getLauncherEntry(13)!,
      environment,
      () => undefined
    )).toEqual({
      CLIENT_USERNAME: 'tiger.user@example.test',
      TIGER_TEST_EMAIL: 'tiger.user@example.test'
    });
    expect(environment.CLIENT_USERNAME).toBe('default@example.test');
    for (const invalid of ['', 'bad-email']) {
      await expect(collectLauncherEmail(
        { question: async () => invalid }, getLauncherEntry(13)!, environment, () => undefined
      )).rejects.toThrow('TIGER_TEST_EMAIL_REQUIRED');
    }
  });

  test('菜单14必须输入本次微牛开户用户且仅覆盖子进程变量', async () => {
    const environment = Object.freeze({ CLIENT_USERNAME: 'default@example.test' });
    expect(await collectLauncherEmail(
      { question: async () => ' Webull.User@example.test ' },
      getLauncherEntry(14)!,
      environment,
      () => undefined
    )).toEqual({
      CLIENT_USERNAME: 'webull.user@example.test',
      WEBULL_TEST_EMAIL: 'webull.user@example.test'
    });
    expect(environment.CLIENT_USERNAME).toBe('default@example.test');
    await expect(collectLauncherEmail(
      { question: async () => 'bad-email' }, getLauncherEntry(14)!, environment, () => undefined
    )).rejects.toThrow('WEBULL_TEST_EMAIL_REQUIRED');
  });

  test('菜单15和17必须输入本次开户用户且仅覆盖子进程变量', async () => {
    const environment = Object.freeze({ CLIENT_USERNAME: 'default@example.test', OPENING_TEST_EMAIL: 'old@example.test' });
    for (const number of [15, 17]) {
      expect(await collectLauncherEmail(
        { question: async prompt => {
          expect(prompt).toContain('请输入本次测试用户邮箱');
          return ' Opening.User@example.test ';
        } },
        getLauncherEntry(number)!,
        environment,
        () => undefined
      )).toEqual({
        CLIENT_USERNAME: 'opening.user@example.test',
        OPENING_TEST_EMAIL: 'opening.user@example.test'
      });
      for (const invalid of ['', 'bad-email']) {
        await expect(collectLauncherEmail(
          { question: async () => invalid }, getLauncherEntry(number)!, environment, () => undefined
        )).rejects.toThrow('JURISDICTION_OPENING_EMAIL_REQUIRED');
      }
    }
    expect(environment.OPENING_TEST_EMAIL).toBe('old@example.test');
  });

  test('普通业务直接保留原Runner参数，不统一询问邮箱或检查用户状态', async () => {
    for (const number of [3, 4, 5, 7, 8, 9, 10, 12, 16, 19, 20, 90, 91]) {
      expect(await collectLauncherEmail({ question: async () => { throw new Error('Unexpected prompt'); } },
        getLauncherEntry(number)!, {}, () => undefined)).toEqual({});
    }
  });

  test('转账确认前展示默认值及本次双方账号，显式输入可覆盖无效默认值', async () => {
    const messages: string[] = [];
    const environment = Object.freeze({
      CLIENT_USERNAME: 'sender@example.test',
      U2U_DEFAULT_RECIPIENT_EMAIL: 'invalid-default'
    });
    const result = await collectLauncherEmail({ question: async message => {
      expect(message).toContain('请输入收款用户邮箱');
      expect(message).toContain('默认：invalid-default');
      expect(message).toContain('直接按 Enter');
      return 'Recipient@example.test';
    } }, getLauncherEntry(6)!, environment, message => messages.push(message));
    expect(result).toEqual({ U2U_RECIPIENT_EMAIL: 'recipient@example.test' });
    expect(messages).toEqual(['转出账号：\nsender@example.test\n收款账号：\nrecipient@example.test']);
    await expect(collectLauncherEmail({ question: async () => '' }, getLauncherEntry(6)!,
      environment, () => undefined)).rejects.toThrow('U2U_RECIPIENT_EMAIL_REQUIRED');
    await expect(collectLauncherEmail({ question: async () => '' }, getLauncherEntry(6)!, {
      CLIENT_USERNAME: 'Sender@example.test', U2U_DEFAULT_RECIPIENT_EMAIL: 'sender@example.test'
    }, () => undefined)).rejects.toThrow('U2U_RECIPIENT_EQUALS_SENDER');
  });

  test('缺少合法Sender时禁止启动U2U，不自动切换账号', async () => {
    for (const sender of ['', 'invalid']) {
      await expect(collectLauncherEmail({ question: async () => { throw new Error('Unexpected prompt'); } },
        getLauncherEntry(6)!, { CLIENT_USERNAME: sender }, () => undefined)).rejects.toThrow('U2U_SENDER_REQUIRED');
    }
  });
});
