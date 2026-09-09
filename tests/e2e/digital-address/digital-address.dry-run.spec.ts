import { test, expect } from '../../../fixtures/digital-address.fixture';
import { env } from '../../../src/config/env';
import { DIGITAL_ASSETS, matchDigitalAddresses } from '../../../src/digital-address/digital-address';
import { requireExactlyOneCandidate } from '../../../src/flow-engine';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ retries: 0 });

test('DA-001 数字资产地址提交前校验 @validation @L1', async ({ digitalAddress, business }) => {
  business.flow('digital-address-validation');
  const { client } = digitalAddress;
  await business.step({ action: '1. 地址管理与必填项校验', expected: '头像进入地址管理；三个必填项缺失时仅产生前端校验，不创建地址。' }, async step => {
    await client.goto(env.client.baseUrl!);
    await client.openAddForm();
    await client.expectEmptyValidation();
    step.setActual('地址名称、加密货币类型、钱包地址必填校验通过；未进入安全验证。');
  });
  await business.step({ action: '2. 选择真实币种并填写后取消', expected: '读取真实选项、填写普通字段、取消退出，业务新增和审核均为0次。' }, async step => {
    const options = await client.readAssetOptions();
    expect(options).toEqual(Object.values(DIGITAL_ASSETS).map(value => value.option));
    await client.fill({ label: 'AUTO DIGITAL ADDRESS DRY RUN', assetKey: 'USDT_TRC20', address: 'SANDBOX-DRY-RUN-NOT-A-WALLET' });
    await client.cancel();
    digitalAddress.expectNoWrites();
    step.setActual(`已验证币种/网络：${options.join('、')}。占位文本仅填写后取消，未注册钱包。`);
  });
});

test('DA-DRY 数字资产地址审核详情Dry Run @dry-run @L3', async ({ digitalAddress, business }) => {
  business.flow('digital-address-dry-run');
  const { admin } = digitalAddress;
  const id = process.env.DIGITAL_ADDRESS_READONLY_REFERENCE;
  if (!id || !/^\d+$/.test(id)) throw new Error('DIGITAL_ADDRESS_READONLY_REFERENCE must identify an existing pending record for read-only inspection.');
  await business.step({ action: '1. Admin列表、搜索与候选守卫', expected: '读取历史白名单ID及真实详情，只对指定记录进行只读检查，不视为本次新增。' }, async step => {
    const detail = await admin.openDetail(env.admin.baseUrl!, id);
    expect(detail.status).toBe('待审核');
    await admin.goto(env.admin.baseUrl!);
    const rows = await admin.collectCandidates(detail.address);
    const selected = requireExactlyOneCandidate(rows.filter(row => row.id === id), 'Readonly whitelist reference');
    const assetKey = (Object.keys(DIGITAL_ASSETS) as Array<keyof typeof DIGITAL_ASSETS>).find(key => DIGITAL_ASSETS[key].asset === detail.asset && DIGITAL_ASSETS[key].network === detail.network);
    expect(assetKey).toBeDefined();
    const match = matchDigitalAddresses(rows, { email: detail.ownerEmail, userId: detail.userId, address: detail.address, label: detail.label, assetKey: assetKey!, reference: id }, '待审核');
    step.setActual(`候选分层：${match.stages.map(stage => `${stage.label}=${stage.candidateCount}`).join('；')}；详情/列表字段一致性：地址=${selected.address === detail.address}、币种=${selected.asset === detail.asset}、网络=${selected.network === detail.network}、标签=${selected.label === detail.label}；地址开关=${selected.enabledState}，审核状态=${detail.status}。`);
    expect(match.candidates.length).toBe(1);
    expect(match.candidates[0].id === selected.id).toBe(true);
    step.setActual(`历史记录详情与列表一致；分层候选：${match.stages.map(stage => `${stage.label}=${stage.candidateCount}`).join('；')}。`);
  });
  await business.step({ action: '2. 打开审核确认框并取消', expected: '只打开“通过”的二次确认，核对原地址；不点击“确认通过”。' }, async step => {
    const detail = await admin.openDetail(env.admin.baseUrl!, id);
    await admin.openApprovalConfirmation(detail.address);
    await admin.cancelApproval();
    expect(admin.counts().adminApprovalClicks).toBe(0);
    digitalAddress.expectNoWrites();
    step.setActual('确认框显示同一地址；批准无额外必填备注。已取消，最终审核0次。');
  });
});
