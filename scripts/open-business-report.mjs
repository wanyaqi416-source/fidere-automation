import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const reportPath = resolve('reports/business/latest.html');

if (!existsSync(reportPath)) {
  console.error('尚未生成业务测试报告，请先运行自动化测试。');
  process.exit(1);
}

const commands = {
  win32: ['cmd.exe', ['/d', '/s', '/c', 'start', '', reportPath]],
  darwin: ['open', [reportPath]],
  linux: ['xdg-open', [reportPath]]
};
const command = commands[process.platform] ?? commands.linux;
const child = spawn(command[0], command[1], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true
});

child.unref();
