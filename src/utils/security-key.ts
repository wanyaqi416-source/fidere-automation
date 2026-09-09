import { env } from '../config/env';

export function getClientSecurityKey(): string {
  const securityKey = env.client.securityKey;

  if (!securityKey) {
    throw new Error(
      '完成安全密钥验证失败：CLIENT_SECURITY_KEY 未配置。请只在本地 .env 中配置6位安全密钥。'
    );
  }

  if (!/^\d{6}$/.test(securityKey)) {
    throw new Error('完成安全密钥验证失败：CLIENT_SECURITY_KEY 必须配置为6位数字。');
  }

  return securityKey;
}
