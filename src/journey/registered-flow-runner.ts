import { spawn } from 'node:child_process';

import { getFlowDefinition } from '../../config/flow-registry';

export type RegisteredFlowRunOptions = {
  environment?: NodeJS.ProcessEnv;
  headed?: boolean;
  liveMonitorUrl?: string;
  liveRunId?: string;
};

export async function runRegisteredFlow(
  flowId: string,
  options: RegisteredFlowRunOptions = {}
): Promise<number> {
  const flow = getFlowDefinition(flowId);
  if (!['Ready', 'Mutation Ready'].includes(flow.capabilityStatus)) {
    throw new Error(`${flow.name} capability is ${flow.capabilityStatus}; Journey cannot execute it.`);
  }
  if (!flow.implemented || !flow.npmScript) {
    throw new Error(`${flow.name} has no implemented registered command.`);
  }
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) throw new Error('Fresh User Journey must be started through npm run.');

  const args = [npmExecPath, 'run', flow.npmScript];
  if (options.headed !== false) args.push('--', '--headed');
  const environment: NodeJS.ProcessEnv = { ...process.env, ...options.environment };
  if (options.liveMonitorUrl && options.liveRunId) {
    environment.FIDERE_LIVE_MONITOR_URL = options.liveMonitorUrl;
    environment.FIDERE_LIVE_RUN_ID = options.liveRunId;
  }

  return new Promise(resolveExitCode => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', () => resolveExitCode(1));
    child.once('exit', code => resolveExitCode(code ?? 1));
  });
}
