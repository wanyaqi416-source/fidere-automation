import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Interface } from 'node:readline/promises';

import type { FlowDefinition } from '../config/flow-registry.js';

export const businessReportPath = resolve('reports/business/latest.html');

export function openLocalUrl(url: string): void {
  const command = process.platform === 'win32'
    ? { executable: 'cmd.exe', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { executable: 'open', args: [url] }
      : { executable: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', () => console.warn(`无法自动打开：${url}`));
    child.unref();
  } catch {
    console.warn(`无法自动打开：${url}`);
  }
}

export async function runNpmScript(npmScript: string): Promise<number> {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error('该命令必须通过 npm run 启动。');
  }

  return new Promise(resolveExitCode => {
    const child = spawn(process.execPath, [npmExecPath, 'run', npmScript], {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', () => resolveExitCode(1));
    child.once('exit', code => resolveExitCode(code ?? 1));
  });
}

export function printMoneyFlowPreview(flow: FlowDefinition): void {
  console.log(`\nFlow：${flow.name}`);
  console.log(`账户：${flow.moneyExecution?.account ?? '运行时从配置和页面读取'}`);
  console.log(`币种：${flow.moneyExecution?.currency ?? '运行时从配置和页面读取'}`);
  console.log(`预计Mutation：${flow.moneyExecution?.mutation ?? flow.clientAction}`);
  console.log('安全开关：');
  for (const switchName of flow.safetySwitches) {
    console.log(`- ${switchName}=${process.env[switchName] === 'true' ? 'true' : 'false'}`);
  }
}

export async function confirmMoneyFlow(
  flow: FlowDefinition,
  readline: Interface
): Promise<boolean> {
  printMoneyFlowPreview(flow);
  console.log('\n当前流程会改变Sandbox测试数据或资金余额。');
  const expected = `EXECUTE ${flow.id}`;
  const answer = await readline.question(`确认只执行这一条Flow请输入 ${expected}：`);
  if (answer.trim() !== expected) {
    console.log('未获得精确确认，资金Flow已取消。');
    return false;
  }

  const disabledSwitches = flow.safetySwitches.filter(
    switchName => process.env[switchName] !== 'true'
  );
  if (disabledSwitches.length > 0) {
    console.log(`安全开关 ${disabledSwitches.join('、')} 未开启，资金Flow不会执行。`);
    return false;
  }
  return true;
}

export async function executeFlowScript(flow: FlowDefinition): Promise<void> {
  if (flow.status !== 'Ready' || !flow.implemented || !flow.npmScript) {
    console.log(`${flow.name}当前没有可安全启动的新Run命令：${flow.description}`);
    return;
  }

  const startedAt = Date.now();
  const exitCode = await runNpmScript(flow.npmScript);
  console.log('\n流程执行结果');
  console.log(`流程名称：${flow.name}`);
  console.log(`执行结果：${exitCode === 0 ? '通过' : '失败'}`);
  console.log(`执行耗时：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  console.log(`中文报告：${businessReportPath}`);
}
