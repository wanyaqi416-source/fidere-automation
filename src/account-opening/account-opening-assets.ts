import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export type UsOpeningDocumentField =
  | '护照'
  | '身份证明'
  | '手持护照自拍'
  | '住址证明'
  | '资金来源证明';

const US_OPENING_DOCUMENT_DEFINITIONS = [
  { field: '护照', fileName: 'passprot.jpg' },
  {
    field: '身份证明',
    fileName: '01_SANDBOX_identity_proof_placeholder_NOT_GOVERNMENT_ID.pdf'
  },
  { field: '手持护照自拍', fileName: 'selfie.jpg' },
  {
    field: '住址证明',
    fileName: '02_SANDBOX_proof_of_address_utility_bill_TEST_ONLY.pdf'
  },
  {
    field: '资金来源证明',
    fileName: '03_SANDBOX_source_of_funds_salary_savings_TEST_ONLY.pdf'
  }
] as const satisfies readonly { field: UsOpeningDocumentField; fileName: string }[];

export type UsOpeningDocumentAsset = {
  field: UsOpeningDocumentField;
  fileName: string;
  path: string;
};

export function resolveUsOpeningDocumentAssets(): UsOpeningDocumentAsset[] {
  const assets = US_OPENING_DOCUMENT_DEFINITIONS.map(item => ({
    ...item,
    path: resolve(process.cwd(), 'test-assets', 'account-opening', item.fileName)
  }));
  const missing = assets.filter(asset => !existsSync(asset.path));
  if (missing.length > 0) {
    throw new Error(
      `Missing required Sandbox account-opening asset(s): ${missing.map(asset => basename(asset.path)).join(', ')}`
    );
  }
  return assets;
}
