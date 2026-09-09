import { test, expect } from '@playwright/test';
import { AdminShellPage } from '../../pages/admin/AdminShellPage';
import { adminAuthPolicyForRun, ensureAdminAuthentication, shouldRecoverAdminAuth, type AdminAuthStatus } from '../../src/auth/admin-auth-preflight';

const flows = [
  { npmScript: 'test:digital-address', requiresAdmin: true },
  { npmScript: 'test:client:login', requiresAdmin: false }
];
const policy = (command: string, args: string[] = [], environment = {}) => adminAuthPolicyForRun({ command, args, environment, flows });

test('Admin renewal defaults on for local standalone Admin flows, independently of Live', () => {
  expect(shouldRecoverAdminAuth(policy('test:digital-address'))).toBe(true);
  expect(shouldRecoverAdminAuth(policy('test:digital-address', ['--headed']))).toBe(true);
  expect(shouldRecoverAdminAuth(policy('test:client:login'))).toBe(false);
  expect(shouldRecoverAdminAuth(policy('test:client:login', ['--project=workflows']))).toBe(false);
  expect(shouldRecoverAdminAuth(policy('', ['--project=reporting']))).toBe(false);
  expect(shouldRecoverAdminAuth(policy('', ['--project=admin']))).toBe(true);
  expect(shouldRecoverAdminAuth(policy('', ['--project', 'client', 'admin']))).toBe(true);
});

test('CI, safe regression, explicit opt-out and list-only never open login', () => {
  for (const command of ['regression', 'test:regression', 'test:smoke', 'test:validation', 'test:readonly', 'test:dry-run']) {
    expect(shouldRecoverAdminAuth(policy(command, ['--project=admin', '--headed']))).toBe(false);
  }
  for (const environment of [{ CI: 'true' }, { ADMIN_AUTH_AUTO_RENEW: 'false' }]) {
    expect(shouldRecoverAdminAuth(policy('test:digital-address', [], environment))).toBe(false);
  }
  expect(shouldRecoverAdminAuth(policy('test:digital-address', ['--list']))).toBe(false);
});

function lifecycle(statuses: AdminAuthStatus[]) {
  const calls: string[] = [];
  return { calls, hooks: {
    inspect: async () => { calls.push('inspect'); return statuses.shift()!; },
    authenticate: async () => { calls.push('authenticate'); },
    notify: () => { calls.push('notify'); }
  } };
}

test('Valid session never authenticates again', async () => {
  const run = lifecycle(['valid']);
  expect(await ensureAdminAuthentication(run.hooks)).toBe('existing');
  expect(run.calls).toEqual(['inspect']);
});

test('Expired session authenticates once and verifies before allowing tests to begin', async () => {
  const run = lifecycle(['expired', 'valid']);
  expect(await ensureAdminAuthentication(run.hooks)).toBe('renewed');
  expect(run.calls).toEqual(['inspect', 'notify', 'authenticate', 'inspect', 'notify']);
});

test('Unavailable page or network does not trigger interactive authentication', async () => {
  const run = lifecycle(['unavailable']);
  await expect(ensureAdminAuthentication(run.hooks)).rejects.toThrow('ADMIN_AUTH_PREFLIGHT_UNAVAILABLE');
  expect(run.calls).toEqual(['inspect']);
});

test('Failed recovery is bounded to one login and never replays a business test', async () => {
  for (const finalStatus of ['expired', 'unavailable'] as const) {
    const run = lifecycle(['expired', finalStatus]);
    await expect(ensureAdminAuthentication(run.hooks)).rejects.toThrow('ADMIN_AUTH_RECOVERY_UNCONFIRMED');
    expect(run.calls.filter(call => call === 'authenticate')).toHaveLength(1);
  }
  const run = lifecycle(['expired']);
  run.hooks.authenticate = async () => { run.calls.push('authenticate'); throw new Error('captcha incomplete'); };
  await expect(ensureAdminAuthentication(run.hooks)).rejects.toThrow('captcha incomplete');
  expect(run.calls.filter(call => call === 'inspect')).toHaveLength(1);
});

test('Protected-page probe detects login even when the shell had appeared authenticated', async ({ page }) => {
  await page.route('https://admin.sandbox.test/**', route => route.fulfill({
    contentType: 'text/html', body: '<input type="password"><button>Login</button>'
  }));
  expect(await new AdminShellPage(page).inspectAuthentication('https://admin.sandbox.test/zh-CN/login', 2000)).toBe('expired');
});

test('Protected-page probe requires the actual business response and table', async ({ page }) => {
  await page.route('https://admin.sandbox.test/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/member/walletWhitelist/list')) {
      return route.fulfill({ json: { code: 0, data: { total: 0, list: [] } } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<table><thead><tr><th scope="col">白名单ID</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><script>fetch("/member/walletWhitelist/list", {method:"POST"})</script>' });
  });
  expect(await new AdminShellPage(page).inspectAuthentication('https://admin.sandbox.test/zh-CN/login', 2000)).toBe('valid');
});

test('Forbidden business page does not masquerade as expired credentials', async ({ page }) => {
  await page.route('https://admin.sandbox.test/**', route => route.fulfill({ status: 403, body: 'Forbidden' }));
  expect(await new AdminShellPage(page).inspectAuthentication('https://admin.sandbox.test/zh-CN/login', 2000)).toBe('unavailable');
});

test('Cached menu without a successful protected request cannot pass authentication', async ({ page }) => {
  await page.route('https://admin.sandbox.test/**', route => route.fulfill({ contentType: 'text/html', body: '<nav>Dashboard</nav>' }));
  expect(await new AdminShellPage(page).inspectAuthentication('https://admin.sandbox.test/zh-CN/login', 500)).toBe('unavailable');
});
