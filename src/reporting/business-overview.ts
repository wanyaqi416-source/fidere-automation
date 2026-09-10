import type { BusinessOracleRecord, BusinessReportCase, BusinessReportRun, BusinessStepRecord } from './business-report.types';

const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const duration = (ms: number): string => ms < 60000 ? `${(ms / 1000).toFixed(1)}秒` : `${Math.floor(ms / 60000)}分${Math.round(ms % 60000 / 1000)}秒`;

// This is a presentation adapter only: original outcomes and counters remain authoritative.
function status(c: BusinessReportCase): { tone: string; label: string } {
  switch (c.businessOutcome) {
    case 'PASS': return { tone: 'pass', label: '✅ 通过' };
    case 'PASS_WITH_WARNING': return { tone: 'warn', label: '⚠️ 通过（有警告）' };
    case 'FAIL': return { tone: 'fail', label: '❌ 失败' };
    case 'MANUAL_REVIEW': return { tone: 'warn', label: '⚠️ 需人工核查' };
    case 'BLOCKED': return { tone: 'warn', label: '⚠️ 阻塞' };
    default: return { tone: 'neutral', label: '未执行' };
  }
}

function plain(value: string, fallback: string): string {
  const text = value.replace(/\bAdmin\b/gi, '管理端').replace(/\bClient\b/gi, '客户端')
    .replace(/\bKYC\b/g, '身份审核').replace(/\bResume\b/gi, '续办')
    .replace(/\bTXN\b/g, '交易编号').replace(/\bTRF\b/g, '转账申请')
    .replace(/上下文预检/g, '信息检查').replace(/认证/g, '身份确认')
    .replace(/^\d+[.、]\s*/, '').replace(/\s*管理端\s*/g, '管理端').replace(/\s*客户端\s*/g, '客户端').trim();
  if (!text || /^(无|未提供)$/.test(text) || !/[\u4e00-\u9fff]/.test(text) ||
      /locator|selector|exception|Error:|expect\(|\bat .+:\d|\{.*\}|[A-Z_]{5,}|https?:|\/api\/|candidateCount/i.test(text)) return fallback;
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function scene(c: BusinessReportCase): string {
  return plain(c.name, plain(c.module, '业务流程验证'))
    .replace(/^原用户转账仅管理端审批续办$/, '用户转账管理端审核（原订单续办）');
}

function businessText(value: string, fallback: string): string {
  const normalized = value
    .replace(/candidateCount\s*=\s*1/gi, '唯一匹配到1条本次业务记录')
    .replace(/candidateCount\s*=\s*0/gi, '未匹配到本次业务记录')
    .replace(/candidateCount\s*=\s*\d+/gi, '业务记录匹配数量异常')
    .replace(/original TXN immutable/gi, '原交易数据保持一致')
    .replace(/\bTXN[-*\w]+/gi, '本次交易编号')
    .replace(/\bTRF[-*\w]+/gi, '本次转账申请编号')
    .replace(/\bHTTP\s*\d{3}\b/gi, '服务响应正常')
    .replace(/\/api\/[\w/-]+/gi, '业务提交请求')
    .replace(/\bResume\b/gi, '续办')
    .replace(/\bAdmin\b/gi, '管理端')
    .replace(/\bClient\b/gi, '客户端');
  return plain(normalized, fallback);
}

type DetailStatus = 'pass' | 'fail' | 'blocked' | 'skipped';
interface BusinessCaseRow {
  scenario: string;
  operations: string[];
  expected: string[];
  actual: string[];
  status: DetailStatus;
}

function detailStatus(testCase: BusinessReportCase, step?: BusinessStepRecord): DetailStatus {
  if (step?.status === 'passed') return 'pass';
  if (step?.status === 'warning') return testCase.businessOutcome === 'PASS_WITH_WARNING' ? 'pass' : 'blocked';
  if (step?.status === 'failed') return ['BLOCKED', 'MANUAL_REVIEW'].includes(testCase.businessOutcome) ? 'blocked' : 'fail';
  if (testCase.businessOutcome === 'PASS' || testCase.businessOutcome === 'PASS_WITH_WARNING') return 'pass';
  if (testCase.businessOutcome === 'FAIL') return 'fail';
  if (testCase.businessOutcome === 'BLOCKED' || testCase.businessOutcome === 'MANUAL_REVIEW') return 'blocked';
  return 'skipped';
}

function scenarioFromAction(testCase: BusinessReportCase, action: string, expected: string): string {
  const operation = businessText(action, scene(testCase))
    .replace(/完整分页/g, '管理端')
    .replace(/原发送方/g, '发送方')
    .replace(/及原交易编号信息检查/g, '及原交易信息')
    .replace(/详情二次核对/g, '详情信息核对')
    .replace(/一次并确认成功/g, '并确认处理结果');
  if (/唯一定位|唯一匹配|查询|搜索/.test(operation)) return `验证管理端能够唯一查询并核对本次${testCase.module.includes('入金') ? '入金申请' : testCase.module.includes('理财') ? '理财申请' : '业务记录'}`;
  if (/批准|审核通过/.test(operation)) return `验证管理端能够正常完成${scene(testCase).replace(/[（(].*?[）)]/g, '')}`;
  if (/拒绝/.test(operation)) return `验证管理端拒绝后${scene(testCase).replace(/[（(].*?[）)]/g, '')}进入正确终态`;
  if (/余额|资金/.test(operation)) return `验证${scene(testCase)}完成后的用户资金变化正确`;
  if (/状态|同步/.test(operation)) return `验证${scene(testCase)}结果能够正确同步`;
  if (/预检|信息检查|身份确认/.test(operation)) return `验证${scene(testCase)}执行前的用户和业务信息满足条件`;
  const expectation = businessText(expected, '该业务步骤应按预期完成');
  return `验证${operation || expectation}`;
}

function operationsFromStep(testCase: BusinessReportCase, step: BusinessStepRecord): string[] {
  const action = businessText(step.action, '执行业务操作').replace(/原发送方/g, '发送方');
  if (/身份确认|信息检查|预检/.test(action)) {
    return [`登录${testCase.dependsOnAdmin ? '管理端并确认审核页面可以正常访问' : '客户端并确认用户状态正常'}`, '确认本次原业务记录及执行信息'];
  }
  if (/唯一定位|唯一匹配|查询|搜索|分页/.test(action)) {
    return [
      `进入${testCase.module.includes('用户转账') || testCase.name.includes('用户转账') ? '用户转账管理' : businessText(testCase.module, '对应业务管理')}页面`,
      '根据原业务编号及本次业务信息查询待处理记录',
      '打开唯一匹配记录并核对用户、方向、币种、金额、费用及状态'
    ];
  }
  if (/批准|审核通过/.test(action)) return ['对唯一匹配的原业务记录执行审核通过', '确认该笔业务的审核结果和最终状态'];
  if (/拒绝/.test(action)) return ['打开唯一匹配的待处理业务记录', '填写拒绝原因并执行拒绝', '确认该笔业务进入拒绝状态'];
  if (/提交|创建/.test(action)) return ['进入对应业务办理页面', businessText(action, '填写业务信息并提交申请'), '确认本次业务申请已经生成'];
  if (/余额|资金/.test(action)) return ['读取业务处理后的账户余额', '根据本次金额和费用核对资金变化'];
  if (/状态|同步/.test(action)) return ['重新进入业务记录页面', '查询原业务记录并核对最终状态'];
  const parts = action.split(/[；;]|(?:，并)|(?:→)/).map(part => part.trim()).filter(Boolean).slice(0, 4);
  return parts.length > 0 ? parts : ['执行业务操作并检查结果'];
}

function detailFromOracle(testCase: BusinessReportCase, oracle: BusinessOracleRecord): BusinessCaseRow {
  const name = businessText(oracle.name, '业务结果验证');
  return {
    scenario: /^验证/.test(name) ? name : `验证${name}`,
    operations: [`检查${name}的最终业务结果`],
    expected: [businessText(oracle.expected, `${name}应符合业务规则`)],
    actual: [businessText(oracle.actual, oracle.status === 'passed' ? `${name}符合预期` : `${name}未达到预期`)],
    status: oracle.status === 'passed' ? 'pass' : oracle.level === 'secondary' && testCase.businessOutcome === 'PASS_WITH_WARNING' ? 'pass' : detailStatus(testCase)
  };
}

function unique(values: string[], limit = 10): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function scenarioForCase(testCase: BusinessReportCase): string {
  const actions = testCase.steps.map(step => step.action).join(' ');
  if (/用户转账/.test(`${testCase.name} ${testCase.module}`) && /批准|审核/.test(actions)) return '验证用户转账申请能够在管理端正确查询并完成审核';
  if (/入金/.test(`${testCase.name} ${testCase.module}`)) return /拒绝/.test(actions) ? '验证客户端提交的法币入金申请被管理端拒绝后状态和余额保持正确' : '验证客户端提交的法币入金申请能够在管理端正确审核并完成到账';
  if (/理财|认购/.test(`${testCase.name} ${testCase.module}`)) return /拒绝/.test(actions) ? '验证理财认购申请被管理端拒绝后客户端状态及资金能够正确恢复' : '验证客户端理财认购申请能够完成管理端审核并正确更新持仓';
  if (/受益人/.test(`${testCase.name} ${testCase.module}`)) return '验证新增受益人及银行账户能够通过管理端审核并正确同步客户端状态';
  if (/注册|KYC|KYB/.test(`${testCase.name} ${testCase.module}`)) return `验证${scene(testCase)}能够完成资料提交、审核及状态同步`;
  return `验证${scene(testCase)}能够按照预期业务流程完成`;
}

function businessCaseRow(testCase: BusinessReportCase): BusinessCaseRow {
  if (testCase.steps.length > 0) return {
    scenario: scenarioForCase(testCase),
    operations: unique(testCase.steps.flatMap(step => operationsFromStep(testCase, step))),
    expected: unique(testCase.steps.map(step => businessText(step.expected, '该业务步骤应按预期完成'))),
    actual: unique(testCase.steps.map(step => businessText(step.actual, step.status === 'passed' ? '该业务步骤已按预期完成' : '该业务步骤未取得预期结果'))),
    status: detailStatus(testCase)
  };
  const primary = testCase.oracles.filter(oracle => oracle.level === 'primary').slice(0, 8);
  if (primary.length > 0) {
    const rows = primary.map(oracle => detailFromOracle(testCase, oracle));
    return {
      scenario: scenarioForCase(testCase),
      operations: unique(rows.flatMap(row => row.operations)),
      expected: unique(rows.flatMap(row => row.expected)),
      actual: unique(rows.flatMap(row => row.actual)),
      status: detailStatus(testCase)
    };
  }
  return {
    scenario: scenarioForCase(testCase),
    operations: ['执行本次业务流程并检查最终结果'],
    expected: [businessText(testCase.expectedResult, '业务流程应按预期完成')],
    actual: [businessText(testCase.failureActual, testCase.businessOutcome === 'PASS' ? '业务流程已按预期完成' : '本次未取得完整业务结果')],
    status: detailStatus(testCase)
  };
}

function resultLabel(value: DetailStatus): string {
  return value === 'pass' ? '✅ 通过' : value === 'fail' ? '❌ 失败' : value === 'blocked' ? '⚠️ 阻塞' : '⏭️ 跳过';
}

export function renderBusinessOverview(report: BusinessReportRun): string {
  const s = report.summary;
  const failed = report.cases.filter(c => c.businessOutcome === 'FAIL');
  const unresolved = report.cases.filter(c => ['BLOCKED', 'MANUAL_REVIEW', 'NOT_RUN'].includes(c.businessOutcome));
  const warnings = report.cases.some(c => c.businessOutcome === 'PASS_WITH_WARNING');
  const review = report.cases.some(c => c.review.manualReviewRequired || c.businessOutcome === 'MANUAL_REVIEW');
  const tone = failed.length ? 'fail' : unresolved.length || warnings || review || !s.total ? 'warn' : 'pass';
  const title = failed.length ? '❌ 测试失败' : review ? '⚠️ 需人工核查' : unresolved.length || !s.total ? '⚠️ 测试阻塞' : warnings ? '⚠️ 测试通过（有警告）' : '✅ 测试通过';
  const conclusion = failed.length ? `失败集中在：${failed.map(scene).join('、')}。建议优先检查下方失败步骤及其业务数据。`
    : review ? '业务结果尚无法确认，请先核查已有业务记录，避免重复操作。'
    : unresolved.length || !s.total ? '存在未完成的验证，暂不能确认全部测试通过。请先解决阻塞或未执行项。'
    : warnings ? '核心业务验证通过，但辅助检查存在异常；请检查下方业务风险提示。'
    : '本次测试范围内的业务验证通过，未发现阻塞性问题或业务异常。';
  const issueCases = report.cases.filter(c => ['FAIL', 'BLOCKED', 'MANUAL_REVIEW'].includes(c.businessOutcome));
  const detailRows = report.cases.map((testCase, index) => {
    const detail = businessCaseRow(testCase);
    const list = (values: string[]) => `<ol class="biz-steps">${values.map(value => `<li>${html(value)}</li>`).join('')}</ol>`;
    return `<tr><td class="biz-index">${index + 1}</td><td>${html(detail.scenario)}</td><td>${list(detail.operations)}</td><td>${list(detail.expected)}</td><td>${list(detail.actual)}</td><td><span class="biz-status ${detail.status}">${resultLabel(detail.status)}</span></td></tr>`;
  }).join('');
  return `<div class="business-overview">
    <header class="biz-header"><h1>Fidere 自动化测试报告</h1><strong class="biz-status ${tone}">${title}</strong>
    <dl class="biz-meta"><div><dt>测试环境</dt><dd>${html(report.environment)}</dd></div><div><dt>测试时间</dt><dd>${html(report.startedAt)}</dd></div><div><dt>测试范围</dt><dd>${html([...new Set(report.cases.map(scene))].join('、') || '暂无用例')}</dd></div><div><dt>总耗时</dt><dd>${duration(report.durationMs)}</dd></div></dl></header>
    <section aria-label="测试概览"><div class="biz-metrics">${[['用例总数', s.total], ['通过', s.passed + s.passedWithWarning], ['失败', s.failed + s.timedOut], ['阻塞', s.blocked], ['通过率', `${s.passRate.toFixed(1)}%`]].map(([label, value]) => `<div><span>${label}</span><b>${value}</b></div>`).join('')}</div>
    ${s.passedWithWarning || s.manualReview || s.skipped + s.interrupted ? `<p class="biz-rate">${s.passedWithWarning ? `其中 ${s.passedWithWarning} 项通过但有警告` : ''}${s.manualReview ? ` · ${s.manualReview} 项需人工核查` : ''}${s.skipped + s.interrupted ? ` · ${s.skipped + s.interrupted} 项跳过或中断` : ''}</p>` : ''}</section>
    <section><h2>测试结果</h2><div class="biz-table-wrap"><table class="biz-results"><thead><tr><th>序号</th><th>测试场景</th><th>测试步骤</th><th>预期结果</th><th>实际结果</th><th>测试结果</th></tr></thead><tbody>${detailRows}</tbody></table></div></section>
    <section class="biz-conclusion ${tone}"><h2>测试结论</h2><strong>${title.replace('测试', '本次测试')}</strong><p>${html(conclusion)}</p></section>
    ${issueCases.length ? `<section><h2>失败与阻塞信息</h2>${issueCases.map(c => `<article class="biz-issue"><h3>${html(scene(c))}</h3><dl>${[['失败步骤', plain(c.failedStep, '业务结果确认')], ['预期结果', plain(c.failureExpected, '完成本场景的业务验证')], ['实际结果', plain(c.failureActual, '未取得足够的预期结果证据，具体技术原因见技术详情')], ['可能影响', c.review.potentiallySubmitted || c.review.duplicateSubmissionRisk ? '业务可能已经提交，请核查原记录，勿直接重复操作。' : '本场景未完成验证，无法确认业务流程正常。']].map(([k, v]) => `<div><dt>${k}</dt><dd>${html(v)}</dd></div>`).join('')}</dl></article>`).join('')}</section>` : ''}
    ${warnings || report.cases.some(c => c.review.duplicateSubmissionRisk) ? `<section><h2>业务风险提示</h2>${report.cases.filter(c => c.businessOutcome === 'PASS_WITH_WARNING' || c.review.duplicateSubmissionRisk).map(c => `<p>${html(scene(c))}：${html(c.review.duplicateSubmissionRisk ? '存在重复提交风险，请先核查已有业务记录。' : c.warnings.map(w => plain(w, '辅助检查异常，详细记录见技术详情')).join('；') || '辅助检查异常，详细记录见技术详情')}</p>`).join('')}</section>` : ''}
  </div>`;
}

export const businessOverviewStyles = `
.biz-metrics{grid-template-columns:repeat(5,minmax(0,1fr))!important}.biz-metrics>div{min-width:0}.biz-metrics>div:last-child b{color:#167347;font-size:28px}#technical-details:not([open])>:not(summary){display:none}@media(max-width:700px){.biz-metrics>div{padding:8px 4px!important}.biz-metrics span{font-size:12px}.biz-metrics>div:last-child b{font-size:21px}}
body{background:#fff}.shell{max-width:1560px;padding:28px 32px}.business-overview{color:#202b28}.business-overview h1{font-size:26px;margin:0}.biz-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #dde4e0;padding-bottom:18px;margin:0}.biz-status{font-weight:700;display:inline-block;white-space:nowrap}.pass{color:#167347}.fail{color:#b42318}.warn,.blocked{color:#a34c08}.skipped,.neutral{color:#606b68}.biz-meta{display:grid;grid-template-columns:1fr 1.5fr 2fr .7fr;gap:20px;flex-basis:100%;margin:0}.biz-meta dt,.biz-issue dt{font-size:12px;color:#63706a}.biz-meta dd{margin:3px 0 0;overflow-wrap:anywhere}.biz-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}.biz-metrics>div{border:1px solid #dde4e0;border-radius:6px;padding:10px 16px}.biz-metrics span{color:#63706a}.biz-metrics b{display:block;font-size:26px}.biz-rate{margin:8px 0;color:#63706a}.business-overview h2{font-size:18px;margin:20px 0 10px}.business-overview h3{font-size:14px;margin:12px 0 6px}.biz-table-wrap{overflow-x:auto;border:1px solid #d9e0dc;border-radius:6px}.biz-results{table-layout:fixed;min-width:1180px;border:0}.biz-results th{background:#f3f6f4;color:#34413b}.biz-results th:nth-child(1){width:4%}.biz-results th:nth-child(2){width:19%}.biz-results th:nth-child(3){width:20%}.biz-results th:nth-child(4){width:21%}.biz-results th:nth-child(5){width:24%}.biz-results th:nth-child(6){width:12%}.biz-results td,.biz-results th{padding:12px 10px;text-align:left;font-size:14px;line-height:1.55}.biz-results td{vertical-align:top}.biz-index{text-align:center!important;color:#63706a}.biz-steps{margin:0;padding-left:20px}.biz-steps li+li{margin-top:4px}.biz-conclusion{border-left:3px solid currentColor;padding:0 16px;margin:20px 0}.biz-conclusion h2{margin:0 0 6px;color:#202b28}.biz-conclusion p{margin:5px 0;color:#48564e}.biz-issue{border-top:1px solid #dde4e0;padding:8px 0}.biz-issue dl{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}.biz-issue dd{margin:3px 0;overflow-wrap:anywhere}#technical-details{border-top:1px solid #d9dee5;margin-top:28px;padding-top:16px}#technical-details>summary{cursor:pointer;font-weight:700;color:#4b5a52;padding:8px 0}#technical-details[open]>summary{margin-bottom:18px}summary:focus-visible{outline:2px solid #175cd3;outline-offset:3px}#technical-details .summary{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:700px){.shell{padding:18px 14px}.business-overview h1{font-size:22px}.biz-meta{grid-template-columns:1fr 1fr;gap:12px}.biz-metrics{gap:6px}.biz-metrics>div{padding:8px}.biz-metrics b{font-size:22px}.biz-results td,.biz-results th{font-size:13px;padding:9px 8px}.biz-issue dl{grid-template-columns:1fr}#technical-details .baseline-grid{grid-template-columns:1fr}#technical-details .summary{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
