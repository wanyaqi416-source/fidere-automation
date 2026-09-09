import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const withdrawalProofRelativePath = 'test-assets/withdrawal/bank-payment-proof.png';

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maximumProofSizeBytes = 10 * 1024 * 1024;

export type WithdrawalProofAsset = {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  mimeType: 'image/png';
};

export async function validateWithdrawalProofAsset(
  projectRoot = process.cwd()
): Promise<WithdrawalProofAsset> {
  const absolutePath = path.resolve(projectRoot, withdrawalProofRelativePath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new Error(
      `缺少 Withdrawal Sandbox 测试凭证：\n${withdrawalProofRelativePath}`
    );
  }

  if (!fileStat.isFile()) {
    throw new Error(
      `缺少 Withdrawal Sandbox 测试凭证：\n${withdrawalProofRelativePath}`
    );
  }
  if (fileStat.size <= 0 || fileStat.size >= maximumProofSizeBytes) {
    throw new Error('Withdrawal Sandbox 测试凭证必须是小于10MB的非空PNG文件。');
  }

  const signature = (await readFile(absolutePath)).subarray(0, pngSignature.length);
  if (!signature.equals(pngSignature)) {
    throw new Error('Withdrawal Sandbox 测试凭证不是合法PNG文件。');
  }

  return {
    absolutePath,
    relativePath: withdrawalProofRelativePath,
    fileName: path.basename(withdrawalProofRelativePath),
    sizeBytes: fileStat.size,
    mimeType: 'image/png'
  };
}
