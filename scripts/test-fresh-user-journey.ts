import 'dotenv/config';

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  FRESH_USER_JOURNEY_CONFIRMATION,
  FRESH_USER_JOURNEY_ID,
  FRESH_USER_JOURNEY_NAME,
  FRESH_USER_JOURNEY_STEPS
} from '../config/journey-registry.js';
import {
  createFreshUserJourneyAdapters,
  evaluateFreshUserJourneyReadiness,
  FreshUserJourneyContextStore,
  FreshUserJourneyEngine,
  reportFromContext,
  reportFromReadiness,
  writeFreshUserJourneyReport
} from '../src/journey/index.js';
import {
  createLiveEvent,
  LiveRunStore,
  startLiveServer,
  type LiveJourneyFlowStatus,
  type LiveRunStatus
} from '../src/live-monitor/index.js';
import { openLocalUrl } from './cli-utils.js';

type Arguments = {
  readinessOnly: boolean;
  noOpen: boolean;
};

function parseArguments(argv: readonly string[]): Arguments {
  return {
    readinessOnly: argv.includes('--readiness'),
    noOpen: argv.includes('--no-open')
  };
}

function identifier(prefix: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/\D/g, '').slice(0, 17);
  return `${prefix}-${timestamp}-${process.pid}`;
}

function printOverview(): void {
  console.log(`\n${FRESH_USER_JOURNEY_NAME}\n`);
  console.log('将创建：1个Fresh Personal User');
  console.log('预计：Admin KYC Approve、Balance Bootstrap、Exchange、Transfer、Deposit、Withdrawal、Bahrain Opening、US Opening');
  console.log(`初始资金：${process.env.JOURNEY_INITIAL_USD_BALANCE ?? '未配置'} USD`);
  console.log('运行约束：headed=true | workers=1 | retries=0 | repeatEach=1');
}

function printReadiness(): ReturnType<typeof evaluateFreshUserJourneyReadiness> {
  const readiness = evaluateFreshUserJourneyReadiness();
  console.log('\nJourney Readiness Matrix');
  console.log('ID     Flow                                  Requirement  Capability       Journey');
  for (const step of readiness.steps) {
    const line = `${step.id.padEnd(7)}${step.name.padEnd(38)}${step.requirement.padEnd(13)}${step.sourceFlowStatus.padEnd(17)}${step.status}`;
    console.log(line);
    for (const blocker of step.blockers) {
      console.log(`       - ${blocker.code}: ${blocker.reason}`);
    }
  }
  console.log('\n资金预算');
  console.log(`Configured USD：${readiness.budget.configuredUsdBalance ?? 'Missing'}`);
  console.log(`Known Required USD：${readiness.budget.knownRequiredUsd}`);
  console.log(`Safety Margin USD：${readiness.budget.safetyMarginUsd}`);
  console.log(`Estimated Required USD：${readiness.budget.estimatedRequiredUsd}`);
  console.log(`Estimated Shortfall USD：${readiness.budget.knownShortfallUsd ?? 'Unknown'}`);
  if (readiness.budget.blockers.length > 0) {
    readiness.budget.blockers.forEach(blocker => console.log(`- ${blocker}`));
  }
  console.log(`\nOverall Readiness：${readiness.ready ? 'MUTATION_READY' : 'BLOCKED'}`);
  return readiness;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  printOverview();
  const readiness = printReadiness();
  const reportId = identifier(args.readinessOnly ? 'READINESS' : 'PREFLIGHT');

  if (args.readinessOnly || !readiness.ready) {
    const report = reportFromReadiness({
      journeyId: reportId,
      runId: reportId,
      readiness
    });
    const paths = writeFreshUserJourneyReport(report);
    console.log(`Journey报告：${paths.latestHtml}`);
    console.log(`Journey历史：${paths.historyHtml}`);
  }

  if (args.readinessOnly) {
    console.log('Readiness为只读检查；Mutation Count=0。');
    return;
  }
  if (!readiness.ready) {
    console.error('Journey存在明确阻塞，未请求执行确认且未启动任何Flow。');
    process.exitCode = 2;
    return;
  }

  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      `\n确认执行全部${FRESH_USER_JOURNEY_STEPS.length}个步骤请输入 ${FRESH_USER_JOURNEY_CONFIRMATION}：`
    );
    if (answer.trim() !== FRESH_USER_JOURNEY_CONFIRMATION) {
      console.log('未获得精确确认，Journey未执行。');
      return;
    }
  } finally {
    readline.close();
  }

  const liveStore = new LiveRunStore();
  let server: Awaited<ReturnType<typeof startLiveServer>> | undefined;
  try {
    server = await startLiveServer({ store: liveStore });
  } catch (error) {
    console.warn(`Live Monitor不可用，Journey执行逻辑不受影响：${error instanceof Error ? error.message : String(error)}`);
  }
  if (server) {
    console.log(`Live Monitor：${server.url}`);
    if (!args.noOpen) openLocalUrl(server.url);
  }

  const startedAt = new Date();
  liveStore.apply(createLiveEvent(reportId, 'RUN_STARTED', {
    flowId: FRESH_USER_JOURNEY_ID,
    flowName: FRESH_USER_JOURNEY_NAME,
    caseId: FRESH_USER_JOURNEY_ID,
    environment: 'Sandbox',
    startedAt: startedAt.toISOString(),
    resumeState: 'PREPARED',
    mutation: false
  }));

  const adapters = createFreshUserJourneyAdapters({
    headed: true,
    liveMonitorUrl: server?.url,
    liveRunId: reportId
  });
  const contextStore = new FreshUserJourneyContextStore();
  const engine = new FreshUserJourneyEngine(adapters, contextStore, {
    journeyStarted: context => {
      liveStore.apply(createLiveEvent(reportId, 'JOURNEY_STARTED', {
        journeyId: context.journeyId,
        journeyName: FRESH_USER_JOURNEY_NAME,
        flows: FRESH_USER_JOURNEY_STEPS.map(step => ({ id: step.id, name: step.name })),
        initialBalance: readiness.budget.configuredUsdBalance ?? undefined
      }));
    },
    flowStarted: definition => {
      liveStore.apply(createLiveEvent(reportId, 'JOURNEY_FLOW_STARTED', {
        id: definition.id,
        startedAt: new Date().toISOString()
      }));
    },
    flowFinished: (definition, result, context) => {
      const status: Exclude<LiveJourneyFlowStatus, 'PENDING' | 'RUNNING'> =
        result.disposition === 'PASS'
          ? 'PASS'
          : result.disposition.startsWith('SKIPPED_')
            ? 'SKIPPED'
            : result.disposition === 'BLOCKED'
              ? 'BLOCKED'
              : 'FAIL';
      liveStore.apply(createLiveEvent(reportId, 'JOURNEY_FLOW_FINISHED', {
        id: definition.id,
        status,
        reason: result.reason,
        completedAt: new Date().toISOString()
      }));
      liveStore.apply(createLiveEvent(reportId, 'JOURNEY_PROGRESS_UPDATED', {
        currentBalance: context.account.hongKongUsdBalance,
        resumeFlow: context.resumeFlow,
        mutationCount: context.totalMutationCount
      }));
    }
  });
  const missingAdapters = engine.missingAdapters();
  if (missingAdapters.length > 0) {
    if (server) await server.close();
    throw new Error(`Journey adapter coverage changed after Readiness: ${missingAdapters.join(', ')}.`);
  }

  let context = contextStore.create({ journeyId: reportId, runId: reportId });
  let finalStatus: LiveRunStatus = 'FAILED';
  try {
    context = await engine.execute(context);
    const failed = context.flows.some(flow => flow.disposition === 'FAIL');
    const blocked = context.flows.some(flow => flow.disposition === 'BLOCKED');
    finalStatus = context.unknownMutationState
      ? 'BLOCKED'
      : failed
        ? 'FAILED'
        : blocked
          ? 'BLOCKED'
          : 'PASSED';
    const paths = writeFreshUserJourneyReport(reportFromContext({
      context,
      readiness,
      status: finalStatus === 'PASSED' ? 'PASS' : finalStatus === 'BLOCKED' ? 'PAUSED' : 'FAIL'
    }));
    console.log(`Journey报告：${paths.latestHtml}`);
    console.log(`Journey历史：${paths.historyHtml}`);
  } finally {
    const completedAt = new Date();
    liveStore.apply(createLiveEvent(reportId, 'RUN_FINISHED', {
      status: finalStatus,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      exitCode: finalStatus === 'PASSED' ? 0 : 1
    }));
    if (server && input.isTTY) {
      const closer = createInterface({ input, output });
      try {
        await closer.question('\n按Enter关闭Live Monitor：');
      } finally {
        closer.close();
      }
    }
    if (server) await server.close();
  }
  if (finalStatus !== 'PASSED') process.exitCode = 1;
}

void main().catch(error => {
  console.error(`Fresh User Golden Journey启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
