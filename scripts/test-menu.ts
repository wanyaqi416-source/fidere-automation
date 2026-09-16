import 'dotenv/config';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  TEST_LAUNCHER_ENTRIES,
  TEST_LAUNCHER_SECTIONS,
  getLauncherEntry,
  validateLauncherMenu,
  type LauncherTestEntry
} from '../config/test-launcher-menu.js';
import { inspectSavedAdminSession } from '../src/auth/admin-session.js';
import { authStatePaths } from '../src/config/auth.js';
import { env } from '../src/config/env.js';
import { collectLauncherEmail } from './launcher-email-input.js';
import { collectLauncherU2u } from './launcher-u2u-input.js';
import { launcherFiatEnvironment } from './launcher-fiat-input.js';
import { launcherTrustEnvironment } from './launcher-trust-run.js';
import { launcherManualDepositEnvironment } from './launcher-manual-deposit-run.js';
import { findPendingPersonalRegistration } from './launcher-registration-resume.js';
import {
  jurisdictionAccountName,
  jurisdictionManualDepositInput,
  jurisdictionOpeningEnvironment,
  jurisdictionOpeningPreflightEnvironment,
  jurisdictionOpeningRunId,
  markJurisdictionTopUpAttempt,
  parseJurisdictionOpeningPreflightOutput,
  type JurisdictionOpeningPreflightResult,
  type LauncherJurisdiction
} from './launcher-jurisdiction-opening-run.js';
import {
  parseTigerPreflightOutput,
  tigerManualDepositEnvironment,
  tigerOpeningEnvironment,
  tigerPreflightEnvironment,
  type TigerPreflightResult
} from './launcher-tiger-run.js';
import {
  launcherWealthRedemptionEnvironment,
  launcherWealthSubscriptionEnvironment,
  launcherWealthSubscriptionRejectionEnvironment
} from './launcher-wealth-run.js';
import {
  businessReportPath,
  openLocalUrl,
  runNpmScript,
  runNpmScriptWithResult
} from './cli-utils.js';

const line = '='.repeat(48);

function launcherBuildIdentity(): string {
  try {
    const compiledAt = statSync(process.argv[1]).mtime;
    return `${compiledAt.toLocaleString('zh-CN', { hour12: false })} / PID ${process.pid}`;
  } catch {
    return `无法读取编译时间 / PID ${process.pid}`;
  }
}

function printMenu(): void {
  console.log(`\n${line}`);
  console.log('Fidere 自动化测试');
  console.log(line);
  console.log(`启动代码版本：${launcherBuildIdentity()}`);
  console.log('\n请选择要执行的测试：');
  for (const section of TEST_LAUNCHER_SECTIONS) {
    console.log(`\n【${section}】`);
    for (const entry of TEST_LAUNCHER_ENTRIES.filter(item => item.section === section)) {
      console.log(`${entry.number}. ${entry.name}`);
    }
  }
  console.log('\n【工具】');
  console.log('98. 更新 Admin 登录状态');
  console.log('99. 打开最近一次 Fidere 测试报告');
  console.log('\n0. 退出\n');
}

function yes(value: string): boolean {
  return /^(y|yes)$/i.test(value.trim());
}

function statusIcon(ok: boolean): string {
  return ok ? '✅' : '❌';
}

type LauncherOutcome = 'passed' | 'failed' | 'blocked' | 'skipped';

function launcherOutcome(exitCode: number, rawOutput: string): LauncherOutcome {
  const clean = rawOutput.replace(/\u001b\[[0-9;]*m/g, '');
  if (/\bBLOCKED\b|测试阻塞|阻塞：|BLOCKED_/i.test(clean)) return 'blocked';
  if (/\d+ skipped|全部跳过|⏭/i.test(clean) && !/\d+ passed/i.test(clean)) return 'skipped';
  return exitCode === 0 ? 'passed' : 'failed';
}

function outcomeLabel(outcome: LauncherOutcome): string {
  return {
    passed: '✅ 通过',
    failed: '❌ 失败',
    blocked: '⚠️ 阻塞',
    skipped: '⏭️ 跳过'
  }[outcome];
}

function testType(entry: LauncherTestEntry): string {
  if (entry.affectsMoney) return '资金类';
  if (entry.changesData) return '业务变更类';
  return '只读 / 验证类';
}

function printExecutionPreview(entry: LauncherTestEntry): void {
  console.log('\n即将执行：\n');
  console.log(`测试名称：${entry.name}`);
  console.log(`测试类型：${testType(entry)}`);
  console.log(`需要 Client：${entry.requiresClient ? '是' : '否'}`);
  console.log(`需要 Admin：${entry.requiresAdmin ? '是' : '否'}`);
  console.log(`会产生真实测试数据：${entry.changesData ? '是' : '否'}`);
  if (entry.availabilityNote) console.log(`说明：${entry.availabilityNote}`);
}

async function adminStatus(): Promise<'valid' | 'expired' | 'unavailable'> {
  if (!env.admin.baseUrl) return 'unavailable';
  return inspectSavedAdminSession(env.admin.baseUrl, authStatePaths.admin);
}

async function refreshAdminAuthentication(): Promise<boolean> {
  console.log('\n正在打开 Admin 登录窗口，请在浏览器中完成验证码和登录。');
  const exitCode = await runNpmScript('auth:admin');
  if (exitCode !== 0) {
    console.log('Admin 登录状态更新失败，请查看终端中的认证提示。');
    return false;
  }
  const status = await adminStatus();
  console.log(status === 'valid' ? 'Admin 登录状态已更新。' : 'Admin 登录完成，但业务页面验证未通过。');
  return status === 'valid';
}

async function ensureAdminForSelection(readline: Interface): Promise<boolean> {
  const status = await adminStatus();
  if (status === 'valid') return true;
  if (status === 'unavailable') {
    console.log('\nAdmin 登录状态无法检查：请确认 Admin 地址和当前网络可用。');
    return false;
  }

  console.log('\nAdmin 登录状态已失效。\n');
  console.log('1. 现在重新登录 Admin');
  console.log('2. 返回测试菜单\n');
  const answer = await readline.question('请选择：');
  if (answer.trim() !== '1') return false;
  await refreshAdminAuthentication();
  return false;
}

function mutationEnvironment(entry: LauncherTestEntry): Record<string, string> {
  return Object.fromEntries(entry.safetySwitches.map(name => [name, 'true']));
}

function selectedNpmScript(
  entry: LauncherTestEntry,
  runtimeEnvironment: Readonly<Record<string, string>>
): string {
  if (entry.number !== 1) return entry.npmScript;
  const email = runtimeEnvironment.PERSONAL_REGISTRATION_EMAIL?.trim().toLowerCase();
  const root = '.journey-context/personal';
  if (!email || !existsSync(root)) return entry.npmScript;

  const matches = readdirSync(root, { withFileTypes: true })
    .filter(item => item.isFile() && item.name.endsWith('.json'))
    .map(item => JSON.parse(readFileSync(`${root}/${item.name}`, 'utf8')) as {
      email?: string;
      stage?: string;
      lifecycle?: string;
    })
    .filter(context => context.email?.trim().toLowerCase() === email);
  if (matches.length !== 1) return entry.npmScript;
  const context = matches[0];
  const resumableStages = new Set([
    'USER_REGISTERED',
    'CLIENT_AUTHENTICATED',
    'AUTHORIZATION_REQUIRED',
    'DOCUMENT_COMPLETED',
    'FIDERE_SIGNING_RECOGNIZED'
  ]);
  return context.lifecycle !== 'ABANDONED' && context.stage && resumableStages.has(context.stage)
    ? 'test:registration:personal:resume'
    : entry.npmScript;
}

async function runTigerPreflight(
  runtimeEnvironment: Readonly<Record<string, string>>
): Promise<{ result: TigerPreflightResult; output: string }> {
  const execution = await runNpmScriptWithResult('test:broker-opening:tiger:preflight', {
    environment: {
      ...runtimeEnvironment,
      ALLOW_MONEY_TESTS: 'false',
      ALLOW_ADMIN_MUTATION_TESTS: 'false',
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'false'
    },
    quiet: true
  });
  if (execution.exitCode !== 0) throw new Error(readableFailure(execution.output));
  return { result: parseTigerPreflightOutput(execution.output), output: execution.output };
}

async function runJurisdictionOpeningPreflight(
  runtimeEnvironment: Readonly<Record<string, string>>
): Promise<JurisdictionOpeningPreflightResult> {
  const execution = await runNpmScriptWithResult('test:account-opening:jurisdiction:preflight', {
    environment: {
      ...runtimeEnvironment,
      ALLOW_MONEY_TESTS: 'false',
      ALLOW_CLIENT_MUTATION_TESTS: 'false',
      ALLOW_ADMIN_MUTATION_TESTS: 'false',
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'false'
    },
    quiet: true
  });
  if (execution.exitCode !== 0) throw new Error(readableFailure(execution.output));
  return parseJurisdictionOpeningPreflightOutput(execution.output);
}

function readableFailure(raw: string): string {
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const actual = clean.match(/实际：\s*([^\r\n]+)/)?.[1]?.trim();
  if (actual) return actual;
  const error = clean.match(/(?:Error|错误|失败)[:：]\s*([^\r\n]+)/)?.[1]?.trim();
  return error || '测试未完成，业务证据和技术详情已写入报告。';
}

async function finishMenu(
  readline: Interface,
  entry: LauncherTestEntry,
  outcome: LauncherOutcome,
  durationSeconds: string,
  rawOutput: string,
  reportGenerated: boolean
): Promise<'menu' | 'exit'> {
  console.log(`\n${line}\n`);
  console.log('测试完成\n');
  console.log(`测试名称：${entry.name}`);
  console.log(`结果：${outcomeLabel(outcome)}`);
  console.log(`耗时：${durationSeconds} 秒`);
  if (outcome === 'failed' || outcome === 'blocked') console.log(`\n原因：\n${readableFailure(rawOutput)}`);
  console.log(`\n报告：\n${reportGenerated ? 'Fidere 自动化测试报告已生成' : '本次运行未生成新的业务报告'}\n`);
  console.log('1. 打开测试报告');
  console.log('2. 返回测试菜单');
  console.log('3. 退出\n');
  const answer = await readline.question('请选择：');
  if (answer.trim() === '1') {
    if (existsSync(businessReportPath)) openLocalUrl(businessReportPath);
    else console.log('尚未找到最近一次 Fidere 测试报告。');
    return 'menu';
  }
  return answer.trim() === '3' ? 'exit' : 'menu';
}

async function executeSelection(readline: Interface, entry: LauncherTestEntry): Promise<'menu' | 'exit'> {
  printExecutionPreview(entry);
  let runtimeEnvironment: Record<string, string>;
  try {
    const pendingPersonal = entry.number === 1
      ? findPendingPersonalRegistration()
      : undefined;
    if (pendingPersonal) {
      runtimeEnvironment = {
        PERSONAL_REGISTRATION_EMAIL: pendingPersonal.email,
        PERSONAL_REGISTRATION_APPROVAL_SOURCE_RUN_ID: pendingPersonal.sourceRunId
      };
      console.log('\n检测到上一位个人用户已完成客户端注册，但 Admin KYC 尚未完成。');
      console.log(`本次固定续办用户：${pendingPersonal.email}`);
      console.log(`测试姓名：${pendingPersonal.displayName}`);
      console.log(`当前阶段：${pendingPersonal.stage}`);
      console.log('本次不会创建新账号、重复签名或重复提交 Client KYC。');
      console.log('完成该案件后，菜单 1 才会重新提示输入新的注册邮箱。');
    } else {
      runtimeEnvironment = await collectLauncherEmail(readline, entry, process.env);
    }
    if (entry.number === 4 || entry.number === 5) {
      Object.assign(runtimeEnvironment, launcherFiatEnvironment(entry.number, process.env));
      console.log(`测试用户：${process.env.CLIENT_USERNAME}\n本次 Run：${runtimeEnvironment.DEPOSIT_REJECT_RUN_ID ?? runtimeEnvironment.WITHDRAWAL_RUN_ID}`);
      console.log(entry.number === 4
        ? '使用默认账号及已有银行地址，只提交一笔入金申请并拒绝；已有申请仅续办。'
        : '使用默认账号的已有余额和银行地址，只提交一笔出金；已有申请仅续办，不额外入金。');
    }
    if (entry.flow?.id === 'user-to-user-transfer-existing') {
      Object.assign(runtimeEnvironment, await collectLauncherU2u(readline, { ...process.env, ...runtimeEnvironment }));
    }
    if (entry.flow?.id === 'trust-beneficiary-golden-journey') {
      Object.assign(runtimeEnvironment, launcherTrustEnvironment({ ...process.env, ...runtimeEnvironment }));
      console.log(`测试用户：${runtimeEnvironment.TRUST_BENEFICIARY_USER_EMAIL}`);
      console.log(`本次 Run：${runtimeEnvironment.TRUST_BENEFICIARY_RUN_ID}`);
    }
    if (entry.flow?.id === 'wealth-subscribe-approve') {
      Object.assign(runtimeEnvironment, launcherWealthSubscriptionEnvironment({ ...process.env, ...runtimeEnvironment }));
      console.log(`测试用户：${runtimeEnvironment.WEALTH_TEST_USERNAME}`);
      console.log(`本次 Run：${runtimeEnvironment.WEALTH_RUN_ID}`);
      console.log(`认购金额：${runtimeEnvironment.WEALTH_AUTHORIZED_AMOUNT} USD`);
      if (runtimeEnvironment.WEALTH_RESUME === 'true') console.log('执行方式：Resume当前认购，不创建第二笔订单');
    }
    if (entry.flow?.id === 'wealth-subscribe-reject') {
      Object.assign(runtimeEnvironment, launcherWealthSubscriptionRejectionEnvironment({ ...process.env, ...runtimeEnvironment }));
      console.log(`测试用户：${runtimeEnvironment.WEALTH_TEST_USERNAME}`);
      console.log(`本次 Run：${runtimeEnvironment.WEALTH_RUN_ID}`);
      console.log(`认购产品：${runtimeEnvironment.WEALTH_AUTHORIZED_PRODUCT}`);
      console.log(`认购金额：${runtimeEnvironment.WEALTH_AUTHORIZED_AMOUNT} USD`);
      console.log('Admin动作：拒绝一次');
      if (runtimeEnvironment.WEALTH_RESUME === 'true') console.log('执行方式：Resume当前认购，不创建第二笔订单');
    }
    if (entry.flow?.id === 'wealth-redeem') {
      Object.assign(runtimeEnvironment, launcherWealthRedemptionEnvironment({ ...process.env, ...runtimeEnvironment }));
      console.log(`本次 Run：${runtimeEnvironment.WEALTH_REDEEM_RUN_ID}`);
      if (runtimeEnvironment.WEALTH_REDEEM_RESUME === 'true') console.log('执行方式：Resume当前赎回，不创建第二笔订单');
    }
    if (entry.flow?.id === 'admin-manual-fiat-deposit') {
      Object.assign(runtimeEnvironment, launcherManualDepositEnvironment({ ...process.env, ...runtimeEnvironment }));
      console.log(`本次 Run：${runtimeEnvironment.MANUAL_DEPOSIT_RUN_ID}`);
      console.log(`香港账户手动入金：${runtimeEnvironment.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT} USD`);
      console.log('Admin动作：最终确认入金一次');
    }
    if (entry.flow?.id === 'tiger-broker-opening') {
      Object.assign(runtimeEnvironment, tigerPreflightEnvironment(runtimeEnvironment.TIGER_TEST_EMAIL));
    }
    if (entry.flow?.id === 'account-opening-bahrain-approve' ||
        entry.flow?.id === 'account-opening-singapore-approve') {
      const target: LauncherJurisdiction = entry.flow.id === 'account-opening-bahrain-approve' ? 'BH' : 'SG';
      Object.assign(runtimeEnvironment, jurisdictionOpeningPreflightEnvironment(target, runtimeEnvironment.OPENING_TEST_EMAIL));
    }
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return 'menu';
  }
  const isTigerOpening = entry.flow?.id === 'tiger-broker-opening';
  const jurisdictionTarget: LauncherJurisdiction | undefined = entry.flow?.id === 'account-opening-bahrain-approve'
    ? 'BH'
    : entry.flow?.id === 'account-opening-singapore-approve'
      ? 'SG'
      : undefined;
  if (!isTigerOpening && !jurisdictionTarget) {
    const confirmation = await readline.question('\n确认执行？Y/N：');
    if (!yes(confirmation)) {
      console.log('已取消，本次未执行测试。');
      return 'menu';
    }
  }

  const total = entry.requiresAdmin ? 3 : 2;
  let step = 1;
  if (entry.requiresAdmin) {
    output.write(`[${step}/${total}] 检查 Admin 登录状态`);
    const ready = await ensureAdminForSelection(readline);
    console.log(`  ${statusIcon(ready)}`);
    if (!ready) return 'menu';
    step += 1;
  }

  if (isTigerOpening) {
    output.write(`[${step}/${total}] 检查老虎证券开户状态、费用和余额`);
    let preflight: TigerPreflightResult;
    try {
      ({ result: preflight } = await runTigerPreflight(runtimeEnvironment));
    } catch (error) {
      console.log(`  ${statusIcon(false)}`);
      console.log(error instanceof Error ? error.message : String(error));
      return 'menu';
    }
    console.log(`  ${statusIcon(true)}`);

    if (preflight.status === 'ALREADY_OPEN') {
      console.log('\n当前测试用户已经开通老虎证券，请更换未开户测试账号。');
      console.log('本次属于测试数据前置条件不满足，不计为业务 FAIL。');
      return 'menu';
    }

    let tigerExecutionConfirmed = false;
    if (preflight.status === 'INSUFFICIENT_BALANCE') {
      let manualDepositEnvironment: Record<string, string>;
      let plannedTigerEnvironment: Record<string, string>;
      try {
        const topUpInput = tigerManualDepositEnvironment(preflight);
        manualDepositEnvironment = launcherManualDepositEnvironment({
          ...process.env,
          ...runtimeEnvironment,
          ...topUpInput
        });
        plannedTigerEnvironment = tigerOpeningEnvironment({
          ...preflight,
          status: 'READY',
          currentBalance: preflight.requiredBalance,
          shortfall: '0.00'
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        return 'menu';
      }
      console.log(`\n当前测试用户：\n${preflight.email}`);
      console.log(`\n当前余额：\n${preflight.currentBalance} USD`);
      console.log(`\n开户需要：\n${preflight.requiredBalance} USD`);
      console.log(`\n当前缺口：\n${preflight.shortfall} USD`);
      console.log(`\n手动入金 Run：\n${manualDepositEnvironment.MANUAL_DEPOSIT_RUN_ID}`);
      console.log(`\n老虎开户 Run：\n${plannedTigerEnvironment.BROKER_OPENING_RUN_ID}`);
      console.log('\n余额不足时将自动补足测试余额，随后复核余额、提交开户并完成 Admin 审核；过程中不再询问补款。');
      const openingConfirmation = await readline.question('\n确认执行老虎证券开户？Y/N：');
      if (!yes(openingConfirmation)) {
        console.log('已取消，本次未执行老虎证券开户。');
        return 'menu';
      }
      tigerExecutionConfirmed = true;

      console.log(`\n将为同一测试用户补充 ${manualDepositEnvironment.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT} USD。`);
      const topUp = await runNpmScriptWithResult('test:admin:manual-deposit', {
        environment: {
          ...runtimeEnvironment,
          ...manualDepositEnvironment,
          ALLOW_MONEY_TESTS: 'true',
          ALLOW_ADMIN_MUTATION_TESTS: 'true',
          PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'false'
        },
        quiet: true
      });
      if (topUp.exitCode !== 0) {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：手动入金结果未确认，禁止再次入金，也不会继续开户。');
        console.log(readableFailure(topUp.output));
        return 'menu';
      }

      try {
        ({ result: preflight } = await runTigerPreflight(runtimeEnvironment));
      } catch (error) {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：入金后余额复核失败，禁止再次入金，也不会继续开户。');
        console.log(error instanceof Error ? error.message : String(error));
        return 'menu';
      }
      if (preflight.status !== 'READY') {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：入金后余额仍未满足开户条件，禁止再次入金，也不会继续开户。');
        return 'menu';
      }
    }

    try {
      Object.assign(runtimeEnvironment, tigerOpeningEnvironment(preflight));
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return 'menu';
    }
    console.log(`\n测试用户：${preflight.email}`);
    console.log(`老虎开户 Run：${runtimeEnvironment.BROKER_OPENING_RUN_ID}`);
    console.log(`开户费用：${preflight.requiredBalance} USD`);
    console.log(`当前余额：${preflight.currentBalance} USD`);
    if (runtimeEnvironment.BROKER_OPENING_MODE === 'resume-admin') {
      console.log('执行方式：Resume当前老虎开户申请，不重复缴费或安全验证。');
    } else if (runtimeEnvironment.BROKER_OPENING_MODE === 'resume-security-setup') {
      console.log('执行方式：Resume当前安全密钥设置；原开户请求未产生，不创建第二个Run。');
    }
    if (!tigerExecutionConfirmed) {
      const confirmation = await readline.question('\n确认执行老虎证券开户？Y/N：');
      if (!yes(confirmation)) {
        console.log('已取消，本次未执行老虎证券开户。');
        return 'menu';
      }
    }
  }

  if (jurisdictionTarget) {
    const accountName = jurisdictionAccountName(jurisdictionTarget);
    output.write(`[${step}/${total}] 检查${accountName}开户状态、费用和余额`);
    let preflight: JurisdictionOpeningPreflightResult;
    try {
      preflight = await runJurisdictionOpeningPreflight(runtimeEnvironment);
    } catch (error) {
      console.log(`  ${statusIcon(false)}`);
      console.log(error instanceof Error ? error.message : String(error));
      return 'menu';
    }
    console.log(`  ${statusIcon(true)}`);

    if (preflight.status === 'ALREADY_OPEN') {
      console.log(`\n当前用户已开通${accountName}，请更换未开户测试账号。`);
      console.log('本次属于测试数据前置条件不满足，不计为业务 FAIL。');
      return 'menu';
    }

    let openingEnvironment: Record<string, string>;
    let manualDepositEnvironment: Record<string, string> | undefined;
    try {
      openingEnvironment = jurisdictionOpeningEnvironment(preflight);
      if (preflight.status === 'INSUFFICIENT_BALANCE') {
        manualDepositEnvironment = launcherManualDepositEnvironment({
          ...process.env,
          ...runtimeEnvironment,
          ...jurisdictionManualDepositInput(preflight)
        });
      }
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return 'menu';
    }

    console.log(`\n测试流程：${accountName}开户`);
    console.log(`测试用户：${preflight.email}`);
    console.log(`${accountName}开户 Run：${jurisdictionOpeningRunId(jurisdictionTarget, openingEnvironment)}`);
    if (preflight.requiredBalance) console.log(`开户需要：${preflight.requiredBalance} USD`);
    if (preflight.currentBalance) console.log(`当前余额：${preflight.currentBalance} USD`);
    if (manualDepositEnvironment) {
      console.log(`当前缺口：${preflight.shortfall} USD`);
      console.log(`手动入金 Run：${manualDepositEnvironment.MANUAL_DEPOSIT_RUN_ID}`);
      console.log('余额不足时将自动补足测试余额；补款完成后自动复核并继续开户，不再询问。');
    }
    const confirmation = await readline.question(`\n确认执行${accountName}开户？Y/N：`);
    if (!yes(confirmation)) {
      console.log(`已取消，本次未执行${accountName}开户。`);
      return 'menu';
    }

    if (manualDepositEnvironment) {
      try {
        markJurisdictionTopUpAttempt({
          target: jurisdictionTarget,
          openingRunId: jurisdictionOpeningRunId(jurisdictionTarget, openingEnvironment),
          manualDepositRunId: manualDepositEnvironment.MANUAL_DEPOSIT_RUN_ID,
          amount: manualDepositEnvironment.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        return 'menu';
      }
      console.log(`\n将为同一测试用户补充 ${manualDepositEnvironment.MANUAL_DEPOSIT_AUTHORIZED_AMOUNT} USD。`);
      const topUp = await runNpmScriptWithResult('test:admin:manual-deposit', {
        environment: {
          ...runtimeEnvironment,
          ...manualDepositEnvironment,
          ALLOW_MONEY_TESTS: 'true',
          ALLOW_ADMIN_MUTATION_TESTS: 'true',
          PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'false'
        },
        quiet: true
      });
      if (topUp.exitCode !== 0) {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：手动入金结果未确认，禁止再次入金，也不会继续开户。');
        console.log(readableFailure(topUp.output));
        return 'menu';
      }
      try {
        preflight = await runJurisdictionOpeningPreflight(runtimeEnvironment);
      } catch (error) {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：入金后余额复核失败，禁止再次入金，也不会继续开户。');
        console.log(error instanceof Error ? error.message : String(error));
        return 'menu';
      }
      if (preflight.status !== 'READY') {
        console.log('\nMANUAL_DEPOSIT_RESULT_UNCONFIRMED：入金后余额仍未满足开户条件，禁止再次入金，也不会继续开户。');
        return 'menu';
      }
      try {
        openingEnvironment = jurisdictionOpeningEnvironment(preflight);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        return 'menu';
      }
      console.log(`补款后余额：${preflight.currentBalance} USD，已满足开户条件。`);
    }

    Object.assign(runtimeEnvironment, openingEnvironment);
    if (runtimeEnvironment.JURISDICTION_OPENING_MODE === 'resume-client-created') {
      console.log(`执行方式：Resume当前${accountName}申请，不重复缴费或安全验证。`);
    } else if (runtimeEnvironment.JURISDICTION_OPENING_MODE === 'resume-security-setup') {
      console.log('执行方式：Resume当前安全密钥设置，不创建第二个开户申请。');
    }
  }

  output.write(`[${step}/${total}] 执行${entry.name}`);
  const startedAt = Date.now();
  const reportMtimeBefore = existsSync(businessReportPath) ? statSync(businessReportPath).mtimeMs : 0;
  const npmScript = selectedNpmScript(entry, runtimeEnvironment);
  if (npmScript === 'test:registration:personal:resume') {
    console.log('\n检测到该邮箱已有未完成个人注册，继续同一账号，不创建新账号。');
  }
  const result = await runNpmScriptWithResult(npmScript, {
    environment: {
      ...mutationEnvironment(entry),
      ...runtimeEnvironment,
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS ?? 'false'
    },
    quiet: true
  });
  console.log(`  ${statusIcon(result.exitCode === 0)}`);
  step += 1;
  output.write(`[${step}/${total}] 生成测试报告`);
  const reportGenerated = existsSync(businessReportPath) && statSync(businessReportPath).mtimeMs > reportMtimeBefore;
  console.log(`  ${statusIcon(reportGenerated)}`);

  const outcome = launcherOutcome(result.exitCode, result.output);

  return finishMenu(
    readline,
    entry,
    outcome,
    ((Date.now() - startedAt) / 1000).toFixed(1),
    result.output,
    reportGenerated
  );
}

async function main(): Promise<void> {
  validateLauncherMenu();
  const readline = createInterface({ input, output });
  try {
    while (true) {
      printMenu();
      const answer = await readline.question('请输入编号：');
      const selected = Number(answer.trim());
      if (answer.trim() === '0') {
        console.log('已退出 Fidere 自动化测试。');
        return;
      }
      if (selected === 98) {
        await refreshAdminAuthentication();
        continue;
      }
      if (selected === 99) {
        if (existsSync(businessReportPath)) openLocalUrl(businessReportPath);
        else console.log('尚未找到最近一次 Fidere 测试报告。');
        continue;
      }
      const entry = getLauncherEntry(selected);
      if (!entry) {
        console.log('无效编号，请重新输入。');
        continue;
      }
      if (await executeSelection(readline, entry) === 'exit') return;
    }
  } finally {
    readline.close();
  }
}

void main().catch(error => {
  console.error(`测试启动器异常退出：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
