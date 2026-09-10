import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { MoneyMutationGuard, assertSandboxEnvironment } from '../../../src/flow-engine';
import { TransferFeeMatrixRun } from '../../../src/transfer/transfer-fee-matrix-run';
import { loginU2uParticipant } from '../../../src/user-transfer/u2u-participant';
import { openOriginalU2uReview, readOriginalU2uApproval } from '../../../src/user-transfer/u2u-admin-review';

test.use({ trace:'off',screenshot:'off',video:'off' });
test('原费用矩阵用户转账单次审批Resume，无Client提交 @mutation @money @L4', async ({browser,adminPage,business},testInfo)=>{
  test.setTimeout(240_000);business.flow('transfer-fee-matrix-approve-resume');
  expect(env.allowClientMutationTests).toBe(false);
  const switches={ALLOW_MONEY_TESTS:env.exchange.allowMoneyTests,ALLOW_ADMIN_MUTATION_TESTS:env.allowAdminMutationTests};
  const guard=new MoneyMutationGuard('matrix-u2u-original-approval',true,false);
  guard.validateRuntime({baseURL:env.admin.baseUrl,workers:testInfo.config.workers,retries:testInfo.project.retries,repeatEach:testInfo.project.repeatEach,safetySwitches:switches});
  assertSandboxEnvironment(env.client.baseUrl);
  const runId=process.env.TRANSFER_FEE_MATRIX_RECONCILE_RUN_ID,recipient=process.env.U2U_RECIPIENT_EMAIL;
  if(!runId||!recipient||!env.client.username)throw new Error('Original Run and configured participants required.');
  const original=TransferFeeMatrixRun.readEvidence(runId);
  const run=new TransferFeeMatrixRun(runId,original.plan,env.client.username,recipient,undefined,true),e=run.evidence;
  if(e.plan.kind!=='p2p'||!e.order||!run.attempted('security')||run.attempted('approve')||!e.restored||e.approvalClicks)throw new Error('Only original unapproved U2U with restored fee and Client creation evidence may continue.');
  business.disallowSafeRerun();
  await business.step({action:'1. 原发送方认证及原TXN上下文预检',expected:'不提交Client，不修改手续费，不替换原订单'},async step=>{
    const clean=await loginU2uParticipant(browser,env.client.baseUrl!,env.client.username!);await clean.context.close();
    guard.markAuthenticationReady(true,true);guard.recordClientSubmission();
    step.setActual('原发送方身份/KYC正常；Client提交及安全验证0次。');
  });
  const names:Record<string,string>={HK:'香港账户',BH:'巴林账户',SG:'新加坡账户',US:'美国账户'};
  const target=names[e.order.toRegion];if(!target)throw new Error('Original recipient account not established.');
  const review=await business.step({action:'2. 完整分页唯一定位及详情二次核对',expected:'原TXN、双方、方向、币种、金额、费用、净额、时间和待审核全部匹配'},async step=>{
    const found=await openOriginalU2uReview({page:adminPage,baseURL:env.admin.baseUrl!,sender:env.client.username!,recipient,
      evidence:{senderLedgerId:e.order!.txNo,submittedAt:e.submittedAt,sourceAccountType:'巴林账户',targetAccountType:target,
        currency:e.plan.currency,amount:e.plan.amount,fee:e.plan.fee,expectedCredit:e.plan.expectedCredit},business});
    guard.recordUniqueAdminCandidate(1);e.adminNet=found.detail.receivedAmount;
    if(run.state.stage==='CLIENT_CREATED')run.advance('ADMIN_LOCATED');
    step.setActual('candidateCount=1，原详情全部匹配；不根据列表顺序选择。');return found;
  });
  await business.step({action:'3. 批准原订单一次并确认成功',expected:'只批准本次原TXN；不重新提交、不再次改费、不追加余额流水检查'},async step=>{
    const remark=`AUTO_FEE_APPROVE_${runId}`;await review.review.fillRemark(remark);expect(await review.review.readRemarkValue()).toBe(remark);
    guard.assertAdminActionAllowed(switches);run.attempt('approve');guard.recordAdminAction();business.markMutationPerformed('批准本Run原用户转账一次');
    try{await review.review.confirmApproveOnce(switches.ALLOW_MONEY_TESTS,switches.ALLOW_ADMIN_MUTATION_TESTS);}
    catch(error){if(!review.review.wasApproved())throw error;business.recordDiagnostic({id:'approval-ui',name:'批准后UI',status:'info',summary:'已尝试一次，仅查原TXN',affectsCoreBusiness:false});}
    finally{e.approvalClicks=review.review.approvalClickCount();e.approvalConfirmations=review.review.secondaryConfirmationClickCount();run.save();}
    try{e.adminStatus=(await readOriginalU2uApproval(review.list,env.admin.baseUrl!,env.client.username!,e.order!.txNo)).status;}
    catch(error){business.requireManualReview('原订单批准已尝试，禁止再次批准；仅查原TXN状态。');throw error;}
    e.verified=true;run.advance('ADMIN_ACTION_DONE');run.complete();
    step.recordPrimaryOracle({id:'approved',name:'原用户转账审核提交成功',expected:'唯一原TXN批准一次且已批准',actual:'通过',status:'passed'});
    step.setActual('原TXN已批准，批准1次；没有新建交易或修改手续费。');
  });
  business.setResumeState(run.state.stage);business.setBusinessData({runId,clientTransferId:e.order.orderNo,adminTransactionId:e.order.txNo,
    transferAmount:e.plan.amount,feeAmount:e.plan.fee,receivedAmount:e.adminNet,adminFinalStatus:e.adminStatus,candidateCount:1,
    finalSubmissionClicks:0,securityVerificationClicks:0,adminMutationClicks:e.approvalClicks,configurationRestored:e.restored,confirmed:e.verified,safeToRerun:false});
});
