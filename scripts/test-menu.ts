import 'dotenv/config';

import { existsSync, statSync } from 'node:fs';
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
import {
  businessReportPath,
  openLocalUrl,
  runNpmScript,
  runNpmScriptWithResult
} from './cli-utils.js';

const line = '='.repeat(48);

function printMenu(): void {
  console.log(`\n${line}`);
  console.log('Fidere 自动化测试');
  console.log(line);
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
  const confirmation = await readline.question('\n确认执行？Y/N：');
  if (!yes(confirmation)) {
    console.log('已取消，本次未执行测试。');
    return 'menu';
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

  output.write(`[${step}/${total}] 执行${entry.name}`);
  const startedAt = Date.now();
  const reportMtimeBefore = existsSync(businessReportPath) ? statSync(businessReportPath).mtimeMs : 0;
  const result = await runNpmScriptWithResult(entry.npmScript, {
    environment: mutationEnvironment(entry),
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
