export type AdminAuthStatus = 'valid' | 'expired' | 'unavailable';

export type AdminAuthPolicy = {
  requiresAdmin: boolean;
  ci: boolean;
  safeSuite: boolean;
  disabled: boolean;
  listOnly: boolean;
};

export function shouldRecoverAdminAuth(policy: AdminAuthPolicy): boolean {
  return policy.requiresAdmin && !policy.ci && !policy.safeSuite && !policy.disabled && !policy.listOnly;
}

export function adminAuthPolicyForRun(input: {
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  flows: readonly { npmScript?: string | null; requiresAdmin: boolean }[];
}): AdminAuthPolicy {
  const projects: string[] = [];
  let collectingProjects = false;
  for (const arg of input.args) {
    if (arg.startsWith('--project=')) {
      projects.push(arg.slice('--project='.length));
      collectingProjects = true;
    } else if (arg === '--project') {
      collectingProjects = true;
    } else if (arg.startsWith('-')) {
      collectingProjects = false;
    } else if (collectingProjects) {
      projects.push(arg);
    }
  }
  const registeredFlows = input.flows.filter(flow => flow.npmScript === input.command);
  return {
    requiresAdmin: registeredFlows.length > 0 ? registeredFlows.some(flow => flow.requiresAdmin) :
      input.command === 'test:admin' || projects.some(project => /^(admin|workflows|opening-workflows|registration-workflows)$/.test(project)),
    ci: Boolean(input.environment.CI),
    safeSuite: ['regression', 'test:regression', 'test:smoke', 'test:validation', 'test:readonly', 'test:dry-run'].includes(input.command),
    disabled: input.environment.ADMIN_AUTH_AUTO_RENEW === 'false',
    listOnly: input.args.includes('--list') || input.args.includes('--help')
  };
}

export async function ensureAdminAuthentication(hooks: {
  inspect(): Promise<AdminAuthStatus>;
  authenticate(): Promise<void>;
  notify(message: string): void;
}): Promise<'existing' | 'renewed'> {
  const before = await hooks.inspect();
  if (before === 'valid') return 'existing';
  if (before !== 'expired') throw new Error('ADMIN_AUTH_PREFLIGHT_UNAVAILABLE: business page/network unavailable; no automatic login or test replay.');
  hooks.notify('Admin认证已失效，自动打开登录窗口。请在浏览器完成验证码；业务测试尚未开始。');
  await hooks.authenticate();
  if (await hooks.inspect() !== 'valid') {
    throw new Error('ADMIN_AUTH_RECOVERY_UNCONFIRMED: protected business page did not verify the new session; tests were not started.');
  }
  hooks.notify('Admin认证已恢复，业务页面验证通过。继续原测试，不新增Run、不重放业务操作。');
  return 'renewed';
}
