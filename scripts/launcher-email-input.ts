import type { LauncherTestEntry } from '../config/test-launcher-menu.js';
import { isValidEmail, requireRegistrationEmail, requireU2uRecipient } from '../src/utils/runtime-email.js';

type Environment = Readonly<Record<string, string | undefined>>;
type EmailPrompt = { question(message: string): Promise<string> };

export async function collectLauncherEmail(
  prompt: EmailPrompt,
  entry: LauncherTestEntry,
  environment: Environment,
  print: (message: string) => void = console.log
): Promise<Record<string, string>> {
  if (entry.flow?.id === 'personal-registration' || entry.flow?.id === 'corporate-registration') {
    const personal = entry.flow.id === 'personal-registration';
    const email = requireRegistrationEmail(await prompt.question('请输入本次注册邮箱：\n> '));
    print(`本次注册类型：${personal ? '个人用户' : '企业用户'}\n注册邮箱：${email}`);
    return { [personal ? 'PERSONAL_REGISTRATION_EMAIL' : 'CORPORATE_REGISTRATION_EMAIL']: email };
  }

  if (entry.flow?.id === 'user-to-user-transfer-existing') {
    const sender = environment.CLIENT_USERNAME?.trim();
    if (!sender || !isValidEmail(sender)) throw new Error('U2U_SENDER_REQUIRED: 请配置合法的 CLIENT_USERNAME。');
    const fallback = environment.U2U_DEFAULT_RECIPIENT_EMAIL?.trim() ?? '';
    const answer = await prompt.question(`请输入收款用户邮箱：\n默认：${fallback || '未配置'}\n直接按 Enter 使用默认账号\n> `);
    const recipient = requireU2uRecipient(sender, answer.trim() || fallback);
    print(`转出账号：\n${sender}\n收款账号：\n${recipient}`);
    return { U2U_RECIPIENT_EMAIL: recipient };
  }

  if (entry.flow?.id === 'wealth-redeem') {
    const fallback = environment.CLIENT_USERNAME?.trim() ?? '';
    const answer = await prompt.question(`请输入测试用户邮箱：\n默认：${fallback || '未配置'}\n直接按 Enter 使用默认账号\n> `);
    const email = (answer.trim() || fallback).toLowerCase();
    if (!isValidEmail(email)) throw new Error('WEALTH_REDEEM_USER_REQUIRED: 请输入合法的测试用户邮箱。');
    print(`测试用户：${email}`);
    return { CLIENT_USERNAME: email, WEALTH_REDEEM_USERNAME: email };
  }

  if (entry.flow?.id === 'admin-manual-fiat-deposit') {
    const fallback = environment.CLIENT_USERNAME?.trim() ?? '';
    const answer = await prompt.question(`请输入测试用户邮箱：\n默认：${fallback || '未配置'}\n直接按 Enter 使用默认账号\n> `);
    const email = (answer.trim() || fallback).toLowerCase();
    if (!isValidEmail(email)) throw new Error('MANUAL_DEPOSIT_USER_REQUIRED: 请输入合法的测试用户邮箱。');
    print(`测试用户：${email}`);
    return { CLIENT_USERNAME: email, MANUAL_DEPOSIT_USER_EMAIL: email };
  }

  if (entry.flow?.id === 'tiger-broker-opening') {
    const email = (await prompt.question('请输入本次测试用户邮箱：\n> ')).trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error('TIGER_TEST_EMAIL_REQUIRED: 请输入合法的测试用户邮箱。');
    print(`测试用户：${email}`);
    return { CLIENT_USERNAME: email, TIGER_TEST_EMAIL: email };
  }

  if (entry.flow?.id === 'account-opening-bahrain-approve' ||
      entry.flow?.id === 'account-opening-singapore-approve') {
    const email = (await prompt.question('请输入本次测试用户邮箱：\n> ')).trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error('JURISDICTION_OPENING_EMAIL_REQUIRED: 请输入合法的测试用户邮箱。');
    print(`测试用户：${email}`);
    return { CLIENT_USERNAME: email, OPENING_TEST_EMAIL: email };
  }

  return {};
}
