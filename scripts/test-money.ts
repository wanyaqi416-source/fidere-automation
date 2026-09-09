import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  MONEY_MENU_FLOW_IDS,
  getFlowDefinition
} from '../config/flow-registry.js';
import { confirmMoneyFlow, executeFlowScript } from './cli-utils.js';

const flows = MONEY_MENU_FLOW_IDS.map(getFlowDefinition);

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  try {
    console.log('\n选择资金Flow（每次命令最多启动一条）：\n');
    flows.forEach((flow, index) => console.log(`${index + 1}. ${flow.name}`));
    console.log(`${flows.length + 1}. Exit\n`);
    const answer = await readline.question('请选择：');
    const selected = Number(answer.trim());
    if (selected === flows.length + 1) {
      console.log('未执行资金Flow。');
      return;
    }
    const flow = flows[selected - 1];
    if (!flow) {
      console.log('无效选项，未执行资金Flow。');
      return;
    }
    if (!(await confirmMoneyFlow(flow, readline))) return;
    await executeFlowScript(flow);
  } finally {
    readline.close();
  }
}

void main().catch(error => {
  console.error(`资金Flow菜单异常退出：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

