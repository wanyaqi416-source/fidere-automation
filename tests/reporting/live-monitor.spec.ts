import { test, expect } from '@playwright/test';
import { request as httpRequest } from 'node:http';

import {
  createLiveEvent,
  LiveMonitorClient,
  LiveRunStore,
  startLiveServer
} from '../../src/live-monitor';
import { CORPORATE_DOCUMENT_MAPPING } from '../../src/registration/corporate-document-mapping';

async function localRequest(input: {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}): Promise<{ status: number; body: string }> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(input.url, {
      method: input.method ?? 'GET',
      agent: false,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      } : undefined
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test.describe('Live Monitor observer contract @readonly @L2', () => {
  test('stores the business timeline and document progress', () => {
    const store = new LiveRunStore();
    const runId = 'LIVE-UNIT-001';
    store.apply(createLiveEvent(runId, 'RUN_STARTED', {
      flowId: 'corporate-registration-upload-dry-run',
      flowName: '企业账户注册Upload Dry Run',
      caseId: 'REG-C-DRY-001',
      environment: 'Sandbox',
      startedAt: '2026-09-02T00:00:00.000Z',
      resumeState: 'RECON_COMPLETED',
      mutation: false
    }));
    store.apply(createLiveEvent(runId, 'STEP_PLAN_UPDATED', {
      steps: [{ id: 'step-001', order: 1, action: '上传公司注册证书', expected: '页面接受PNG' }]
    }));
    store.apply(createLiveEvent(runId, 'STEP_STARTED', {
      id: 'step-001',
      order: 1,
      action: '上传公司注册证书',
      expected: '页面接受PNG',
      currentAction: '上传01_company_registration_certificate_SANDBOX.png',
      startedAt: '2026-09-02T00:00:01.000Z'
    }));
    for (const document of CORPORATE_DOCUMENT_MAPPING) {
      store.apply(createLiveEvent(runId, 'DOCUMENT_PROGRESS_UPDATED', {
        id: document.id,
        field: `${document.step} / ${document.pageLabel}`,
        file: document.asset,
        status: 'PASS',
        actual: '页面已接受文件'
      }));
    }
    store.apply(createLiveEvent(runId, 'STEP_PASSED', {
      id: 'step-001',
      actual: '上传成功',
      durationMs: 1200,
      completedAt: '2026-09-02T00:00:02.200Z'
    }));

    const snapshot = store.snapshot();
    expect(snapshot.status).toBe('RUNNING');
    expect(snapshot.mutationPerformed).toBe(false);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({ status: 'PASS', actual: '上传成功' });
    expect(snapshot.documents).toHaveLength(28);
    expect(snapshot.documents.every(document => document.status === 'PASS')).toBe(true);
    expect(snapshot.documents[0]).toMatchObject({ status: 'PASS', field: '运营信息 / 公司注册证书' });
  });

  test('serves Dashboard state and accepts SSE source events', async () => {
    const store = new LiveRunStore();
    const server = await startLiveServer({ store });
    try {
      const dashboard = await localRequest({ url: server.url });
      expect(dashboard.status).toBe(200);
      expect(dashboard.body).toContain('Fidere 自动化实时执行');

      const event = createLiveEvent('LIVE-UNIT-HTTP', 'RUN_STARTED', {
        flowId: 'client-smoke',
        flowName: '客户端Smoke',
        caseId: 'client-smoke',
        environment: 'Sandbox',
        startedAt: '2026-09-02T00:00:00.000Z',
        resumeState: 'PREPARED',
        mutation: false
      });
      const accepted = await localRequest({
        url: `${server.url}/api/events`,
        method: 'POST',
        body: event
      });
      expect(accepted.status).toBe(204);

      const state = JSON.parse((await localRequest({ url: `${server.url}/api/state` })).body) as {
        flowId: string;
        status: string;
      };
      expect(state).toMatchObject({ flowId: 'client-smoke', status: 'RUNNING' });
    } finally {
      await server.close();
    }
  });

  test('stays a no-op when Live is disabled', async () => {
    const previousUrl = process.env.FIDERE_LIVE_MONITOR_URL;
    const previousRunId = process.env.FIDERE_LIVE_RUN_ID;
    delete process.env.FIDERE_LIVE_MONITOR_URL;
    delete process.env.FIDERE_LIVE_RUN_ID;
    try {
      const client = LiveMonitorClient.fromEnvironment();
      expect(client.enabled).toBe(false);
      client.emit('RESUME_STATE_CHANGED', { state: 'CLIENT_CREATED' });
      await expect(client.flush()).resolves.toBeUndefined();
    } finally {
      if (previousUrl === undefined) delete process.env.FIDERE_LIVE_MONITOR_URL;
      else process.env.FIDERE_LIVE_MONITOR_URL = previousUrl;
      if (previousRunId === undefined) delete process.env.FIDERE_LIVE_RUN_ID;
      else process.env.FIDERE_LIVE_RUN_ID = previousRunId;
    }
  });

  test('disables only the observer when the Dashboard is unavailable', async () => {
    const previousUrl = process.env.FIDERE_LIVE_MONITOR_URL;
    const previousRunId = process.env.FIDERE_LIVE_RUN_ID;
    process.env.FIDERE_LIVE_MONITOR_URL = 'http://127.0.0.1:1';
    process.env.FIDERE_LIVE_RUN_ID = 'LIVE-UNAVAILABLE';
    try {
      const client = LiveMonitorClient.fromEnvironment();
      expect(client.enabled).toBe(true);
      client.emit('RESUME_STATE_CHANGED', { state: 'CLIENT_CREATED' });
      await expect(client.flush()).resolves.toBeUndefined();
      expect(client.enabled).toBe(false);
    } finally {
      if (previousUrl === undefined) delete process.env.FIDERE_LIVE_MONITOR_URL;
      else process.env.FIDERE_LIVE_MONITOR_URL = previousUrl;
      if (previousRunId === undefined) delete process.env.FIDERE_LIVE_RUN_ID;
      else process.env.FIDERE_LIVE_RUN_ID = previousRunId;
    }
  });

  test('publishes an actionable failure without changing mutation state', () => {
    const store = new LiveRunStore();
    const runId = 'LIVE-FAILURE';
    store.apply(createLiveEvent(runId, 'RUN_STARTED', {
      flowId: 'corporate-registration-upload-dry-run',
      flowName: '企业账户注册Upload Dry Run',
      caseId: 'REG-C-DRY-001',
      environment: 'Sandbox',
      startedAt: '2026-09-02T00:00:00.000Z',
      resumeState: 'RECON_COMPLETED',
      mutation: false
    }));
    store.apply(createLiveEvent(runId, 'STEP_PLAN_UPDATED', {
      steps: [{ id: 'step-001', order: 1, action: '上传董事身份证明', expected: '找到上传字段' }]
    }));
    store.apply(createLiveEvent(runId, 'STEP_FAILED', {
      id: 'step-001',
      expected: '找到上传字段',
      actual: 'Locator count = 0',
      error: 'Element not found',
      durationMs: 200,
      completedAt: '2026-09-02T00:00:00.200Z',
      currentUrl: 'https://sandbox.example.test/zh-CN/registration',
      mutationPerformed: false,
      resumeAllowed: true,
      freshRunAllowed: true
    }));

    expect(store.snapshot()).toMatchObject({
      status: 'FAILED',
      mutationPerformed: false,
      failure: {
        step: '上传董事身份证明',
        actual: 'Locator count = 0',
        resumeAllowed: true,
        freshRunAllowed: true
      }
    });
  });

  test('keeps Journey progress while child Flow events update details', () => {
    const store = new LiveRunStore();
    const runId = 'LIVE-JOURNEY-001';
    store.apply(createLiveEvent(runId, 'RUN_STARTED', {
      flowId: 'fresh-user-journey',
      flowName: 'Fresh User Golden Journey v1',
      caseId: 'fresh-user-journey',
      environment: 'Sandbox',
      startedAt: '2026-09-03T00:00:00.000Z',
      resumeState: 'PREPARED',
      mutation: false
    }));
    store.apply(createLiveEvent(runId, 'JOURNEY_STARTED', {
      journeyId: 'JOURNEY-001',
      journeyName: 'Fresh User Golden Journey v1',
      flows: [
        { id: 'J-001', name: 'Fresh Personal Registration' },
        { id: 'J-002', name: 'Admin Personal KYC Approve' }
      ],
      initialBalance: '2000 USD'
    }));
    store.apply(createLiveEvent(runId, 'JOURNEY_FLOW_STARTED', {
      id: 'J-001',
      startedAt: '2026-09-03T00:00:01.000Z'
    }));
    store.apply(createLiveEvent(runId, 'CASE_STARTED', {
      flowId: 'personal-registration',
      flowName: '个人用户注册完整闭环',
      caseId: 'REG-P-002',
      startedAt: '2026-09-03T00:00:01.100Z',
      mutation: true
    }));
    store.apply(createLiveEvent(runId, 'JOURNEY_FLOW_FINISHED', {
      id: 'J-001',
      status: 'PASS',
      completedAt: '2026-09-03T00:01:00.000Z'
    }));
    store.apply(createLiveEvent(runId, 'JOURNEY_PROGRESS_UPDATED', {
      currentBalance: '2000 USD',
      mutationCount: 1
    }));

    expect(store.snapshot()).toMatchObject({
      flowId: 'personal-registration',
      journey: {
        journeyId: 'JOURNEY-001',
        currentBalance: '2000 USD',
        mutationCount: 1,
        flows: [
          { id: 'J-001', status: 'PASS' },
          { id: 'J-002', status: 'PENDING' }
        ]
      }
    });
  });
});
