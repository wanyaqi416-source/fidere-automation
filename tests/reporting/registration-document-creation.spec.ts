import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  authorizationDocumentCreationAccepted,
  type AuthorizationDocumentCreationEvidence
} from '../../pages/client/PersonalOnboardingPage';

function evidence(httpStatus: number, documentPayloadPresent: boolean): AuthorizationDocumentCreationEvidence {
  return {
    requestObserved: true,
    host: 'sandbox.fidere.test',
    path: '/api/create-kyc-doc',
    method: 'POST',
    httpStatus,
    observedAt: '2026-09-15T10:00:00.000Z',
    documentPayloadPresent,
    payloadKind: documentPayloadPresent ? 'signingUrl' : 'unknown'
  };
}

test('create-kyc-doc可异步返回定位信息，HTTP成功后继续等待真实协议', () => {
  expect(authorizationDocumentCreationAccepted(evidence(200, false))).toBe(true);
  expect(authorizationDocumentCreationAccepted(evidence(202, false))).toBe(true);
  expect(authorizationDocumentCreationAccepted(evidence(500, true))).toBe(false);
});

test('Fresh Registration不再把缺少token或signingUrl作为即时失败条件', () => {
  const source = readFileSync('tests/e2e/registration/personal-registration.spec.ts', 'utf8');
  expect(source).not.toContain('!documentCreation.documentPayloadPresent');
  expect(source).not.toContain('Registration Agreement creation did not return a usable current-user document.');
  expect(source).toContain('authorizationDocumentCreationAccepted(documentCreation)');
});

test('Fresh Registration does not query the encrypted Sandbox signing-status endpoint', () => {
  const source = readFileSync('tests/e2e/registration/personal-registration.spec.ts', 'utf8');
  expect(source).not.toContain('FidereSigningStatusReader');
  expect(source).not.toContain('statusReader.read()');
  expect(source).toContain("'Not queried; Sandbox endpoint is encrypted'");
  expect(source).toContain('profileSubmission.httpStatus');
  expect(source).toContain('profileSubmission.pendingReviewPageVisible');
});

test('Personal signing enhancements are isolated from Corporate Registration', () => {
  const personalSource = readFileSync(
    'tests/e2e/registration/personal-registration.spec.ts',
    'utf8'
  );
  const corporateSignerSource = readFileSync(
    'pages/client/registration/CorporateRegistrationSigner.ts',
    'utf8'
  );
  const corporateSpecSource = readFileSync(
    'tests/e2e/registration/corporate-registration.spec.ts',
    'utf8'
  );

  expect(personalSource).toContain('waitForCompletedDocumentUi()');
  expect(corporateSignerSource).toContain('personalRegistrationEnhancements: false');
  expect(corporateSpecSource).not.toContain('waitForCompletedDocumentUi()');
});

test('Personal Registration uses the fixed TEST image instead of Canvas drawing', () => {
  const signerSource = readFileSync(
    'pages/client/registration/RegistrationAgreementSigner.ts',
    'utf8'
  );
  const asset = readFileSync(
    'test-assets/personal-registration/signature_TEST_SANDBOX.png'
  );

  expect(signerSource).toContain("return 'Image Upload'");
  expect(signerSource).toContain("'signature_TEST_SANDBOX.png'");
  expect(asset.subarray(1, 4).toString('ascii')).toBe('PNG');
});

test('Personal Registration Resume completes the shared Admin KYC tail before PASS', () => {
  const source = readFileSync(
    'tests/e2e/registration/personal-registration.resume.spec.ts',
    'utf8'
  );

  expect(source).toContain('rememberRegistrationSubmission({');
  expect(source).toContain('await runRegistrationKycTail({');
  expect(source).toContain("clientStatus: 'KYC Approved'");
  expect(source).not.toContain('Admin Post-Registration Diagnostic');
});

test('Fresh Personal Registration enters Admin KYC directly after Client submission', () => {
  const source = readFileSync(
    'tests/e2e/registration/personal-registration.spec.ts',
    'utf8'
  );

  expect(source).not.toContain('13. 使用新邮箱和CLIENT_PASSWORD重新登录Client');
  expect(source).not.toContain('14. Post-Registration Diagnostic');
  expect(source).not.toContain('runLegacyPreApprovalChecks');
  expect(source).toContain('await adminPage.bringToFront();');
  expect(source.indexOf('rememberRegistrationSubmission({')).toBeLessThan(
    source.lastIndexOf('await runRegistrationKycTail({')
  );
  expect(source.lastIndexOf('await runRegistrationKycTail({')).toBeLessThan(
    source.lastIndexOf("clientStatus: 'KYC Approved'")
  );
});
