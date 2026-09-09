import { createHash } from 'node:crypto';

function normalizeIdentityText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function customerIdentityHash(customerText: string): string {
  return `sha256:${createHash('sha256')
    .update(normalizeIdentityText(customerText))
    .digest('hex')}`;
}

export function matchesConfiguredCustomerIdentity(
  customerText: string,
  configuredIdentity: string
): boolean {
  const expected = normalizeIdentityText(configuredIdentity);
  if (!expected) return false;

  if (expected.startsWith('sha256:')) {
    return customerIdentityHash(customerText) === expected;
  }

  if (expected.includes('@')) {
    const displayedEmails = customerText
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
      ?.map(normalizeIdentityText) ?? [];
    return displayedEmails.includes(expected);
  }

  if (/^\d+$/.test(expected)) {
    const displayedIds = [...customerText.matchAll(/\bID\s*:\s*([A-Z0-9-]+)/gi)]
      .map(match => normalizeIdentityText(match[1]));
    return displayedIds.includes(expected);
  }

  return normalizeIdentityText(customerText).includes(expected);
}

