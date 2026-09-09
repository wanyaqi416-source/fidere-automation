import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';

import {
  FRESH_USER_JOURNEY_NAME,
  type JourneyStepId
} from '../../config/journey-registry';
import { maskRegistrationEmail, maskRegistrationPhone } from '../registration';
import { maskBusinessId } from '../reporting/sensitive-data-mask';
import type { FreshUserJourneyContext, JourneyFlowDisposition } from './journey-context';
import type { FreshUserJourneyReadiness } from './journey-readiness';

export type JourneyReportMode = 'READINESS' | 'EXECUTION';
export type JourneyOverallStatus = 'READY' | 'MUTATION_READY' | 'BLOCKED' | 'RUNNING' | 'PASS' | 'FAIL' | 'PAUSED';

export type JourneyReportFlow = {
  id: JourneyStepId;
  name: string;
  sourceFlowId: string;
  status: JourneyFlowDisposition | 'READY';
  reason?: string;
  reference?: string;
};

export type FreshUserJourneyReport = {
  schemaVersion: 1;
  title: string;
  journeyId: string;
  runId: string;
  mode: JourneyReportMode;
  status: JourneyOverallStatus;
  generatedAt: string;
  mutationCount: number;
  unknownMutationState: boolean;
  user?: {
    displayName?: string;
    email?: string;
    phone?: string;
    kycStatus?: string;
  };
  initialUsdBalance?: string;
  currentUsdBalance?: string;
  currentFlow?: JourneyStepId;
  resumeFlow?: JourneyStepId;
  readiness: FreshUserJourneyReadiness;
  flows: JourneyReportFlow[];
};

export type JourneyReportPaths = {
  latestHtml: string;
  latestJson: string;
  historyHtml: string;
  historyJson: string;
  historyIndex: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusClass(status: string): string {
  if (status === 'PASS' || status === 'READY' || status === 'MUTATION_READY') return 'pass';
  if (status.startsWith('SKIPPED_')) return 'skip';
  if (status === 'BLOCKED') return 'blocked';
  if (status === 'PAUSED' || status === 'MANUAL_REVIEW') return 'paused';
  if (status === 'FAIL') return 'fail';
  return 'pending';
}

function renderFlowRows(report: FreshUserJourneyReport): string {
  return report.flows.map(flow => `
    <tr>
      <td>${escapeHtml(flow.id)}</td>
      <td>${escapeHtml(flow.name)}</td>
      <td><code>${escapeHtml(flow.sourceFlowId)}</code></td>
      <td><span class="state ${statusClass(flow.status)}">${escapeHtml(flow.status)}</span></td>
      <td>${escapeHtml(flow.reason ?? '无')}</td>
    </tr>`).join('');
}

function renderBudgetRows(readiness: FreshUserJourneyReadiness): string {
  return readiness.budget.items.map(item => `
    <tr>
      <td>${escapeHtml(item.flowId)}</td>
      <td>${escapeHtml(item.label)}</td>
      <td>${escapeHtml(item.amount ?? 'Unknown')} ${escapeHtml(item.currency)}</td>
      <td>${escapeHtml(item.direction)}</td>
      <td>${escapeHtml(item.source)}</td>
    </tr>`).join('');
}

function renderReadinessRows(readiness: FreshUserJourneyReadiness): string {
  return readiness.steps.map(step => `
    <tr>
      <td>${escapeHtml(step.id)}</td>
      <td>${escapeHtml(step.name)}</td>
      <td>${escapeHtml(step.sourceFlowStatus)}</td>
      <td>${escapeHtml(step.requirement)}</td>
      <td><span class="state ${step.status === 'READY' ? 'pass' : step.status.startsWith('SKIPPED_') ? 'skip' : 'blocked'}">${escapeHtml(step.status)}</span></td>
      <td>${step.blockers.length > 0
        ? `<ul>${step.blockers.map(blocker => `<li><code>${escapeHtml(blocker.code)}</code> ${escapeHtml(blocker.reason)}</li>`).join('')}</ul>`
        : '无'}</td>
      <td>${escapeHtml(step.affectsFollowing)}</td>
    </tr>`).join('');
}

export function renderFreshUserJourneyReport(report: FreshUserJourneyReport): string {
  const completed = report.flows.filter(flow => flow.status === 'PASS').length;
  const skipped = report.flows.filter(flow => flow.status.startsWith('SKIPPED_')).length;
  const blocked = report.flows.filter(flow => flow.status === 'BLOCKED').length;
  const failed = report.flows.filter(flow => flow.status === 'FAIL').length;
  const environment = report.readiness.environment;
  const user = report.user;
  const globalBlockers = report.readiness.globalBlockers.length > 0
    ? `<ul>${report.readiness.globalBlockers.map(blocker => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul>`
    : '<p>无</p>';
  const budgetBlockers = report.readiness.budget.blockers.length > 0
    ? `<ul>${report.readiness.budget.blockers.map(blocker => `<li>${escapeHtml(blocker)}</li>`).join('')}</ul>`
    : '<p>预算字段完整。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.title)}</title>
  <style>
    :root{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#1e2933;background:#eef1f3;line-height:1.5}
    *{box-sizing:border-box}body{margin:0}main{width:min(1420px,100%);margin:auto;padding:24px}
    header{padding:24px 28px;color:#fff;background:#1e2933;border-bottom:5px solid #d39b20}
    h1,h2,p{margin:0}h1{font-size:24px}h2{font-size:17px}.sub{margin-top:6px;color:#d9e0e4}
    section{margin-top:18px;padding:20px;background:#fff;border:1px solid #d8dee3;border-radius:6px}
    .summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
    .metric{padding:12px;border-left:3px solid #8a969f;background:#f6f8f9}.metric span{display:block;color:#64717b;font-size:11px}.metric strong{font-size:18px}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #e5e9ec}th{color:#54616b;background:#f5f7f8}ul{margin:0;padding-left:18px}
    code{font-family:Consolas,monospace;font-size:12px}.state{display:inline-block;padding:3px 7px;border:1px solid;border-radius:3px;font-size:11px;font-weight:700}.pass{color:#176b46;background:#edf8f2}.blocked,.paused{color:#905500;background:#fff7e8}.fail{color:#a32922;background:#fff1f0}.skip,.pending{color:#586774;background:#f2f5f7}
    .identity{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.identity div{padding:10px;background:#f6f8f9}.identity span{display:block;color:#64717b;font-size:11px}
    @media(max-width:900px){main{padding:12px}.summary,.identity{grid-template-columns:repeat(2,minmax(0,1fr))}table{display:block;overflow:auto}}
  </style>
</head>
<body>
<header><h1>${escapeHtml(report.title)}</h1><p class="sub">${escapeHtml(report.mode)} | ${escapeHtml(report.journeyId)} | ${escapeHtml(report.generatedAt)}</p></header>
<main>
  <section class="summary" aria-label="Journey Summary">
    <div class="metric"><span>Overall</span><strong>${escapeHtml(report.status)}</strong></div>
    <div class="metric"><span>Completed</span><strong>${completed}</strong></div>
    <div class="metric"><span>Skipped</span><strong>${skipped}</strong></div>
    <div class="metric"><span>Blocked</span><strong>${blocked}</strong></div>
    <div class="metric"><span>Failed</span><strong>${failed}</strong></div>
  </section>
  <section><h2>Journey Context</h2><div class="identity">
    <div><span>User</span>${escapeHtml(user?.displayName ?? '尚未创建')}</div>
    <div><span>Email</span>${escapeHtml(user?.email ?? 'N/A')}</div>
    <div><span>Phone</span>${escapeHtml(user?.phone ?? 'N/A')}</div>
    <div><span>KYC</span>${escapeHtml(user?.kycStatus ?? 'N/A')}</div>
    <div><span>Initial USD</span>${escapeHtml(report.initialUsdBalance ?? 'N/A')}</div>
    <div><span>Current USD</span>${escapeHtml(report.currentUsdBalance ?? 'N/A')}</div>
    <div><span>Mutation Count</span>${report.mutationCount}</div>
    <div><span>Resume Flow</span>${escapeHtml(report.resumeFlow ?? 'None')}</div>
  </div></section>
  <section><h2>Journey Flow Results</h2><table><thead><tr><th>ID</th><th>Flow</th><th>Registry Source</th><th>Status</th><th>Reason</th></tr></thead><tbody>${renderFlowRows(report)}</tbody></table></section>
  <section><h2>Journey Readiness Matrix</h2><table><thead><tr><th>ID</th><th>Flow</th><th>Capability</th><th>Requirement</th><th>Readiness</th><th>Reason</th><th>Journey Impact</th></tr></thead><tbody>${renderReadinessRows(report.readiness)}</tbody></table></section>
  <section><h2>资金预算</h2><p>Configured USD: ${escapeHtml(report.readiness.budget.configuredUsdBalance ?? 'Missing')} | Known Required USD: ${escapeHtml(report.readiness.budget.knownRequiredUsd)} | Safety Margin USD: ${escapeHtml(report.readiness.budget.safetyMarginUsd)} | Estimated Required USD: ${escapeHtml(report.readiness.budget.estimatedRequiredUsd)} | Estimated Shortfall USD: ${escapeHtml(report.readiness.budget.knownShortfallUsd ?? 'Unknown')}</p><table><thead><tr><th>Flow</th><th>Item</th><th>Amount</th><th>Direction</th><th>Source</th></tr></thead><tbody>${renderBudgetRows(report.readiness)}</tbody></table>${budgetBlockers}</section>
  <section><h2>Environment Preflight</h2><div class="identity">
    <div><span>Client Host</span>${escapeHtml(environment.clientHost)}</div>
    <div><span>Admin Host</span>${escapeHtml(environment.adminHost)}</div>
    <div><span>Sandbox Guard</span>${environment.sandbox ? 'PASS' : 'FAIL'}</div>
    <div><span>Admin auth file</span>${environment.adminAuthStatePresent ? 'Present' : 'Missing'}</div>
    <div><span>Fresh identities</span>${report.readiness.data.availableFreshIdentityCount}</div>
    <div><span>Recoverable REG-P</span>${report.readiness.data.recoverablePersonalJourneyCount}</div>
    <div><span>Can generate identity</span>${report.readiness.data.canGenerateFreshIdentity ? 'Yes' : 'No'}</div>
    <div><span>Abandoned REG-P</span>${report.readiness.data.abandonedPersonalJourneyCount}</div>
  </div></section>
  <section><h2>Global Blockers</h2>${globalBlockers}</section>
</main>
</body>
</html>`;
}

function safeReport(report: FreshUserJourneyReport): FreshUserJourneyReport {
  return {
    ...report,
    user: report.user ? {
      ...report.user,
      email: report.user.email ? maskRegistrationEmail(report.user.email) : undefined,
      phone: report.user.phone ? maskRegistrationPhone(report.user.phone) : undefined
    } : undefined,
    flows: report.flows.map(flow => ({
      ...flow,
      reference: flow.reference ? maskBusinessId(flow.reference) : undefined
    }))
  };
}

function renderHistoryIndex(root: string): string {
  const rows = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const jsonPath = resolve(root, entry.name, 'report.json');
      if (!existsSync(jsonPath)) return [];
      try {
        const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as FreshUserJourneyReport;
        return [`<tr><td>${escapeHtml(report.generatedAt)}</td><td>${escapeHtml(report.journeyId)}</td><td>${escapeHtml(report.mode)}</td><td>${escapeHtml(report.status)}</td><td><a href="./${encodeURIComponent(entry.name)}/report.html">查看</a></td></tr>`];
      } catch {
        return [];
      }
    })
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Fresh User Journey History</title><style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;margin:28px;color:#24313a}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #dce2e6;text-align:left}th{background:#f3f5f6}</style></head><body><h1>Fresh User Journey History</h1><table><thead><tr><th>时间</th><th>Journey ID</th><th>Mode</th><th>Status</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export function writeFreshUserJourneyReport(
  rawReport: FreshUserJourneyReport,
  outputRoot = resolve('reports', 'journey')
): JourneyReportPaths {
  const report = safeReport(rawReport);
  const historyRoot = resolve(outputRoot, 'history');
  const historyDirectory = resolve(historyRoot, report.journeyId);
  if (existsSync(historyDirectory)) {
    throw new Error(`Journey report history already exists: ${report.journeyId}`);
  }
  mkdirSync(historyDirectory, { recursive: true });
  const html = renderFreshUserJourneyReport(report);
  const json = JSON.stringify(report, null, 2);
  const paths = {
    latestHtml: resolve(outputRoot, 'latest.html'),
    latestJson: resolve(outputRoot, 'latest.json'),
    historyHtml: resolve(historyDirectory, 'report.html'),
    historyJson: resolve(historyDirectory, 'report.json'),
    historyIndex: resolve(historyRoot, 'index.html')
  };
  writeFileSync(paths.historyHtml, html, 'utf8');
  writeFileSync(paths.historyJson, json, 'utf8');
  writeFileSync(paths.latestHtml, html, 'utf8');
  writeFileSync(paths.latestJson, json, 'utf8');
  writeFileSync(paths.historyIndex, renderHistoryIndex(historyRoot), 'utf8');
  return paths;
}

export function reportFromReadiness(input: {
  journeyId: string;
  runId: string;
  readiness: FreshUserJourneyReadiness;
}): FreshUserJourneyReport {
  return {
    schemaVersion: 1,
    title: FRESH_USER_JOURNEY_NAME,
    journeyId: input.journeyId,
    runId: input.runId,
    mode: 'READINESS',
    status: input.readiness.ready ? 'MUTATION_READY' : 'BLOCKED',
    generatedAt: input.readiness.generatedAt,
    mutationCount: 0,
    unknownMutationState: false,
    initialUsdBalance: input.readiness.budget.configuredUsdBalance ?? undefined,
    readiness: input.readiness,
    flows: input.readiness.steps.map(step => ({
      id: step.id,
      name: step.name,
      sourceFlowId: step.flowId,
      status: step.status === 'READY'
        ? 'READY'
        : step.status === 'SKIPPED_PREREQUISITE' ||
            step.status === 'SKIPPED_NOT_READY' ||
            step.status === 'SKIPPED_NOT_APPLICABLE'
          ? step.status
          : 'BLOCKED',
      reason: step.blockers.map(blocker => blocker.reason).join('；') || undefined
    }))
  };
}

export function reportFromContext(input: {
  context: FreshUserJourneyContext;
  readiness: FreshUserJourneyReadiness;
  status: JourneyOverallStatus;
}): FreshUserJourneyReport {
  const { context } = input;
  return {
    schemaVersion: 1,
    title: FRESH_USER_JOURNEY_NAME,
    journeyId: context.journeyId,
    runId: context.runId,
    mode: 'EXECUTION',
    status: input.status,
    generatedAt: new Date().toISOString(),
    mutationCount: context.totalMutationCount,
    unknownMutationState: context.unknownMutationState,
    user: context.user,
    initialUsdBalance: input.readiness.budget.configuredUsdBalance ?? undefined,
    currentUsdBalance: context.account.hongKongUsdBalance,
    currentFlow: context.currentFlow,
    resumeFlow: context.resumeFlow,
    readiness: input.readiness,
    flows: input.readiness.steps.map(step => {
      const record = context.flows.find(flow => flow.id === step.id);
      return {
        id: step.id,
        name: step.name,
        sourceFlowId: step.flowId,
        status: record?.disposition ?? 'PENDING',
        reason: record?.reason
      };
    })
  };
}
