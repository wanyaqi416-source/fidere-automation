import { createHash } from 'node:crypto';
import { isValidEmail } from './runtime-email';

export function defaultFiatUserKey(email: string): string {
  if (!isValidEmail(email.trim())) throw new Error('CLIENT_USERNAME_REQUIRED: 请配置有效的默认 Client 邮箱。');
  return `DEFAULT-${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}
