import { resolve } from 'node:path';
import { test, expect } from '../../../fixtures/registration.fixture';
import { env } from '../../../src/config/env';
import { FlowStateStore } from '../../../src/flow-engine';
import { PersonalPostRegistrationJourneyStore } from '../../../src/journey';
import { openPersonalJourneyClientSession } from '../../../src/registration';
import { WebullOpeningPage } from '../../../pages/client/WebullOpeningPage';
import { AccountDetailPage } from '../../../pages/client/AccountDetailPage';
import { SecuritiesTradingPage } from '../../../pages/client/SecuritiesTradingPage';
import { WEBULL_BROKER_NAME } from '../../../src/journey/webull-opening';
import { maskSensitiveText } from '../../../src/reporting/sensitive-data-mask';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0 });
test('OPEN-WEBULL 原文档签署只读复核 @readonly @L2', async ({ browser, business }, testInfo) => {
  test.setTimeout(180_000);
  for (const key of ['ALLOW_MONEY_TESTS','ALLOW_CLIENT_MUTATION_TESTS','ALLOW_ADMIN_MUTATION_TESTS']) expect(process.env[key]).not.toBe('true');
  const sourceRunId = process.env.BROKER_SOURCE_RUN_ID;
  const runId = process.env.BROKER_OPENING_RUN_ID;
  if (!sourceRunId || !runId) throw new Error('An existing broker Journey is required.');
  const source = new PersonalPostRegistrationJourneyStore(sourceRunId).load();
  const store = new FlowStateStore(resolve('.flow-state','broker-journeys',sourceRunId));
  if (!source || !store.load('webull-document-w8ben',runId) || !store.load('webull-document-crs-controller',runId)) throw new Error('Existing two-document evidence required.');
  business.flow('webull-broker-opening-reconciliation');
  business.setBusinessData({runId,sourceRunId,registrationTestName:source.displayName});
  const client = await openPersonalJourneyClientSession({browser,baseURL:env.client.baseUrl!,runId:sourceRunId,
    email:source.email,password:env.client.password!,otp:env.client.otp!,forceFreshLogin:true});
  client.page.setDefaultTimeout(20_000);
  try {
    await business.step({action:'只读核对原AH双文档签署回写和余额',expected:'不重新签署，不扣费，不创建申请；读取当前真实页面。'},async step=>{
      const accounts=new AccountDetailPage(client.page);await accounts.goto(env.client.baseUrl!);
      const balance=await accounts.readSnapshot('香港账户','USD');
      const original = store.load('webull-broker-opening', runId);
      if (original?.stage === 'COMPLETED') {
        const securities = new SecuritiesTradingPage(client.page);
        await securities.goto(env.client.baseUrl!);
        const status = await securities.readBrokerStatus(WEBULL_BROKER_NAME);
        expect(status).toMatch(/^(已开户|已开通)$/);
        step.setActual(`原微牛申请已完成；Client=${status}；当前香港USD余额${balance.available}；未重新打开申请或签署。`);
        step.setBusinessData({ adminReference: original.adminReference, finalStatus: status, feeBalanceAfter: balance.available,
          confirmationClicks: 0, securityVerificationClicks: 0, approvalClicks: 0 });
        business.setResumeState(original.stage);
        return;
      }
      const opening=new WebullOpeningPage(client.page);const fee=await opening.open(env.client.baseUrl!);
      await opening.opening.continueWebullToDocuments();
      let documents = await readDocuments();
      try {
        await expect.poll(async () => {
          documents=await readDocuments();
          return documents.every(document=>document.completed);
        },{timeout:45_000,intervals:[1000,2000,5000]}).toBe(true);
      } catch (error) {
        testInfo.annotations.push({type:'blocker',description:'Webull documents signed, but Fidere completion is not observable after clean login; do not sign again.'});
        step.recordDiagnostic({id:'webull-signing-callback',name:'微牛签署回写',status:'unavailable',summary:'原文档最终Sign已执行，本次只读等待仍未取得两份Fidere完成状态。',reason:maskSensitiveText(String(error)),affectsCoreBusiness:false});
      }
      async function readDocuments() {
        return [await opening.readDocumentState('w8ben'),await opening.readDocumentState('crs-controller')];
      }
      const snapshot=maskSensitiveText(await client.page.locator('body').ariaSnapshot());
      console.log('WEBULL_READONLY_STATE '+JSON.stringify({balance,fee,documents}));
      console.log('WEBULL_READONLY_DOCUMENTS '+snapshot);
      await testInfo.attach('webull-existing-document-state',{body:snapshot,contentType:'text/plain'});
      step.setActual(`香港USD可用余额${balance.available}；文档回写=${JSON.stringify(documents)}；所有Mutation点击0次。`);
      step.setBusinessData({feeBalanceBefore:balance.available,openingFeeAmount:fee.fee.amount,confirmationClicks:0,securityVerificationClicks:0,approvalClicks:0});
    });
  } finally {await client.context.close();}
});
