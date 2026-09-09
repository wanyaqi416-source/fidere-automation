import { spawn, type ChildProcess } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';

import {
  FLOW_REGISTRY,
  getFlowDefinition,
  type FlowDefinition
} from '../config/flow-registry.js';
import { env } from '../src/config/env.js';
import {
  createLiveEvent,
  LiveRunStore,
  startLiveServer,
  type LiveRunStatus
} from '../src/live-monitor/index.js';

type LiveArguments = {
  flow?: string;
  noOpen: boolean;
  exitAfterRun: boolean;
  headless: boolean;
};

const flowAliases: Readonly<Record<string, string>> = {
  registration: 'personal-registration'
};

function parseArguments(argv: readonly string[]): LiveArguments {
  const parsed: LiveArguments = {
    noOpen: false,
    exitAfterRun: false,
    headless: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--flow') {
      parsed.flow = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--flow=')) {
      parsed.flow = argument.slice('--flow='.length);
      continue;
    }
    if (argument === '--no-open') parsed.noOpen = true;
    if (argument === '--exit-after-run') parsed.exitAfterRun = true;
    if (argument === '--headless') parsed.headless = true;
  }

  return parsed;
}

function runnableFlows(): FlowDefinition[] {
  return FLOW_REGISTRY
    .filter(flow => flow.implemented && Boolean(flow.npmScript))
    .slice()
    .sort((left, right) => {
      const levelOrder = left.level.localeCompare(right.level);
      return levelOrder || left.name.localeCompare(right.name, 'zh-CN');
    });
}

function resolveFlow(identity: string): FlowDefinition {
  const canonicalIdentity = flowAliases[identity] ?? identity;
  const flow = getFlowDefinition(canonicalIdentity);
  if (!flow.implemented || !flow.npmScript) {
    throw new Error(`${flow.name}尚无可执行命令，Live Monitor不会启动未实现Flow。`);
  }
  return flow;
}

async function selectFlow(readline: Interface): Promise<FlowDefinition> {
  const flows = runnableFlows();
  console.log('\n请选择要实时观察的Flow：\n');
  flows.forEach((flow, index) => {
    const mutation = flow.changesData ? ' | Mutation' : '';
    console.log(`${index + 1}. ${flow.name} [${flow.level}${mutation}]`);
  });
  console.log('0. 退出\n');
  const answer = (await readline.question('请选择：')).trim();
  if (answer === '0') throw new Error('LIVE_MONITOR_USER_EXIT');
  const selected = Number(answer);
  if (!Number.isInteger(selected) || selected < 1 || selected > flows.length) {
    throw new Error(`无效Flow选项：${answer}`);
  }
  return flows[selected - 1];
}

function isMutationFlow(flow: FlowDefinition): boolean {
  return flow.changesData || flow.level === 'L4' || flow.level === 'L5';
}

async function confirmMutationFlow(flow: FlowDefinition, readline: Interface): Promise<void> {
  if (!isMutationFlow(flow)) return;

  console.log('\n该Flow会改变Sandbox业务数据或资金。Live Monitor不会绕过任何Mutation Guard。');
  const expected = `EXECUTE ${flow.id}`;
  const answer = await readline.question(`确认单次执行请输入 ${expected}：`);
  if (answer.trim() !== expected) {
    throw new Error('未获得精确Mutation确认，Flow未启动。');
  }

  const disabled = flow.safetySwitches.filter(name => process.env[name] !== 'true');
  if (disabled.length > 0) {
    throw new Error(`安全开关未开启：${disabled.join('、')}。Live Monitor不会修改.env。`);
  }
}

function runtimeEnvironment(): string {
  const baseUrl = env.client.baseUrl ?? env.admin.baseUrl ?? '';
  if (/sandbox|\.test/i.test(baseUrl)) return 'Sandbox';
  if (/staging/i.test(baseUrl)) return 'Staging';
  if (/localhost|127\.0\.0\.1/i.test(baseUrl)) return 'Local';
  return 'Test';
}

function liveRunId(flow: FlowDefinition): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `LIVE-${flow.id.toUpperCase()}-${timestamp}`;
}

function openDashboard(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', () => {
      console.warn(`Dashboard未能自动打开，请手动访问：${url}`);
    });
    child.unref();
  } catch {
    console.warn(`Dashboard未能自动打开，请手动访问：${url}`);
  }
}

function runFlow(flow: FlowDefinition, monitorUrl: string | undefined, runId: string, headless: boolean): {
  child: ChildProcess;
  completed: Promise<number>;
} {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !flow.npmScript) {
    throw new Error('test:live必须通过npm启动，并且Flow必须注册npmScript。');
  }
  const childArgs = [npmExecPath, 'run', flow.npmScript];
  if (!headless) childArgs.push('--', '--headed');
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  delete childEnvironment.FIDERE_LIVE_MONITOR_URL;
  delete childEnvironment.FIDERE_LIVE_RUN_ID;
  if (monitorUrl) {
    childEnvironment.FIDERE_LIVE_MONITOR_URL = monitorUrl;
    childEnvironment.FIDERE_LIVE_RUN_ID = runId;
  }
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true
  });
  return {
    child,
    completed: new Promise(resolveExitCode => {
      child.once('error', () => resolveExitCode(1));
      child.once('exit', code => resolveExitCode(code ?? 1));
    })
  };
}

function finalStatus(exitCode: number, store: LiveRunStore): LiveRunStatus {
  const current = store.snapshot().status;
  if (current === 'BLOCKED' || current === 'FAILED' || current === 'SKIPPED') return current;
  return exitCode === 0 ? 'PASSED' : 'FAILED';
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const readline = createInterface({ input, output });
  let activeChild: ChildProcess | undefined;
  let server: Awaited<ReturnType<typeof startLiveServer>> | undefined;

  try {
    const flow = args.flow ? resolveFlow(args.flow) : await selectFlow(readline);
    await confirmMutationFlow(flow, readline);

    const store = new LiveRunStore();
    const runId = liveRunId(flow);
    const startedAt = new Date();
    try {
      server = await startLiveServer({ store });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Live Monitor不可用，原Flow仍将继续：${reason}`);
    }
    store.apply(createLiveEvent(runId, 'RUN_STARTED', {
      flowId: flow.id,
      flowName: flow.name,
      caseId: flow.caseId ?? flow.id,
      environment: runtimeEnvironment(),
      startedAt: startedAt.toISOString(),
      resumeState: 'PREPARED',
      mutation: false
    }));

    console.log(server ? '\nFidere Live Run Monitor已启动' : '\nFidere Flow将在无Dashboard模式下执行');
    if (server) console.log(`Dashboard：${server.url}`);
    console.log(`Flow：${flow.name}`);
    console.log(`模式：${args.headless ? 'headless' : 'headed'}`);
    if (server && !args.noOpen) openDashboard(server.url);

    const execution = runFlow(flow, server?.url, runId, args.headless);
    activeChild = execution.child;
    const exitCode = await execution.completed;
    const completedAt = new Date();
    const status = finalStatus(exitCode, store);
    store.apply(createLiveEvent(runId, 'RUN_FINISHED', {
      status,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      exitCode
    }));

    console.log('\nLive Flow执行结束');
    console.log(`结果：${status}`);
    console.log(`耗时：${((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)} 秒`);
    if (server) console.log(`Dashboard：${server.url}`);
    console.log('业务报告：reports/business/latest.html');

    if (server && !args.exitAfterRun && input.isTTY) {
      await readline.question('\n按Enter关闭Live Monitor：');
    }
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'LIVE_MONITOR_USER_EXIT') {
      console.error(`Live Monitor启动失败：${message}`);
      process.exitCode = 1;
    }
  } finally {
    if (activeChild && activeChild.exitCode === null) activeChild.kill();
    if (server) {
      await server.close().catch(() => {
        console.warn('Live Monitor本地服务关闭时出现异常；测试结果不受影响。');
      });
    }
    readline.close();
  }
}

void main();
