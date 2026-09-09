import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  FLOW_GROUP_REGISTRY,
  FLOW_REGISTRY,
  MONEY_MENU_FLOW_IDS,
  REPORT_ACTIONS,
  SAFE_SUITE_ACTIONS,
  getFlowDefinition
} from '../config/flow-registry.js';
import {
  confirmMoneyFlow,
  executeFlowScript,
  runNpmScript
} from './cli-utils.js';

const moneyFlows = MONEY_MENU_FLOW_IDS.map(getFlowDefinition);

function printMenu(): void {
  console.log('\nFIDERE自动化测试平台\n');
  console.log('【安全回归】');
  for (const action of SAFE_SUITE_ACTIONS) {
    console.log(`${action.menuOrder}. ${action.name} [${action.level}]`);
  }

  console.log('\n【资金E2E】');
  moneyFlows.forEach((flow, index) => {
    console.log(`${index + 6}. ${flow.name} [${flow.status}]`);
  });

  console.log('\n【报告】');
  console.log('10. 最近业务报告');
  console.log('11. 历史报告');
  console.log('12. Playwright技术报告');
  console.log('\n【维护】');
  console.log('13. 查看Flow状态');
  console.log('\n【可视化执行】');
  console.log('14. 实时运行Flow');
  console.log('\n【Journey】');
  console.log('15. Fresh User Golden Journey');
  console.log('\n0. Exit\n');
}

function printFlowStatus(): void {
  console.log('\nFlow状态');
  for (const group of FLOW_GROUP_REGISTRY) {
    console.log(`- ${group.name}: ${group.status} | ${group.description}`);
  }
  for (const flow of FLOW_REGISTRY.filter(item => item.status !== 'Ready')) {
    console.log(`- ${flow.name}: ${flow.status} | ${flow.level} | ${flow.description}`);
  }
}

async function runReport(number: number): Promise<void> {
  const reportId = number === 10
    ? 'business-report'
    : number === 11
      ? 'history-report'
      : 'playwright-report';
  const report = REPORT_ACTIONS.find(item => item.id === reportId);
  if (!report) throw new Error(`报告动作未注册：${reportId}`);
  const exitCode = await runNpmScript(report.npmScript);
  console.log(`${report.name}：${exitCode === 0 ? '完成' : '失败'}`);
}

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  try {
    while (true) {
      printMenu();
      const answer = await readline.question('请选择：');
      const selected = Number(answer.trim());

      if (answer.trim() === '0') {
        console.log('已退出 FIDERE 自动化测试平台。');
        return;
      }
      if (selected >= 1 && selected <= 5) {
        const action = SAFE_SUITE_ACTIONS.find(item => item.menuOrder === selected);
        if (!action) throw new Error(`安全回归动作未注册：${selected}`);
        await runNpmScript(action.npmScript);
        continue;
      }
      if (selected >= 6 && selected <= 9) {
        const flow = moneyFlows[selected - 6];
        if (await confirmMoneyFlow(flow, readline)) await executeFlowScript(flow);
        continue;
      }
      if (selected >= 10 && selected <= 12) {
        await runReport(selected);
        continue;
      }
      if (selected === 13) {
        printFlowStatus();
        continue;
      }
      if (selected === 14) {
        readline.close();
        await runNpmScript('test:live');
        return;
      }
      if (selected === 15) {
        readline.close();
        await runNpmScript('test:journey:fresh-user');
        return;
      }
      console.log('无效选项，请重新输入。');
    }
  } finally {
    readline.close();
  }
}

void main().catch(error => {
  console.error(`测试菜单异常退出：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
