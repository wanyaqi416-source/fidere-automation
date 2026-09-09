import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { decodeDigitalAddressReceipt, type DigitalAddressCandidate } from '../../src/digital-address/digital-address';

type Row = DigitalAddressCandidate & { row: Locator };
export type WhitelistDetail = { id: string; userId: string; ownerEmail: string; address: string; asset: string; network: string; label: string; status: string; submittedAt: string };
export class AdminWhitelistReviewPage {
  private finalApprovalClicks = 0;
  constructor(readonly page: Page) {}
  private listResponse(response: Response): boolean {
    return new URL(response.url()).origin === new URL(this.page.url()).origin && new URL(response.url()).pathname.endsWith('/member/walletWhitelist/list');
  }
  async goto(baseURL: string, status: '待审核' | '已通过' | '已拒绝' = '待审核'): Promise<void> {
    await Promise.all([
      this.page.waitForResponse(r => new URL(r.url()).origin === new URL(baseURL).origin && new URL(r.url()).pathname.endsWith('/member/walletWhitelist/list')),
      this.page.goto(new URL('/zh-CN/kyc/whitelists', baseURL).toString(), { waitUntil: 'domcontentloaded' })
    ]);
    await expect(this.page).not.toHaveURL(/\/(login|signin|sign-in)/);
    const tab = this.page.getByRole('tab', { name: status, exact: true });
    await expect(tab).toBeVisible();
    if (await tab.getAttribute('aria-selected') !== 'true') await Promise.all([this.page.waitForResponse(r => this.listResponse(r)), tab.click()]);
    await expect(this.page.getByRole('columnheader', { name: '白名单ID', exact: true })).toBeVisible();
  }
  async search(value: string): Promise<Response> {
    const input = this.page.getByPlaceholder('搜索地址ID、用户名、地址...', { exact: true });
    await expect(input).toBeVisible();
    const [response] = await Promise.all([
      this.page.waitForResponse(r => {
        if (!this.listResponse(r)) return false;
        const data = r.request().postDataJSON() as Record<string, unknown> | null;
        return data !== null && Object.values(data).includes(value);
      }),
      (async () => { await input.fill(value); await input.press('Enter'); })()
    ]);
    if (!response.ok()) throw new Error('Whitelist list search failed.');
    return response;
  }
  async headers(): Promise<string[]> { return (await this.page.getByRole('columnheader').allTextContents()).map(t => t.trim()); }
  async readRows(): Promise<Row[]> {
    const headers = await this.headers();
    const reviewStatus = (await this.page.getByRole('tab', { selected: true }).innerText()).trim();
    if (!['待审核', '已通过', '已拒绝'].includes(reviewStatus)) throw new Error('Whitelist review tab is unknown.');
    const output: Row[] = [];
    for (const row of await this.page.getByRole('row').all()) {
      const cells = await row.getByRole('cell').allInnerTexts();
      if (!cells.length || cells.length === 1) continue;
      if (cells.length !== headers.length) throw new Error('Whitelist table columns changed.');
      const fields = Object.fromEntries(headers.map((header, index) => [header, cells[index].trim()]));
      for (const key of ['白名单ID', '客户信息', '地址类型', '地址', '状态', '标签', '网络', '提交时间']) {
        if (fields[key] === undefined) throw new Error(`Whitelist header missing: ${key}`);
      }
      output.push({ row, id: fields['白名单ID'], customerText: fields['客户信息'], asset: fields['地址类型'],
        address: fields['地址'], enabledState: fields['状态'], status: reviewStatus, label: fields['标签'], network: fields['网络'], submittedAt: fields['提交时间'] });
    }
    return output;
  }
  async collectCandidates(search: string): Promise<Row[]> {
    const response = await this.search(search);
    const payload = await response.json();
    const data = payload?.data?.data ?? payload?.data;
    const total = Number(data?.total);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Whitelist pagination total is unavailable; candidate set is not complete.');
    const all = new Map<string, Row>();
    for (let pages = 0; pages < 100; pages++) {
      await expect(this.page.locator('.MuiSkeleton-root')).toHaveCount(0);
      const rows = await this.readRows();
      for (const row of rows) {
        if (all.has(row.id)) throw new Error('Whitelist pagination repeated a record; no approval allowed.');
        all.set(row.id, row);
      }
      if (all.size === total) return [...all.values()];
      if (!rows.length || all.size > total) throw new Error('Whitelist pagination count changed; repeat read-only matching.');
      const next = this.page.getByRole('button', { name: /Go to next page|下一页/i });
      await expect(next).toHaveCount(1);
      await expect(next).toBeEnabled();
      await Promise.all([this.page.waitForResponse(r => this.listResponse(r)), next.click()]);
    }
    throw new Error('Whitelist pagination exceeded the bounded scan.');
  }
  async openDetail(baseURL: string, id: string): Promise<WhitelistDetail> {
    if (!/^\d+$/.test(id)) throw new Error('Invalid observed whitelist reference.');
    const [ownerResponse] = await Promise.all([
      this.page.waitForResponse(r => new URL(r.url()).origin === new URL(baseURL).origin && new URL(r.url()).pathname.endsWith('/member/walletWhitelist/detail') && r.request().method() === 'GET'),
      this.page.goto(new URL(`/zh-CN/kyc/whitelists/${id}`, baseURL).toString(), { waitUntil: 'domcontentloaded' })
    ]);
    await expect(this.page.getByRole('heading', { name: '地址信息', exact: true })).toBeVisible();
    const detail = await this.readDetail(id);
    const body = await ownerResponse.json();
    const owner = body?.data?.data ?? body?.data;
    if (!ownerResponse.ok() || !owner?.memberEmail || String(owner.id) !== id || String(owner.userId) !== detail.userId || new URL(ownerResponse.url()).searchParams.get('id') !== id) {
      throw new Error('Whitelist detail owner lookup does not match its displayed userId.');
    }
    return { ...detail, ownerEmail: String(owner.memberEmail) };
  }
  private async field(sectionName: string, label: string): Promise<string> {
    const section = this.page.locator('.MuiCard-root').filter({ has: this.page.getByRole('heading', { name: sectionName, exact: true }) });
    const field = section.getByText(label, { exact: true });
    await expect(field).toHaveCount(1);
    return field.evaluate(element => Array.from(element.parentElement?.children ?? []).filter(child => child !== element).map(child => (child as HTMLElement).innerText).join(' ').trim());
  }
  private async readDetail(id: string): Promise<Omit<WhitelistDetail, 'ownerEmail'>> {
    return { id, asset: await this.field('地址信息', '地址类型'), network: await this.field('地址信息', '网络'),
      address: await this.field('地址信息', '地址'), label: await this.field('地址信息', '标签'),
      userId: await this.field('用户信息', '用户ID'), status: await this.field('审核状态', '当前状态'),
      submittedAt: await this.field('审核状态', '提交时间') };
  }
  async openApprovalConfirmation(expectedAddress: string): Promise<void> {
    await this.page.getByRole('button', { name: '通过', exact: true }).click();
    const dialog = this.page.getByRole('dialog', { name: '确认通过审核', exact: true });
    await expect(dialog).toBeVisible();
    expect((await dialog.innerText()).includes(expectedAddress), 'Confirmation is for the same wallet').toBe(true);
    await expect(dialog.getByRole('button', { name: '确认通过', exact: true })).toBeEnabled();
  }
  async cancelApproval(): Promise<void> {
    await this.page.getByRole('dialog', { name: '确认通过审核', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  }
  async confirmApproveOnce(beforeClick: () => void): Promise<void> {
    if (this.finalApprovalClicks) throw new Error('Whitelist final approval was already attempted.');
    const button = this.page.getByRole('dialog', { name: '确认通过审核', exact: true }).getByRole('button', { name: '确认通过', exact: true });
    await expect(button).toBeEnabled();
    beforeClick();
    this.finalApprovalClicks++;
    const origin = new URL(this.page.url()).origin;
    const [response] = await Promise.all([
      this.page.waitForResponse(r => new URL(r.url()).origin === origin && new URL(r.url()).pathname.endsWith('/member/walletWhitelist/approve') && r.request().method() === 'POST'),
      button.click()
    ]);
    if (!response.ok() || !decodeDigitalAddressReceipt(await response.json()).accepted) throw new Error('Whitelist approval response is not confirmed; do not approve again.');
  }
  counts() { return { adminApprovalClicks: this.finalApprovalClicks }; }
}
