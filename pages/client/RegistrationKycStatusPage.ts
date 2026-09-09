import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { HomePage, clientRouteUrl } from './HomePage';
import { LoginPage } from './LoginPage';
import { decodeClientKycStatus, type RegistrationKycSource } from '../../src/registration/registration-kyc-contract';

export class RegistrationKycStatusPage {
  constructor(readonly page: Page) {}

  async read(source: RegistrationKycSource) {
    const response = await this.page.request.get(new URL('/server/auth/session', this.page.url()).toString());
    if (!response.ok()) throw new Error('CLIENT_KYC_SESSION_UNAVAILABLE');
    return decodeClientKycStatus(await response.json(), source);
  }

  async expectApproved(source: RegistrationKycSource, baseURL: string) {
    let snapshot = await this.read(source);
    await expect.poll(async () => {
      snapshot = await this.read(source);
      return snapshot.approved;
    }, { timeout: 60_000, intervals: [1_000, 2_000, 5_000],
      message: 'Client authenticated successfully but the original user KYC is not approved.' }).toBe(true);
    const home = new HomePage(this.page);
    await home.gotoDashboard(baseURL);
    await home.expectDashboardLoaded();
    return snapshot;
  }

  static async cleanLogin(input: {
    browser: Browser; baseURL: string; email: string; password: string; otp: string;
  }): Promise<{ context: BrowserContext; statusPage: RegistrationKycStatusPage }> {
    const context = await input.browser.newContext({
      baseURL: input.baseURL, storageState: { cookies: [], origins: [] }
    });
    try {
      const page = await context.newPage();
      const login = new LoginPage(page);
      await login.goto(clientRouteUrl(input.baseURL, 'login'));
      await login.fillCredentials({ username: input.email, password: input.password });
      await login.submitCredentials();
      await login.expectOtpStep();
      await login.fillOtp(input.otp);
      await login.confirmLoginToAuthenticatedRoute();
      return { context, statusPage: new RegistrationKycStatusPage(page) };
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}
