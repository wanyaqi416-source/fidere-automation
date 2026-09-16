export function requireRegistrationEmail(value?: string): string {
  const email = value?.trim().toLowerCase() ?? '';
  if (!isValidEmail(email)) {
    throw new Error('REGISTRATION_EMAIL_REQUIRED: 请输入真实可接收验证码的合法邮箱。');
  }
  return email;
}

export function isValidEmail(value: string): boolean {
  if (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return false;
  const [local, domain] = value.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') &&
    !local.includes('..') && domain.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function requireU2uRecipient(sender: string | undefined, value?: string): string {
  const recipient = value?.trim().toLowerCase() ?? '';
  if (!sender?.trim()) throw new Error('U2U_SENDER_REQUIRED: 请配置 CLIENT_USERNAME。');
  if (!isValidEmail(recipient)) throw new Error('U2U_RECIPIENT_EMAIL_REQUIRED: 请输入合法的收款用户邮箱。');
  if (sender.trim().toLowerCase() === recipient) {
    throw new Error('U2U_RECIPIENT_EQUALS_SENDER: 收款账号不能与转出账号相同。');
  }
  return recipient;
}
