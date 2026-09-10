import fs from 'node:fs';
import path from 'node:path';
import { renderBusinessReport } from '../src/reporting/html-template';
import type { BusinessReportRun } from '../src/reporting/business-report.types';

// Render beside the source so relative evidence links keep their original meaning.
const source = path.resolve(process.argv[2] ?? '');
if (!source.endsWith('.json')) throw new Error('Provide an existing business report JSON path.');
const report = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')) as BusinessReportRun;
const output = path.join(path.dirname(source), 'business-preview.html');
fs.writeFileSync(output, renderBusinessReport(report), 'utf8');
console.log(`Business preview: ${output}`);
