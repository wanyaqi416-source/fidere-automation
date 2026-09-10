import { test, expect } from '../../../fixtures/workflow.fixture';
import { env } from '../../../src/config/env';
import { assertSandboxEnvironment } from '../../../src/flow-engine';
import { TransferFeeMatrixRun } from '../../../src/transfer/transfer-fee-matrix-run';
import { TransferListPage } from '../../../pages/admin/TransferListPage';
import { AccountTypeConfigurationPage } from '../../../pages/admin/AccountTypeConfigurationPage';
import { readOriginalU2uApproval } from '../../../src/user-transfer/u2u-admin-review';
import { sameAccountTypeConfiguration } from '../../../src/transfer/account-transfer-fee';
import { Decimal } from '../../../src/utils/money';

test.use({ trace:'off',screenshot:'off',video:'off' });
test('只读核对已尝试批准的原用户转账 @readonly @L2', async ({ adminPage, business }) => {
  test.setTimeout(120_000); business.flow('transfer-fee-matrix-approved-readonly');
  expect(env.exchange.allowMoneyTests || env.allowAdminMutationTests || env.allowClientMutationTests).toBe(false);
  assertSandboxEnvironment(env.admin.baseUrl);
  const runId=process.env.TRANSFER_FEE_MATRIX_RECONCILE_RUN_ID;
  if(!runId || !env.client.username || !process.env.U2U_RECIPIENT_EMAIL) throw new Error('Original Run/participants required.');
  const saved=TransferFeeMatrixRun.readEvidence(runId);
  const run=new TransferFeeMatrixRun(runId,saved.plan,env.client.username,process.env.U2U_RECIPIENT_EMAIL,undefined,true),e=run.evidence;
  if(e.plan.kind!=='p2p' || !e.order || !run.attempted('approve') || e.approvalClicks!==1 || !e.restored) throw new Error('Only original once-approved U2U with restored fees may be reconciled.');
  await adminPage.route('**/*',async route=>{
    const r=route.request(),path=new URL(r.url()).pathname;
    if(['PUT','PATCH','DELETE'].includes(r.method()) || (r.method()==='POST' && !/\/(list|detail|page)$/.test(path))) await route.abort('blockedbyclient');
    else await route.continue();
  });
  await business.step({action:'原TXN审核结果及原配置只读核查',expected:'原TXN已批准；本次批准/Client提交/安全验证全部0次'},async step=>{
    const approved=await readOriginalU2uApproval(new TransferListPage(adminPage),env.admin.baseUrl!,env.client.username!,e.order!.txNo);
    expect(approved.adminTransactionId).toBe(e.order!.txNo);
    expect(approved.recordType).toBe('用户间互转'); expect(approved.currency).toBe(e.plan.currency);
    expect(new Decimal(approved.requestedAmount).eq(e.plan.amount)).toBe(true);
    expect(new Decimal(approved.feeAmount).eq(e.plan.fee)).toBe(true);
    expect(new Decimal(approved.netAmount).eq(e.plan.expectedCredit)).toBe(true);
    const admin=new AccountTypeConfigurationPage(adminPage);await admin.goto(env.admin.baseUrl!);await admin.openBahrainEditor();
    expect(sameAccountTypeConfiguration(await admin.readFeeConfiguration(),e.original!)).toBe(true);await admin.cancelFeeEdit();
    e.adminStatus=approved.status;e.adminNet=approved.netAmount;e.verified=true;
    run.advance('ADMIN_ACTION_DONE');run.complete();
    business.setResumeState(run.state.stage);
    business.setBusinessData({runId,clientTransferId:e.order!.orderNo,adminTransactionId:e.order!.txNo,transferAmount:e.plan.amount,
      feeAmount:e.plan.fee,receivedAmount:e.adminNet,adminFinalStatus:e.adminStatus,configurationRestored:true,
      finalSubmissionClicks:0,securityVerificationClicks:0,adminMutationClicks:0,confirmed:true,safeToRerun:false});
    step.recordPrimaryOracle({id:'original-approval',name:'原用户转账审核提交成功',expected:'原TXN已批准且费用净额一致',actual:'通过',status:'passed'});
    step.setActual('原Admin订单已批准；仅查询，没有再次批准、提交、安全验证或修改费用。');
  });
});
