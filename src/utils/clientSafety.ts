import { assertSandboxEnvironment } from '../flow-engine/mutation-guard';

const moneyTagPattern = /@money\b/;
const mutationTagPattern = /@mutation\b/;

export function assertClientTestEnvironment(baseURL: string | undefined): void {
  assertSandboxEnvironment(baseURL);
}

export function assertClientMutationTestsAllowed(testTags: readonly string[]): void {
  const tags = testTags.join(' ');

  if (moneyTagPattern.test(tags)) {
    if (process.env.ALLOW_MONEY_TESTS !== 'true') {
      throw new Error(
        'Client money tests are blocked by default. Set ALLOW_MONEY_TESTS=true only for one approved run in the dedicated test environment.'
      );
    }

    return;
  }

  if (mutationTagPattern.test(tags) && process.env.ALLOW_CLIENT_MUTATION_TESTS !== 'true') {
    throw new Error(
      'Client mutation tests are blocked by default. Set ALLOW_CLIENT_MUTATION_TESTS=true only in an approved test environment.'
    );
  }
}
