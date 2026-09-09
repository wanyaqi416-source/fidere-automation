import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const roots = ['reports/business', 'test-results', 'playwright-report'];
const textExtensions = new Set(['.html', '.json', '.md', '.txt', '.xml']);
const signingPath = /(\/embed\/sign\/)[A-Za-z0-9_-]+/g;
let filesUpdated = 0;
let valuesRedacted = 0;

function redactFile(path: string): void {
  if (!textExtensions.has(extname(path).toLowerCase())) return;
  const original = readFileSync(path, 'utf8');
  let replacements = 0;
  const redacted = original.replace(signingPath, (_match, prefix: string) => {
    replacements += 1;
    return `${prefix}:token`;
  });
  if (replacements === 0) return;
  writeFileSync(path, redacted, 'utf8');
  filesUpdated += 1;
  valuesRedacted += replacements;
}

function walk(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    redactFile(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    walk(resolve(path, entry.name));
  }
}

for (const root of roots) walk(resolve(root));
console.log(JSON.stringify({ filesUpdated, valuesRedacted }));
