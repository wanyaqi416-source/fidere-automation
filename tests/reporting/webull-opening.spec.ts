import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebullOpeningPage } from '../../pages/client/WebullOpeningPage';
import { WebullDocumentSigner } from '../../pages/client/WebullDocumentSigner';
import { getFlowDefinition } from '../../config/flow-registry';
import { matchWebullOpening } from '../../src/journey/tiger-opening';
import { assessWebullFunding, assertWebullDocumentsReady, nextWebullSigningStep,
  getWebullSignerIdentity, readWebullSigningResult, WEBULL_DOCUMENTS, type WebullDocumentEvidence } from '../../src/journey/webull-opening';

test('Webull native existing-sign result exposes no signing token or URL', () => {
  const result = readWebullSigningResult({ data: { data: { signed: true, documentId: 123,
    token: 'private-fixture-token', signingUrl: 'https://app.documenso.com/private-fixture-token' } } });
  expect(result.signed).toBe(true);
  expect(result.documentReference).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain('private-fixture-token');
  for (const body of [null, {}, { data: { signed: false } }, { data: { signed: 'false' } }]) {
    expect(readWebullSigningResult(body).signed).toBe(false);
  }
});

test('Webull restores a previously signed document through native UI without another Sign', async ({ page }) => {
  await page.route('https://sandbox.fidere.test/**', async route => {
    if (route.request().url().endsWith('/brokerage/init-sign')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { signed: true, documentId: 'original-w8' } }) });
    } else {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<section id="task"><p>W-8BEN 表格</p><button id="open">去签署</button></section>
        <script>document.getElementById('open').onclick=async()=>{
          await fetch('/api/brokerage/init-sign',{method:'POST'});
          document.getElementById('task').innerHTML='<p>W-8BEN 表格</p><span>已完成</span><button disabled>已签署</button>';
          const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
          dialog.innerHTML='<p>W-8BEN 表格</p><h2>你已完成签署</h2><p>第三方签署已确认</p><button>关闭</button>';
          dialog.querySelector('button').onclick=()=>dialog.remove();document.body.append(dialog);
        };</script>` });
    }
  });
  await page.goto('https://sandbox.fidere.test/broker');
  const opening = new WebullOpeningPage(page);
  expect((await opening.restoreExistingSignedDocument('w8ben')).signed).toBe(true);
  expect((await opening.readDocumentState('w8ben')).completed).toBe(true);
  expect(opening.confirmationClickCount()).toBe(0);
  await expect(opening.restoreExistingSignedDocument('w8ben')).rejects.toThrow('once');
});

test('Webull signature configuration is validated before document actions', () => {
  expect(getWebullSignerIdentity({ signatureText: 'TEST', initials: 'T' })).toEqual({ signatureText: 'TEST', initials: 'T' });
  expect(() => getWebullSignerIdentity({ signatureText: 'TEST', initials: undefined })).toThrow('before opening');
  expect(() => getWebullSignerIdentity({ signatureText: undefined, initials: 'T' })).toThrow('before opening');
});

test('Webull preflight excludes stale results belonging to another user', () => {
  const input = { email: 'ah@example.test', displayName: 'TEST SANDBOX AH' };
  const row = { customerText: 'OTHER USER other@example.test', accountType: '个人', broker: 'webull（Webull 微牛证券）',
    submittedAt: '2026-09-09 11:30', status: '待处理', reference: '22' };
  expect(matchWebullOpening([row], input).candidates.length).toBe(0);
  const target = { ...row, customerText: `${input.displayName} ${input.email}` };
  expect(matchWebullOpening([row, target], input).candidates.length).toBe(1);
  expect(matchWebullOpening([target, { ...target, reference: '23' }], input).candidates.length).toBe(2);
});

test('Webull reads the existing OPENING_INITIALS key without changing other signer configuration', () => {
  const original = { signature: process.env.OPENING_SIGNATURE_TEXT, initials: process.env.OPENING_INITIALS };
  try {
    process.env.OPENING_SIGNATURE_TEXT = 'TEST';
    process.env.OPENING_INITIALS = 'T';
    expect(getWebullSignerIdentity()).toEqual({ signatureText: 'TEST', initials: 'T' });
  } finally {
    if (original.signature === undefined) delete process.env.OPENING_SIGNATURE_TEXT;
    else process.env.OPENING_SIGNATURE_TEXT = original.signature;
    if (original.initials === undefined) delete process.env.OPENING_INITIALS;
    else process.env.OPENING_INITIALS = original.initials;
  }
});

const completed = (): WebullDocumentEvidence[] => WEBULL_DOCUMENTS.map(document => ({ id: document.id,
  documentReference: `sandbox-document-${document.id}`, remainingFields: 0, signatureCompleted: true,
  completeClicks: 1, signClicks: 1, providerCompleted: true, fidereCompleted: true }));

test('Webull requires both documents and distinguishes their real references', () => {
  expect(() => assertWebullDocumentsReady(completed())).not.toThrow();
  expect(() => assertWebullDocumentsReady(completed().slice(0, 1))).toThrow('Both');
  expect(() => assertWebullDocumentsReady([completed()[0], completed()[0]])).toThrow('separate');
  const documents = completed();
  documents[1].documentReference = documents[0].documentReference;
  expect(() => assertWebullDocumentsReady(documents)).toThrow('share');
});

for (const field of ['remainingFields', 'signatureCompleted', 'completeClicks', 'signClicks', 'providerCompleted', 'fidereCompleted'] as const) {
  test(`Webull blocks missing ${field} on either document`, () => {
    for (const index of [0, 1]) {
      const documents = completed();
      const values = { remainingFields: 1, signatureCompleted: false, completeClicks: 0, signClicks: 0,
        providerCompleted: false, fidereCompleted: false };
      Object.assign(documents[index], { [field]: values[field] });
      expect(() => assertWebullDocumentsReady(documents)).toThrow();
    }
  });
}

test('Webull Resume skips the completed first document and never repeats uncertain final Sign', () => {
  expect(nextWebullSigningStep([])).toEqual({ documentId: 'w8ben', action: 'OPEN_DOCUMENT' });
  expect(nextWebullSigningStep(completed().slice(0, 1))).toEqual({ documentId: 'crs-controller', action: 'OPEN_DOCUMENT' });
  const documents = completed();
  documents[1].fidereCompleted = false;
  expect(nextWebullSigningStep(documents)).toEqual({ documentId: 'crs-controller', action: 'READONLY_RECONCILIATION' });
  expect(nextWebullSigningStep(completed())).toEqual({ action: 'DOCUMENTS_READY' });
});

test('Webull preserves a prepared signature instead of redrawing it on Resume', () => {
  const document = { ...completed()[0], completeClicks: 0, signClicks: 0, providerCompleted: false, fidereCompleted: false };
  expect(nextWebullSigningStep([document])).toEqual({ documentId: 'w8ben', action: 'COMPLETE' });
  document.completeClicks = 1;
  expect(nextWebullSigningStep([document])).toEqual({ documentId: 'w8ben', action: 'CONFIRM_SIGN' });
  document.remainingFields = 1;
  expect(nextWebullSigningStep([document]).action).toBe('READONLY_RECONCILIATION');
});

test('Webull rejects repeated final signing and invalid field evidence', () => {
  for (const changed of [{ signClicks: 2 }, { completeClicks: 2 }, { remainingFields: -1 }, { remainingFields: 0.5 }]) {
    expect(() => assertWebullDocumentsReady([{ ...completed()[0], ...changed }, completed()[1]])).toThrow('Invalid');
  }
});

test('Webull funding uses exact Decimal values and signals a separate deposit prerequisite', () => {
  expect(assessWebullFunding({ available: '894.62', fee: '100.00', currency: 'USD' })).toMatchObject({ status: 'BALANCE_READY', shortfall: '0' });
  expect(assessWebullFunding({ available: '99.99', fee: '100', currency: 'USD' })).toMatchObject({ status: 'FUNDING_REQUIRED', shortfall: '0.01' });
  expect(assessWebullFunding({ available: '0.3', fee: '0.3', currency: 'USD' }).status).toBe('BALANCE_READY');
  for (const fee of ['NaN', 'Infinity', '0', '-1']) expect(() => assessWebullFunding({ available: '1', fee, currency: 'USD' })).toThrow();
  expect(() => assessWebullFunding({ available: '100', fee: '1', currency: 'HKD' })).toThrow('currency');
});

test('Webull locates by document label even with reordered identical signing buttons', async ({ page }) => {
  await page.setContent('<main><section><p>CRS 控制人表格</p><button data-id="crs">去签署</button></section><section><p>W-8BEN 表格</p><button data-id="w8">去签署</button></section></main>');
  const webull = new WebullOpeningPage(page);
  await expect(await webull.signingEntry('w8ben')).toHaveAttribute('data-id', 'w8');
  await expect(await webull.signingEntry('crs-controller')).toHaveAttribute('data-id', 'crs');
});

test('Webull does not take a sibling document action when its own button is missing', async ({ page }) => {
  await page.setContent('<main><p>W-8BEN 表格</p><section><p>CRS 控制人表格</p><button>去签署</button></section></main>');
  await expect(new WebullOpeningPage(page).signingEntry('w8ben')).rejects.toThrow('No unique');
});

test('Webull preflight stays read-only and verified E2E remains opt-in', () => {
  const preflight = getFlowDefinition('webull-broker-opening-dry-run');
  expect(preflight.changesData || preflight.affectsMoney).toBe(false);
  const e2e = getFlowDefinition('webull-broker-opening');
  expect(e2e.realE2EVerified).toBe(true);
  expect(e2e.status).toBe('Ready');
  expect(e2e.defaultRegression).toBe(false);
  expect(e2e.safetySwitches).toEqual(expect.arrayContaining(['ALLOW_CLIENT_MUTATION_TESTS', 'ALLOW_MONEY_TESTS', 'ALLOW_ADMIN_MUTATION_TESTS']));
  expect(e2e.requiresThirdParty && e2e.requiresSecurityKey).toBe(true);
});

test('Webull never imports another business concrete signer', () => {
  const source=readFileSync(resolve('pages/client/WebullDocumentSigner.ts'),'utf8');
  const imports=source.match(/^import[^;]+;/gm) ?? [];
  expect(imports.join('\n')).not.toMatch(/DocumentSigningPage|RegistrationAgreementSigner|Corporate.*Signer/);
});

test('Webull completion belongs to its own document, not its sibling', async ({page}) => {
  await page.setContent('<main><section><p>CRS 控制人表格</p><button>去签署</button></section><section><p>W-8BEN 表格</p><span>已完成</span><button disabled>已签署</button></section></main>');
  const opening=new WebullOpeningPage(page);
  expect((await opening.readDocumentState('w8ben')).completed).toBe(true);
  expect((await opening.readDocumentState('crs-controller')).completed).toBe(false);
});

test('Webull independent signer selects the correct page of a three-page CRS document', async ({page}) => {
  const previous={signature:process.env.OPENING_SIGNATURE_TEXT,initials:process.env.OPENING_INITIALS,mutation:process.env.ALLOW_CLIENT_MUTATION_TESTS};
  process.env.OPENING_SIGNATURE_TEXT='TEST';process.env.OPENING_INITIALS='T';process.env.ALLOW_CLIENT_MUTATION_TESTS='true';
  try {
    await page.route('https://sandbox.fidere.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div role="dialog"><h2>CRS 控制人表格</h2><iframe title="Webull CRS" src="https://app.documenso.com/sandbox-fixture" style="width:1000px;height:700px"></iframe></div>'}));
    await page.route('https://app.documenso.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
      <label>Full Name<input value="TEST SANDBOX AH"></label><p>Signature</p>
      <span id="remaining">1 Fields Remaining</span><button id="next">Next Field</button>
      <div style="position:relative;height:330px">
        <canvas style="position:absolute;left:0;top:0;width:300px;height:100px"></canvas>
        <canvas style="position:absolute;left:0;top:110px;width:300px;height:100px"></canvas>
        <canvas id="target" style="position:absolute;left:0;top:220px;width:300px;height:100px"></canvas>
        <div aria-describedby="prompt" style="position:absolute;left:50px;top:245px;width:100px;height:40px"></div>
      </div><span id="prompt">Click to insert field</span>
      <button id="complete" style="display:none">Complete</button>
      <script>
        document.getElementById('target').onclick=()=>{
          const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.id='signature-editor';
          dialog.innerHTML='<p>Sign Signature Field</p><span>Draw</span><canvas width="300" height="120"></canvas><button>Sign</button>';
          dialog.querySelector('button').onclick=()=>{dialog.remove();document.getElementById('remaining').textContent='0 Fields Remaining';document.getElementById('complete').style.display='block';};
          document.body.append(dialog);
        };
        document.getElementById('complete').onclick=()=>{
          const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
          dialog.innerHTML='<p>Are you sure?</p><p>You are about to complete signing the following document</p><p>Actual CRS document</p><button>Cancel</button><button id="finish">Sign</button>';
          dialog.querySelector('#finish').onclick=()=>dialog.remove();document.body.append(dialog);
        };
      </script>`}));
    await page.goto('https://sandbox.fidere.test/broker');
    const signer=new WebullDocumentSigner(page,'crs-controller');
    expect((await signer.attach('TEST SANDBOX AH')).fieldsRemaining).toBe(1);
    const result=await signer.prepare();expect(result.requiredFieldsAfter).toBe(0);expect(result.namePreserved).toBe(true);
    await signer.complete();await signer.confirm();expect(signer.counts()).toEqual({fieldSign:1,complete:1,sign:1});
    await expect(signer.confirm()).rejects.toThrow('once');
    await expect(signer.prepare()).rejects.toThrow('already');
  } finally {
    for (const [key,value] of Object.entries({OPENING_SIGNATURE_TEXT:previous.signature,OPENING_INITIALS:previous.initials,ALLOW_CLIENT_MUTATION_TESTS:previous.mutation})) {
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
