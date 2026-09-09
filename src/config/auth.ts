import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export const authStatePaths = {
  client: resolve(process.cwd(), 'auth/client.json'),
  openingClient: resolve(process.cwd(), 'auth/opening-client.json'),
  admin: resolve(process.cwd(), 'auth/admin.json')
} as const;

export function existingAuthState(path: string): string | undefined {
  return existsSync(path) ? path : undefined;
}

type RequiredAuthStateOptions = {
  systemName: string;
  refreshCommand: string;
};

function relativeAuthStatePath(path: string): string {
  return relative(process.cwd(), path).replace(/\\/g, '/');
}

export function requireExistingAuthState(
  path: string,
  options: RequiredAuthStateOptions
): string {
  if (existsSync(path)) {
    return path;
  }

  throw new Error(
    `${options.systemName} storageState is missing at ${relativeAuthStatePath(path)}. ` +
      `Run ${options.refreshCommand} once, complete the manual captcha login, and retry.`
  );
}
