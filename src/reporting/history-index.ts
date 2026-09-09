import type { BusinessReportRun } from './business-report.types';
import { formatDuration } from './business-report.utils';

export type BusinessHistoryResult =
  | 'PASS'
  | 'PASS_WITH_WARNING'
  | 'FAIL'
  | 'MANUAL_REVIEW'
  | 'BLOCKED'
  | 'NOT_RUN';

export type BusinessHistoryEntry = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: string;
  projects: string[];
  flowId: string;
  flowName: string;
  command: string;
  modules: string[];
  priorities: string[];
  scopes: string[];
  result: BusinessHistoryResult;
  total: number;
  passed: number;
  passedWithWarning: number;
  failed: number;
  manualReview: number;
  blocked: number;
  skipped: number;
  noMutationPerformed: boolean;
  reportPath: string;
};

export type BusinessHistoryIndex = {
  generatedAt: string;
  total: number;
  runs: BusinessHistoryEntry[];
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function options(values: string[]): string {
  return [...new Set(values)].sort()
    .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join('');
}

function runResult(report: BusinessReportRun): BusinessHistoryResult {
  if (report.summary.manualReview > 0) return 'MANUAL_REVIEW';
  if (report.summary.failed + report.summary.timedOut > 0) return 'FAIL';
  if (report.summary.passedWithWarning > 0) return 'PASS_WITH_WARNING';
  if (report.summary.blocked > 0) return 'BLOCKED';
  if (report.summary.passed > 0) return 'PASS';
  return 'NOT_RUN';
}

export function historyEntryFromReport(
  report: BusinessReportRun,
  reportPath: string
): BusinessHistoryEntry {
  const mainCase = report.cases.find(testCase => !testCase.caseId.startsWith('AUTO-')) ??
    report.cases[report.cases.length - 1];
  const flowId = report.flowId || mainCase?.caseId || 'UNKNOWN';
  const flowName = report.flowName || mainCase?.name || '未识别Flow';
  return {
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt || report.endedAt,
    durationMs: report.durationMs,
    environment: report.environment,
    projects: report.projects,
    flowId,
    flowName,
    command: report.command,
    modules: [...new Set(report.cases.map(testCase => testCase.module))],
    priorities: [...new Set(report.cases.map(testCase => testCase.priority))],
    scopes: [...new Set(report.cases.map(testCase => testCase.scope))],
    result: runResult(report),
    total: report.summary.total,
    passed: report.summary.passed,
    passedWithWarning: report.summary.passedWithWarning,
    failed: report.summary.failed + report.summary.timedOut,
    manualReview: report.summary.manualReview,
    blocked: report.summary.blocked,
    skipped: report.summary.skipped,
    noMutationPerformed: report.cases.every(testCase =>
      !testCase.review.potentiallySubmitted &&
      !testCase.businessData.confirmed
    ),
    reportPath
  };
}

export function renderBusinessHistoryIndex(index: BusinessHistoryIndex): string {
  const rows = index.runs.map(run => {
    const date = run.startedAt.slice(0, 10).replace(/\//g, '-');
    const search = `${run.flowId} ${run.flowName} ${run.command}`.toLowerCase();
    return `<tr class="run-row" data-module="${escapeHtml(run.modules.join('|'))}" data-flow="${escapeHtml(run.flowId)}" data-date="${escapeHtml(date)}" data-result="${escapeHtml(run.result)}" data-priority="${escapeHtml(run.priorities.join('|'))}" data-scope="${escapeHtml(run.scopes.join('|'))}" data-search="${escapeHtml(search)}">
      <td>${escapeHtml(run.startedAt)}</td><td>${escapeHtml(run.runId)}</td>
      <td>${escapeHtml(`${run.flowId} · ${run.flowName}`)}</td><td>${escapeHtml(run.total)}</td>
      <td>${escapeHtml(run.passed)}</td><td>${escapeHtml(run.passedWithWarning)}</td>
      <td>${escapeHtml(run.failed)}</td><td>${escapeHtml(run.manualReview)}</td>
      <td>${escapeHtml(formatDuration(run.durationMs))}</td>
      <td><span class="status ${escapeHtml(run.result)}">${escapeHtml(run.result)}</span></td>
      <td><a href="${escapeHtml(run.reportPath)}">查看</a></td>
    </tr>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidere 自动化测试历史</title><style>
:root{color-scheme:light;--bg:#f4f6f8;--surface:#fff;--text:#20242a;--muted:#667085;--line:#d8dde5;--blue:#175cd3;--green:#16794b;--red:#b42318;--yellow:#8a6100;--orange:#b54708}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Arial,"Microsoft YaHei",sans-serif;letter-spacing:0}.shell{max-width:1600px;margin:0 auto;padding:24px}h1{font-size:28px;margin:0 0 4px}.subtitle{color:var(--muted);margin:0 0 20px}.filters{display:grid;grid-template-columns:1.6fr repeat(6,minmax(130px,1fr));gap:8px;margin-bottom:12px}.filters input,.filters select{height:38px;border:1px solid #b8c0cb;border-radius:5px;background:#fff;padding:0 10px;color:var(--text)}.table-wrap{overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px}table{width:100%;min-width:1250px;border-collapse:collapse}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#edf1f5;color:#394150;font-size:12px}tr:last-child td{border-bottom:0}a{color:var(--blue)}.status{display:inline-block;padding:2px 6px;border-radius:4px;font-weight:700;white-space:nowrap}.PASS{color:var(--green);background:#e8f5ee}.PASS_WITH_WARNING,.MANUAL_REVIEW{color:var(--yellow);background:#fff8d8}.FAIL{color:var(--red);background:#fdecea}.BLOCKED{color:var(--orange);background:#fff1e7}.NOT_RUN{color:var(--muted);background:#eceff2}@media(max-width:900px){.shell{padding:12px}.filters{grid-template-columns:1fr 1fr}}@media(max-width:560px){.filters{grid-template-columns:1fr}}
</style></head><body><main class="shell"><h1>Fidere 自动化测试历史</h1><p class="subtitle">共 ${escapeHtml(index.total)} 次执行 · 索引生成于 ${escapeHtml(index.generatedAt)}</p>
<section class="filters"><input id="search" type="search" placeholder="搜索Run ID、Flow或命令"><select id="module"><option value="">全部模块</option>${options(index.runs.flatMap(run => run.modules))}</select><select id="flow"><option value="">全部Flow</option>${options(index.runs.map(run => run.flowId))}</select><input id="date" type="date"><select id="result"><option value="">全部结果</option>${options(index.runs.map(run => run.result))}</select><select id="priority"><option value="">全部优先级</option>${options(index.runs.flatMap(run => run.priorities))}</select><select id="scope"><option value="">全部范围</option>${options(index.runs.flatMap(run => run.scopes))}</select></section>
<div class="table-wrap"><table><thead><tr><th>执行时间</th><th>Run ID</th><th>测试范围</th><th>总用例</th><th>通过</th><th>警告</th><th>失败</th><th>人工核查</th><th>耗时</th><th>结果</th><th>查看报告</th></tr></thead><tbody>${rows}</tbody></table></div></main>
<script>const ids=['search','module','flow','date','result','priority','scope'];const controls=ids.map(id=>document.getElementById(id));function apply(){const [search,module,flow,date,result,priority,scope]=controls.map(el=>el.value.toLowerCase());document.querySelectorAll('.run-row').forEach(row=>{const includes=(key,value)=>!value||row.dataset[key].toLowerCase().split('|').includes(value);row.hidden=!((!search||row.dataset.search.includes(search))&&includes('module',module)&&(!flow||row.dataset.flow.toLowerCase()===flow)&&(!date||row.dataset.date===date)&&(!result||row.dataset.result.toLowerCase()===result)&&includes('priority',priority)&&includes('scope',scope));});}controls.forEach(control=>control.addEventListener('input',apply));</script></body></html>`;
}
