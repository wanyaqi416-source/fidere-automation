import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { maskSensitiveText } from './sensitive-data-mask';

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}毫秒`;
  }

  return `${(durationMs / 1_000).toFixed(1)}秒`;
}

export function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  }).format(value);
}

export function timestampForFile(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  }).formatToParts(value);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return `${lookup.year}-${lookup.month}-${lookup.day}_${lookup.hour}-${lookup.minute}-${lookup.second}`;
}

export function safeHostname(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return '未配置';
  }

  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '配置无效';
  }
}

export function safeCommand(): string {
  const lifecycleEvent = process.env.npm_lifecycle_event;
  return lifecycleEvent ? `npm run ${maskSensitiveText(lifecycleEvent)}` : '未提供';
}

export function safeErrorSummary(value: string | undefined): string {
  if (!value) {
    return '未提供';
  }

  return maskSensitiveText(value).split('\n').slice(0, 8).join('\n').slice(0, 2_000);
}

export function existingFileLink(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const absolutePath = resolve(filePath);
  return existsSync(absolutePath) ? pathToFileURL(absolutePath).href : undefined;
}

export function displayPath(filePath: string): string {
  const absolutePath = resolve(filePath);
  const relativePath = relative(process.cwd(), absolutePath);
  return relativePath.startsWith('..') ? absolutePath : relativePath;
}
