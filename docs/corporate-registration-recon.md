# Corporate Registration Recon

## Recon边界

- Sandbox Draft：`t6****@mowan666.com`
- Client路由：`/zh-CN/registration?type=corporate`
- 企业账号创建：已完成1次
- 企业KYC最终提交：0次
- 文件上传：0次
- 代表/董事/股东档案创建：0次
- 电子签名：0次

## 页面关系

企业注册首页展示9个步骤。每个步骤使用同一路由并通过`step`参数区分：

| Step | 页面 | URL | 真实状态 |
| --- | --- | --- | --- |
| 1 | 基本档案 | `/zh-CN/registration?step=1&type=corporate` | 已实际打开 |
| 2 | 运营信息 | `/zh-CN/registration?step=2&type=corporate` | 已实际打开 |
| 3 | 资产来源 | `/zh-CN/registration?step=3&type=corporate` | 已实际打开 |
| 4 | 合规问询 | `/zh-CN/registration?step=4&type=corporate` | 已实际打开 |
| 5 | 授权代表 | `/zh-CN/registration?step=5&type=corporate` | 已实际打开 |
| 6 | 企业董事 | `/zh-CN/registration?step=6&type=corporate` | 自然人/法人分支均已实际打开 |
| 7 | 企业股东 | `/zh-CN/registration?step=7&type=corporate` | 个人/企业分支均已实际打开 |
| 8 | 电子签名（页面标题“授权”） | `/zh-CN/registration?step=8&type=corporate` | 已实际打开；因未创建授权代表显示“暂无数据/未找到授权代表” |
| 9 | 提交申请 | `/zh-CN/registration?step=9&type=corporate` | 已实际打开；“提交”未点击 |

## 真实业务字段

### 1. 基本档案

企业英文名称、注册成立日期、英文注册地址、州/省（可选）、注册号码、注册国家、英文经营地址、邮政编码。

空表单校验明确要求除州/省外的上述字段。

### 2. 运营信息

手机国家区号、手机号码、电子邮箱、业务性质、邮寄地址是否与注册地址相同，以及7类公司文件：

公司注册证书、商业登记证、董事会决议、公司章程、地址证明、董事名单、股东名册。

业务性质真实选项包括零售业、运输与仓储、信息技术、半导体、金融服务、健康护理、生物科技、新闻媒体、军事与国防工业、航空航天、建筑、房地产、制造业和批发贸易。

### 3. 资产来源

主要来源为多选：投资收益、营业收入、金融机构贷款、股东及/或投资者注资、租金收入、其他。

### 4. 合规问询

是否受美国制裁、主要股东是否为政治人物、主要成员是否与政治人物有关、是否受监管或有KYC/AML流程、反洗钱手册（可选）、开户目的。

开户目的为单选列表，实际页面包含税务、资产负债隔离、支付/收款、商业投资、贷款结算、担保品存管、储蓄、股权管理、运营薪资、贸易、现金流、托管、金融机构资金和慈善/特殊目的信托等选项。

### 5. 授权代表

国籍、性别、英文姓/名、是否最终受益人、证件类型（身份证/护照/驾照）、证件号码、签发日、有效期、出生日期、证件正反面、手机、邮箱、居住地址、国家、城市、街道、州/省、邮编、居住地址证明、邮寄地址是否相同。邮寄地址不同时追加完整邮寄地址和邮寄地址证明。

### 6. 企业董事

支持添加多个自然人董事和法人董事。

- 自然人董事：字段结构与授权代表一致，包括最终受益人选择、身份资料、联系方式和地址资料。
- 法人董事：企业英文名称、注册号、成立日期、注册国家、街道、英文经营地址、州/省、邮编、手机、邮箱、6类企业文件、业务性质、邮寄地址、地址证明；邮寄地址不同时追加邮寄地址证明。

### 7. 企业股东

支持添加多个个人股东和企业股东。

- 个人股东：页面说明最终受益人为持股20%以上自然人；字段包括国籍、性别、英文姓/名、职位、身份资料、联系方式和地址资料。当前真实DOM未出现单独的持股比例输入框。
- 企业股东：企业英文名称、注册号码、成立日期、注册国家；当前分支无上传字段。

### 8. 授权

企业注册存在内嵌Documenso第三方签署。授权代表创建后，Fidere通过`POST /api/kyb/init-doc-sign`初始化文档并加载`app.documenso.com` iframe。真实DOM已确认与个人注册使用同一内层签署契约：绿色`Next Field / 下一个字段`跳转到PDF签名字段，Canvas绘制固定`TEST`，完成后Remaining Fields归零，再执行Complete和Sign确认。

Corporate仍使用独立`CorporateRegistrationSigner`管理Fidere授权页、文档初始化和企业签署人关联；只有在验证内层DOM相同后才委托`RegistrationAgreementSigner`执行共享Documenso生命周期。US Account Opening的`DocumentSigningPage`具体Locator没有用于本流程。

### 9. 提交申请

页面显示“返回”和“提交”。REG-C-002真实Run在签署完成且Remaining Fields=0后单击“提交”1次，`POST /api/kyb/submit-application`返回HTTP 200，Client进入“等待审核”。

## 上传契约

- 接受格式：PNG、JPG、JPEG、PDF。
- 最大文件大小：10 MB（`10,485,760` bytes）。
- 每个业务字段最多1个文件。原生input带`multiple`，但真实上传组件配置`maxFiles=1`。
- 页面没有任何PDF-only字段。
- 当前前端只发现扩展名/MIME和大小校验，未发现文档内容语义校验；服务端内容校验仍待上传Dry Run确认。
- 未实际测试重复文件；自动化Mapping要求每个字段使用不同资产，主动禁止一图多用。
- 上传成功组件会显示文件名、文件大小（MB）、进度和移除入口。

## Page Object规划

| Page Object | 责任 |
| --- | --- |
| `RegistrationAccountPage`（共享能力） | Email、密码、OTP、协议、账号创建 |
| `AccountTypeSelectionPage` | 选择企业账户 |
| `CorporateRegistrationPage` | 企业步骤首页、步骤导航、通用Recon和上传Label契约 |
| `CorporateBasicProfilePage` | Step 1企业基础资料 |
| `CorporateOperationsPage` | Step 2联系方式、业务性质和公司文件 |
| `CorporateSourceOfAssetsPage` | Step 3资产来源多选 |
| `CorporateCompliancePage` | Step 4合规问题、AML文件、开户目的 |
| `CorporateRepresentativePage` | Step 5授权代表及自然人资料 |
| `CorporateDirectorsPage` | Step 6董事列表和自然人/法人董事表单 |
| `CorporateShareholdersPage` | Step 7股东列表和个人/企业股东表单 |
| `CorporateRegistrationSigner` | Step 8企业授权页、文档初始化与企业签署人关联；验证相同内层DOM后复用Documenso生命周期 |
| `CorporateSubmissionPage` | Step 9最终提交单次点击保护 |

## REG-C-002真实结果

1. 同一Sandbox企业Journey仅创建1个账号，未创建替代账号。
2. 企业注册共9个业务步骤；基本档案只包含基本档案，运营、资产来源、合规和授权代表分别保存。
3. 首条Happy Path只创建1名自然人董事和1名个人股东，不创建法人董事或企业股东；授权代表为唯一UBO。
4. 自然人路径实际适用资料20/20，缺失0；全分支28个资产映射继续保留供后续分支使用。
5. Corporate嵌入式Documenso Canvas `TEST`签署完成，Remaining Fields=0。
6. Corporate KYC最终提交1次，Client最终状态为“等待审核”。
7. REG-C-002结果为PASS、状态为Ready；Admin Post-Registration查询为非计分Diagnostic。
