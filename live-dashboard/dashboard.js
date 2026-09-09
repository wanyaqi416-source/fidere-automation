const byId = id => document.getElementById(id);
let state;
let connected = false;

const statusLabels = {
  IDLE: '等待启动', RUNNING: '运行中', PASSED: '通过', FAILED: '失败', BLOCKED: '阻塞', SKIPPED: '跳过'
};
const stepLabels = {
  PENDING: 'PENDING', RUNNING: 'RUNNING', PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED', SKIPPED: 'SKIPPED'
};
const businessLabels = {
  accountType: '账户类型', currentRegistrationStep: '当前注册Step', uploadedDocumentCount: '已上传文件数',
  totalDocumentCount: '文件总数', directorCount: 'Director数量', shareholderCount: 'Shareholder数量',
  uboCount: 'UBO数量', remainingRequiredFields: '剩余必填字段', signingStatus: '签署状态',
  currency: '币种', amount: '金额', fee: '手续费', beforeBalance: '操作前余额', afterBalance: '操作后余额',
  clientReference: 'Client业务编号', adminCandidateCount: 'Admin候选数', adminStatus: 'Admin状态', clientStatus: 'Client状态'
};
const signingKeys = {
  signingType: 'Signing Type', initialFields: 'Initial Fields', currentFields: 'Current Fields',
  signatureStatus: 'Signature', authorizationStatus: 'Authorization', documensoCompleted: 'Documenso'
};

function text(id, value) {
  byId(id).textContent = value === undefined || value === null || value === '' ? '-' : String(value);
}

function duration(ms) {
  return `${((ms ?? 0) / 1000).toFixed(1)} 秒`;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function renderSummary(snapshot) {
  text('flow-name', snapshot.flowName);
  text('case-id', snapshot.caseId);
  text('environment', snapshot.environment);
  text('run-id', snapshot.runId);
  text('started-at', formatTime(snapshot.startedAt));
  text('resume-state', snapshot.resumeState);
  text('mutation', snapshot.mutationPerformed ? 'Yes' : 'No');
  const status = byId('run-status');
  status.textContent = statusLabels[snapshot.status] ?? snapshot.status;
  status.className = `status-badge status-${snapshot.status.toLowerCase()}`;
  text('completion-title', snapshot.status === 'RUNNING' ? '测试执行中' : `测试完成：${statusLabels[snapshot.status] ?? snapshot.status}`);
}

function renderTimeline(snapshot) {
  const timeline = byId('timeline');
  timeline.replaceChildren();
  byId('timeline-empty').classList.toggle('hidden', snapshot.steps.length > 0);
  const completed = snapshot.steps.filter(step => ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED'].includes(step.status)).length;
  text('step-count', `${completed} / ${snapshot.steps.length}`);

  for (const step of snapshot.steps) {
    const item = document.createElement('li');
    item.className = `timeline-item ${step.status.toLowerCase()}`;
    const marker = document.createElement('span');
    marker.className = 'timeline-marker';
    marker.textContent = step.status === 'PASS' ? 'OK' : String(step.order).padStart(2, '0');
    const row = document.createElement('div');
    row.className = 'timeline-title-row';
    const title = document.createElement('span');
    title.className = 'timeline-title';
    title.textContent = step.action;
    const status = document.createElement('span');
    status.className = 'timeline-status';
    status.textContent = stepLabels[step.status] ?? step.status;
    row.append(title, status);
    const expected = document.createElement('p');
    expected.className = 'timeline-expected';
    expected.textContent = step.status === 'PENDING' ? step.expected : step.actual;
    item.append(marker, row, expected);
    timeline.append(item);
  }
}

function renderCurrent(snapshot) {
  const current = snapshot.steps.find(step => step.id === snapshot.currentStepId) ??
    [...snapshot.steps].reverse().find(step => step.status !== 'PENDING');
  if (!current) return;
  text('current-step', current.action);
  text('current-action', current.currentAction || current.action);
  text('current-expected', current.expected);
  text('current-actual', current.actual);
  text('current-duration', duration(current.durationMs ?? (current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : 0)));
  text('current-step-state', stepLabels[current.status] ?? current.status);
}

function renderFailure(snapshot) {
  const panel = byId('failure-panel');
  panel.classList.toggle('hidden', !snapshot.failure);
  if (!snapshot.failure) return;
  text('failure-step', snapshot.failure.step);
  text('failure-expected', snapshot.failure.expected);
  text('failure-actual', snapshot.failure.actual);
  text('failure-error', snapshot.failure.technicalError);
  text('failure-url', snapshot.failure.currentUrl);
  text('failure-resume', snapshot.failure.resumeAllowed ? 'Allowed' : 'Not allowed');
  text('failure-fresh', snapshot.failure.freshRunAllowed ? 'Allowed' : 'Not allowed');
}

function renderData(snapshot) {
  const root = byId('business-data');
  root.replaceChildren();
  const entries = Object.entries(snapshot.businessData).filter(([key]) => businessLabels[key]);
  byId('business-data-empty').classList.toggle('hidden', entries.length > 0);
  for (const [key, value] of entries) {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const data = document.createElement('dd');
    label.textContent = businessLabels[key];
    data.textContent = Array.isArray(value) ? value.join('、') : String(value);
    row.append(label, data);
    root.append(row);
  }

  const signingEntries = Object.entries(snapshot.businessData).filter(([key]) => signingKeys[key]);
  const signingPanel = byId('signing-panel');
  signingPanel.classList.toggle('hidden', signingEntries.length === 0);
  const signingRoot = byId('signing-data');
  signingRoot.replaceChildren();
  for (const [key, value] of signingEntries) {
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const data = document.createElement('dd');
    label.textContent = signingKeys[key];
    data.textContent = String(value);
    row.append(label, data);
    signingRoot.append(row);
  }
}

function renderDocuments(snapshot) {
  const root = byId('document-list');
  root.replaceChildren();
  const completed = snapshot.documents.filter(document => document.status === 'PASS').length;
  text('document-count', `${completed} / ${snapshot.documents.length}`);
  byId('document-progress-bar').style.width = snapshot.documents.length ? `${completed / snapshot.documents.length * 100}%` : '0%';
  byId('document-empty').classList.toggle('hidden', snapshot.documents.length > 0);
  for (const documentState of snapshot.documents) {
    const item = document.createElement('div');
    item.className = `document-item ${documentState.status.toLowerCase()}`;
    const indicator = document.createElement('span');
    indicator.className = 'document-indicator';
    const content = document.createElement('div');
    const field = document.createElement('span');
    field.className = 'document-field';
    field.textContent = documentState.field;
    const file = document.createElement('span');
    file.className = 'document-file';
    file.textContent = documentState.file;
    content.append(field, file);
    item.append(indicator, content);
    root.append(item);
  }
}

function renderJourney(snapshot) {
  const journey = snapshot.journey;
  const panel = byId('journey-panel');
  panel.classList.toggle('hidden', !journey);
  if (!journey) return;
  text('journey-name', journey.journeyName);
  const completed = journey.flows.filter(flow => ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED'].includes(flow.status)).length;
  text('journey-count', `${completed} / ${journey.flows.length}`);
  text('journey-current-flow', journey.currentFlowId ?? '-');
  text('journey-current-balance', journey.currentBalance ?? journey.initialBalance ?? '-');
  text('journey-resume-flow', journey.resumeFlow ?? '-');
  text('journey-mutation-count', journey.mutationCount);
  const timeline = byId('journey-timeline');
  timeline.replaceChildren();
  for (const flow of journey.flows) {
    const item = document.createElement('li');
    item.className = `journey-flow ${flow.status.toLowerCase()}`;
    const id = document.createElement('strong');
    id.textContent = flow.id;
    const name = document.createElement('span');
    name.textContent = flow.name;
    const status = document.createElement('small');
    status.textContent = flow.status;
    item.append(id, name, status);
    if (flow.reason) item.title = flow.reason;
    timeline.append(item);
  }
}

function render(snapshot) {
  state = snapshot;
  renderSummary(snapshot);
  renderTimeline(snapshot);
  renderCurrent(snapshot);
  renderFailure(snapshot);
  renderData(snapshot);
  renderDocuments(snapshot);
  renderJourney(snapshot);
}

function renderElapsed() {
  if (!state?.startedAt) return;
  const end = state.completedAt ? new Date(state.completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(state.startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  text('elapsed', `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`);
  renderCurrent(state);
}

function setConnection(status) {
  connected = status === 'connected';
  const root = document.querySelector('.connection');
  root.className = `connection ${status}`;
  text('connection-label', status === 'connected' ? '实时连接' : status === 'disconnected' ? '连接中断' : '正在连接');
}

fetch('/api/state', { cache: 'no-store' }).then(response => response.json()).then(render).catch(() => setConnection('disconnected'));
const source = new EventSource('/events');
source.addEventListener('open', () => setConnection('connected'));
source.addEventListener('state', event => render(JSON.parse(event.data)));
source.addEventListener('error', () => setConnection(connected ? 'disconnected' : 'connecting'));
setInterval(renderElapsed, 250);
