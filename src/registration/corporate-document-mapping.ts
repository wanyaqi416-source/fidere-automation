export type CorporateRegistrationStep =
  | '运营信息'
  | '合规问询'
  | '授权代表'
  | '企业董事'
  | '企业股东';

export type CorporateDocumentVariant =
  | 'company'
  | 'authorized-representative'
  | 'natural-director'
  | 'legal-director'
  | 'natural-shareholder';

export type CorporateDocumentDefinition = {
  id: string;
  step: CorporateRegistrationStep;
  variant: CorporateDocumentVariant;
  field: string;
  pageLabel: string;
  asset: string;
  required: boolean;
  conditional?: string;
  formats: readonly ['PNG', 'JPG', 'JPEG', 'PDF'];
  maxBytes: 10_485_760;
  maxFiles: 1;
};

const assetRoot = 'test-assets/corporate-registration';
const commonUploadContract = {
  formats: ['PNG', 'JPG', 'JPEG', 'PDF'] as const,
  maxBytes: 10_485_760 as const,
  maxFiles: 1 as const
};

function document(
  input: Omit<CorporateDocumentDefinition, 'formats' | 'maxBytes' | 'maxFiles' | 'asset'> & {
    fileName: string;
  }
): CorporateDocumentDefinition {
  const { fileName, ...definition } = input;
  return {
    ...definition,
    asset: `${assetRoot}/${fileName}`,
    ...commonUploadContract
  };
}

export const CORPORATE_DOCUMENT_MAPPING: readonly CorporateDocumentDefinition[] = [
  document({ id: 'company-registration-certificate', step: '运营信息', variant: 'company', field: 'registration_certificate', pageLabel: '公司注册证书', fileName: '01_company_registration_certificate_SANDBOX.png', required: true }),
  document({ id: 'business-registration-certificate', step: '运营信息', variant: 'company', field: 'business_registration_certificate', pageLabel: '商业登记证', fileName: '02_business_registration_certificate_SANDBOX.png', required: true }),
  document({ id: 'board-resolution', step: '运营信息', variant: 'company', field: 'board_resolution', pageLabel: '董事会决议', fileName: '03_board_resolution_SANDBOX.png', required: true }),
  document({ id: 'articles-of-association', step: '运营信息', variant: 'company', field: 'articles_of_association', pageLabel: '公司章程', fileName: '04_articles_of_association_SANDBOX.png', required: true }),
  document({ id: 'company-address-proof', step: '运营信息', variant: 'company', field: 'address_proof', pageLabel: '地址证明', fileName: '05_company_address_proof_SANDBOX.png', required: true }),
  document({ id: 'director-register', step: '运营信息', variant: 'company', field: 'directors_shareholders_register', pageLabel: '董事名单', fileName: '06_director_register_SANDBOX.png', required: true }),
  document({ id: 'shareholder-register', step: '运营信息', variant: 'company', field: 'shareholder_register', pageLabel: '股东名册', fileName: '07_shareholder_register_SANDBOX.png', required: true }),
  document({ id: 'aml-manual', step: '合规问询', variant: 'company', field: 'aml_manual', pageLabel: '反洗钱手册（可选）', fileName: '08_aml_manual_SANDBOX.png', required: false }),
  document({ id: 'authorized-representative-id-front', step: '授权代表', variant: 'authorized-representative', field: 'id_photo_front', pageLabel: '证件正面', fileName: '09_authorized_representative_id_front_SANDBOX.png', required: true }),
  document({ id: 'authorized-representative-id-back', step: '授权代表', variant: 'authorized-representative', field: 'id_photo_back', pageLabel: '证件反面（可选）', fileName: '10_authorized_representative_id_back_SANDBOX.png', required: false }),
  document({ id: 'authorized-representative-address-proof', step: '授权代表', variant: 'authorized-representative', field: 'address_proof', pageLabel: '居住地址证明', fileName: '11_authorized_representative_address_proof_SANDBOX.png', required: true }),
  document({ id: 'authorized-representative-mailing-proof', step: '授权代表', variant: 'authorized-representative', field: 'mailing_address_proof', pageLabel: '邮寄地址证明', fileName: '12_authorized_representative_mailing_address_proof_SANDBOX.png', required: false, conditional: '邮寄地址与居住地址不同' }),
  document({ id: 'natural-director-id-front', step: '企业董事', variant: 'natural-director', field: 'id_photo_front', pageLabel: '证件正面', fileName: '13_natural_director_id_front_SANDBOX.png', required: true }),
  document({ id: 'natural-director-id-back', step: '企业董事', variant: 'natural-director', field: 'id_photo_back', pageLabel: '证件反面（可选）', fileName: '14_natural_director_id_back_SANDBOX.png', required: false }),
  document({ id: 'natural-director-address-proof', step: '企业董事', variant: 'natural-director', field: 'address_proof', pageLabel: '居住地址证明', fileName: '15_natural_director_address_proof_SANDBOX.png', required: true }),
  document({ id: 'natural-director-mailing-proof', step: '企业董事', variant: 'natural-director', field: 'mailing_address_proof', pageLabel: '邮寄地址证明', fileName: '16_natural_director_mailing_address_proof_SANDBOX.png', required: false, conditional: '邮寄地址与居住地址不同' }),
  document({ id: 'legal-director-registration-certificate', step: '企业董事', variant: 'legal-director', field: 'registration_certificate', pageLabel: '公司注册证书', fileName: '17_legal_director_registration_certificate_SANDBOX.png', required: true }),
  document({ id: 'legal-director-business-registration', step: '企业董事', variant: 'legal-director', field: 'business_registration_certificate', pageLabel: '商业登记证', fileName: '18_legal_director_business_registration_SANDBOX.png', required: true }),
  document({ id: 'legal-director-articles', step: '企业董事', variant: 'legal-director', field: 'articles_of_association', pageLabel: '公司章程', fileName: '19_legal_director_articles_of_association_SANDBOX.png', required: true }),
  document({ id: 'legal-director-register', step: '企业董事', variant: 'legal-director', field: 'director_register', pageLabel: '董事名单', fileName: '20_legal_director_register_SANDBOX.png', required: true }),
  document({ id: 'legal-director-shareholder-register', step: '企业董事', variant: 'legal-director', field: 'shareholder_register', pageLabel: '股东名册', fileName: '21_legal_director_shareholder_register_SANDBOX.png', required: true }),
  document({ id: 'legal-director-board-resolution', step: '企业董事', variant: 'legal-director', field: 'board_resolution', pageLabel: '董事会决议', fileName: '22_legal_director_board_resolution_SANDBOX.png', required: true }),
  document({ id: 'legal-director-address-proof', step: '企业董事', variant: 'legal-director', field: 'address_proof', pageLabel: '地址证明', fileName: '23_legal_director_address_proof_SANDBOX.png', required: true }),
  document({ id: 'legal-director-mailing-proof', step: '企业董事', variant: 'legal-director', field: 'mailing_address_proof', pageLabel: '邮寄地址证明', fileName: '24_legal_director_mailing_address_proof_SANDBOX.png', required: false, conditional: '邮寄地址与注册地址不同' }),
  document({ id: 'natural-shareholder-id-front', step: '企业股东', variant: 'natural-shareholder', field: 'id_photo_front', pageLabel: '证件正面', fileName: '25_natural_shareholder_id_front_SANDBOX.png', required: true }),
  document({ id: 'natural-shareholder-id-back', step: '企业股东', variant: 'natural-shareholder', field: 'id_photo_back', pageLabel: '证件反面（可选）', fileName: '26_natural_shareholder_id_back_SANDBOX.png', required: false }),
  document({ id: 'natural-shareholder-address-proof', step: '企业股东', variant: 'natural-shareholder', field: 'address_proof', pageLabel: '居住地址证明', fileName: '27_natural_shareholder_address_proof_SANDBOX.png', required: true }),
  document({ id: 'natural-shareholder-mailing-proof', step: '企业股东', variant: 'natural-shareholder', field: 'mailing_address_proof', pageLabel: '邮寄地址证明', fileName: '28_natural_shareholder_mailing_address_proof_SANDBOX.png', required: false, conditional: '邮寄地址与居住地址不同' })
];

export const CORPORATE_NATURAL_HAPPY_PATH_DOCUMENTS = CORPORATE_DOCUMENT_MAPPING.filter(
  definition => definition.variant !== 'legal-director'
);
