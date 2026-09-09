# Corporate Registration Sandbox Assets

## 扫描结论

- 扫描范围：仅 `D:\image` 及其子目录。
- 扫描时间：2026-09-02。
- 允许扩展名：`.jpg`、`.jpeg`、`.png`、`.pdf`。
- 共发现 14 个候选文件：14 个 PNG，0 个 JPG/JPEG，0 个 PDF。
- 按最新授权，目录中的 PNG 均可作为 Sandbox 上传占位图，可跨字段重复复用，不再按内容语义或敏感性排除。
- 成功匹配：28 个上传位置；复制到项目：28 个标准化 PNG；待准备：0 个。

本轮没有移动、删除、重命名或修改 `D:\image` 中的任何原始文件。

## 页面上传契约

Recon 已确认所有上传字段使用同一契约：

- 支持 PNG、JPG、JPEG、PDF；没有 PDF-only 字段。
- 单文件最大 10 MB（10,485,760 bytes）。
- 每个业务字段最多 1 个文件。原生 input 虽带 `multiple`，真实组件配置为 `maxFiles=1`。
- 上传成功后显示文件名、文件大小、进度和移除入口。
- 前端已确认扩展名/MIME和大小校验；服务端内容语义校验仍需 Upload Dry Run 确认。

## 全分支资产清单

全分支共 28 个上传位置：20 个固定必填、4 个可选、4 个条件必填。自然人董事和法人董事是互斥分支，单次 Happy Path 不会同时上传全部 28 份。

| 序号 | 页面字段 | 分支/步骤 | 必填 | 支持格式 | 最大大小 | 多文件 | 目标测试文件 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 公司注册证书 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `01_company_registration_certificate_SANDBOX.png` | READY |
| 2 | 商业登记证 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `02_business_registration_certificate_SANDBOX.png` | READY |
| 3 | 董事会决议 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `03_board_resolution_SANDBOX.png` | READY |
| 4 | 公司章程 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `04_articles_of_association_SANDBOX.png` | READY |
| 5 | 地址证明 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `05_company_address_proof_SANDBOX.png` | READY |
| 6 | 董事名单 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `06_director_register_SANDBOX.png` | READY |
| 7 | 股东名册 | 运营信息 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `07_shareholder_register_SANDBOX.png` | READY |
| 8 | 反洗钱手册 | 合规问询 | 否 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `08_aml_manual_SANDBOX.png` | READY |
| 9 | 证件正面 | 授权代表 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `09_authorized_representative_id_front_SANDBOX.png` | READY |
| 10 | 证件反面 | 授权代表 | 否 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `10_authorized_representative_id_back_SANDBOX.png` | READY |
| 11 | 居住地址证明 | 授权代表 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `11_authorized_representative_address_proof_SANDBOX.png` | READY |
| 12 | 邮寄地址证明 | 授权代表 | 地址不同时 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `12_authorized_representative_mailing_address_proof_SANDBOX.png` | READY |
| 13 | 证件正面 | 自然人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `13_natural_director_id_front_SANDBOX.png` | READY |
| 14 | 证件反面 | 自然人董事 | 否 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `14_natural_director_id_back_SANDBOX.png` | READY |
| 15 | 居住地址证明 | 自然人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `15_natural_director_address_proof_SANDBOX.png` | READY |
| 16 | 邮寄地址证明 | 自然人董事 | 地址不同时 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `16_natural_director_mailing_address_proof_SANDBOX.png` | READY |
| 17 | 公司注册证书 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `17_legal_director_registration_certificate_SANDBOX.png` | READY |
| 18 | 商业登记证 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `18_legal_director_business_registration_SANDBOX.png` | READY |
| 19 | 公司章程 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `19_legal_director_articles_of_association_SANDBOX.png` | READY |
| 20 | 董事名单 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `20_legal_director_register_SANDBOX.png` | READY |
| 21 | 股东名册 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `21_legal_director_shareholder_register_SANDBOX.png` | READY |
| 22 | 董事会决议 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `22_legal_director_board_resolution_SANDBOX.png` | READY |
| 23 | 地址证明 | 法人董事 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `23_legal_director_address_proof_SANDBOX.png` | READY |
| 24 | 邮寄地址证明 | 法人董事 | 地址不同时 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `24_legal_director_mailing_address_proof_SANDBOX.png` | READY |
| 25 | 证件正面 | 个人股东 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `25_natural_shareholder_id_front_SANDBOX.png` | READY |
| 26 | 证件反面 | 个人股东 | 否 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `26_natural_shareholder_id_back_SANDBOX.png` | READY |
| 27 | 居住地址证明 | 个人股东 | 是 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `27_natural_shareholder_address_proof_SANDBOX.png` | READY |
| 28 | 邮寄地址证明 | 个人股东 | 地址不同时 | PNG/JPG/JPEG/PDF | 10 MB | 否 | `28_natural_shareholder_mailing_address_proof_SANDBOX.png` | READY |

## 候选文件审查

| 候选文件 | 完整路径 | 大小 | 尺寸 | 格式/大小合规 | 隐私结论 | 使用结论 |
| --- | --- | ---: | --- | --- | --- | --- |
| `b4da51b8-5f15-45fe-9293-2904a4227d63.png` | `D:\image\b4da51b8-5f15-45fe-9293-2904a4227d63.png` | 1,427,476 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月20日 18_29_07.png` | `D:\image\ChatGPT Image 2026年8月20日 18_29_07.png` | 999,207 bytes | 1254x1254 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 17_48_29 (1).png` | `D:\image\ChatGPT Image 2026年8月5日 17_48_29 (1).png` | 1,470,229 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 17_48_30 (2).png` | `D:\image\ChatGPT Image 2026年8月5日 17_48_30 (2).png` | 1,368,246 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 17_48_30 (3).png` | `D:\image\ChatGPT Image 2026年8月5日 17_48_30 (3).png` | 1,383,986 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 18_00_15.png` | `D:\image\ChatGPT Image 2026年8月5日 18_00_15.png` | 1,383,986 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 18_13_15.png` | `D:\image\ChatGPT Image 2026年8月5日 18_13_15.png` | 1,377,605 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 18_25_22.png` | `D:\image\ChatGPT Image 2026年8月5日 18_25_22.png` | 1,260,869 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 18_40_54.png` | `D:\image\ChatGPT Image 2026年8月5日 18_40_54.png` | 1,328,243 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `ChatGPT Image 2026年8月5日 18_44_30.png` | `D:\image\ChatGPT Image 2026年8月5日 18_44_30.png` | 1,535,463 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `tiger-brokers-logo-60x60.png` | `D:\image\tiger-brokers-logo-60x60.png` | 3,471 bytes | 60x60 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `tiger-brokers-logo-70x70.png` | `D:\image\tiger-brokers-logo-70x70.png` | 4,202 bytes | 70x70 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `tiger-brokers-official-square.png` | `D:\image\tiger-brokers-official-square.png` | 113,273 bytes | 1024x1024 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |
| `新加坡国旗圆形图标_满版1254.png` | `D:\image\新加坡国旗圆形图标_满版1254.png` | 76,266 bytes | 1254x1254 | 是 | 不作限制 | 已作为 Sandbox 占位图复用 |

## 首条 Happy Path 最小准备集

推荐分支仍为：1 名授权代表、1 名自然人董事、1 名个人股东，并让邮寄地址与居住地址相同。

页面固定必填的最小集合是文件 1-7、9、11、13、15、25、27，共 13 份。为了同时覆盖可选 AML、证件反面和条件地址字段，完整自然人路径需要文件 1-16、25-28，共 20 份。

按最新授权，不要求占位图包含固定测试文案，并允许不同字段重复复用同一 PNG。28 个目标文件均已生成，Corporate Registration Upload Dry Run 的文件资产条件已就绪。
