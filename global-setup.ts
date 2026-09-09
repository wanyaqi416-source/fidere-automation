import { FLOW_REGISTRY } from './config/flow-registry';
import { env } from './src/config/env';
import { authStatePaths } from './src/config/auth';
import { adminAuthPolicyForRun, ensureAdminAuthentication, shouldRecoverAdminAuth } from './src/auth/admin-auth-preflight';
import { inspectSavedAdminSession } from './src/auth/admin-session';
import { captureAdminAuthentication } from './scripts/capture-admin-auth';

export default async function globalSetup(): Promise<void> {
  if (!shouldRecoverAdminAuth(adminAuthPolicyForRun({
    command: process.env.npm_lifecycle_event ?? '',
    args: process.argv.slice(2),
    environment: process.env,
    flows: FLOW_REGISTRY
  }))) return;
  if (!env.admin.baseUrl) throw new Error('ADMIN_BASE_URL is required for Admin authentication preflight.');
  await ensureAdminAuthentication({
    inspect: () => inspectSavedAdminSession(env.admin.baseUrl!, authStatePaths.admin),
    authenticate: captureAdminAuthentication,
    notify: message => console.log(message)
  });
}
