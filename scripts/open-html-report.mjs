import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const relativePath = process.argv[2];

if (!relativePath) {
  console.error('缺少报告路径。');
  process.exit(1);
}

const reportPath = resolve(relativePath);

if (!existsSync(reportPath)) {
  console.error(`报告尚未生成：${relativePath}`);
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
