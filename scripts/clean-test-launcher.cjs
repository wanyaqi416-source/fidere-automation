const { existsSync, realpathSync, rmSync } = require('node:fs');
const { dirname, relative, resolve } = require('node:path');

const workspace = realpathSync(process.cwd());
const target = resolve(workspace, '.tmp', 'test-launcher');
const expectedParent = resolve(workspace, '.tmp');
const relativeTarget = relative(workspace, target);

if (
  dirname(target).toLowerCase() !== expectedParent.toLowerCase() ||
  relativeTarget.startsWith('..') ||
  relativeTarget === ''
) {
  throw new Error(`Refusing to clean an unexpected launcher path: ${target}`);
}

if (existsSync(target)) {
  const resolvedTarget = realpathSync(target);
  if (resolvedTarget.toLowerCase() !== target.toLowerCase()) {
    throw new Error(`Refusing to clean a redirected launcher path: ${resolvedTarget}`);
  }
  rmSync(target, { recursive: true, force: true });
}
