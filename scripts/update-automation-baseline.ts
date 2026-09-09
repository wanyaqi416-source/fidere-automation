import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  createAutomationBaseline,
  DEFAULT_BASELINE_VERSION,
  renderAutomationBaselineMarkdown
} from '../src/reporting/automation-baseline.js';
import type { BusinessReportRun } from '../src/reporting/business-report.types.js';

const reportPath = resolve('reports/business/latest.json');
const baselinePath = resolve('config/automation-baseline.json');
const documentationPath = resolve('docs/automation-baseline.md');
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BusinessReportRun;
const baseline = createAutomationBaseline(
  report,
  process.env.BASELINE_VERSION?.trim() || DEFAULT_BASELINE_VERSION
);

mkdirSync(dirname(baselinePath), { recursive: true });
mkdirSync(dirname(documentationPath), { recursive: true });
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
writeFileSync(documentationPath, renderAutomationBaselineMarkdown(baseline), 'utf8');

console.log(`Automation baseline updated: ${baseline.version}`);
console.log(`Source regression: ${baseline.sourceRunId} (${baseline.summary.total} cases)`);
