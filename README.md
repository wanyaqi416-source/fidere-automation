# Fidere Automation

Playwright + TypeScript black-box automation for the deployed Fidere Client and Admin systems. Both systems live in this repository while keeping tests, Page Objects, fixtures, environment configuration, and authentication state separate.

## Setup

Requirements: Node.js 18 or newer, npm, and access to both deployed test environments.

```powershell
npm install
npm run install:browsers
Copy-Item .env.example .env
```

Set real environment values in `.env`:

```dotenv
CLIENT_BASE_URL=
CLIENT_USERNAME=
CLIENT_PASSWORD=

ADMIN_BASE_URL=
ADMIN_USERNAME=
ADMIN_PASSWORD=
```

Base URLs are required by environment and workflow tests. Account values are loaded only when an authenticated fixture is requested.

## Test Commands

```powershell
npm run test:client
npm run test:admin
npm run test:workflows
npm run test:smoke
npm run test:validation
npm run test:readonly
npm run test:dry-run
npm run regression
npm run test:menu
npm run test:money
```

| Command | Scope |
| --- | --- |
| `npm run test:client` | All Client tests in the `client` Playwright project. |
| `npm run test:admin` | All Admin tests in the `admin` Playwright project. |
| `npm run test:workflows` | Cross-system tests using isolated Client and Admin contexts. |
| `npm run test:smoke` | L0 Client/Admin Smoke；不执行Mutation。 |
| `npm run test:validation` | L1真实页面校验；停在最终提交或安全密钥验证前。 |
| `npm run test:readonly` | 可重复的L2历史证据与终态只读复核。 |
| `npm run test:dry-run` | 可重复的L3双端/审批表单预检；最终Admin动作点击0次。 |
| `npm run regression` | L0-L3安全回归；显式排除`@mutation`和`@money`。 |
| `npm run test:menu` | Registry驱动的中文测试菜单。 |
| `npm run test:money` | 一次只选择一个L4资金Flow，并要求严格文本确认。 |
| `npm test` | Playwright全部项目；不作为默认安全回归命令。 |

依赖特定Resume环境变量或特定历史订单仍出现在Admin列表中的检查保留为专项命令，不进入默认L2/L3/Regression。资金Flow必须使用`test:money`或明确的单Flow命令，并同时通过代码内Mutation Guard。

Supporting commands:

```powershell
npm run typecheck
npm run test:headed
npm run test:debug
npm run test:ui
npm run report:business
npm run report:history
npm run report:playwright
```

## Test Reports

- `npm run report:business`: opens `reports/business/latest.html` for testers, product owners, and business reviewers. It contains Chinese business steps, expected and actual results, sanitized business data, failure analysis, and evidence links.
- `npm run report:history`: opens `reports/business/history/index.html`, where every successful, warning, failed, blocked, or manual-review Run remains independently accessible and filterable.
- `npm run report:playwright`: opens the Playwright HTML report for developers to inspect failed actions, Trace, and network behavior.
- `reports/junit-results.xml`: machine-readable output for CI and test platforms; it is not intended for manual reading.

Every Playwright run keeps the List, Playwright HTML, and JUnit reporters and also generates:

```text
reports/business/latest.html
reports/business/latest.json
reports/business/history/index.html
reports/business/history/index.json
reports/business/history/<runId>/report.html
reports/business/history/<runId>/report.json
```

`latest` always points to the newest execution and may be overwritten. A runId history directory is created once and never overwritten; failed Runs are archived exactly like passing Runs. The static history page supports module, Flow, date, result, priority, and scope filters, uses no external assets, and never starts a persistent report server.

DP-003's first successful Deposit path is fixed to `香港账户 / USD`. It uses the account-domain `AccountBalanceReader` shared with Transfer and remains `In Progress` until a real Client + Admin claim succeeds.

## Project Structure

```text
.
|-- auth/
|   |-- client.json             # Generated Client storageState; ignored by Git
|   `-- admin.json              # Generated Admin storageState; ignored by Git
|-- fixtures/
|   |-- client.fixture.ts       # Client account fixtures
|   |-- admin.fixture.ts        # Admin account fixtures
|   `-- workflow.fixture.ts     # Two independent BrowserContexts and pages
|-- pages/
|   |-- client/                 # Client Page Objects only
|   `-- admin/                  # Admin Page Objects only
|-- src/
|   |-- config/                 # Environment and auth-state configuration
|   |-- data/                   # Truly shared test data/builders
|   |-- reporting/              # Business report API, masking, and HTML rendering
|   `-- utils/                  # Truly shared utilities
|-- reporters/                  # Playwright custom reporters
|-- tests/
|   |-- setup/
|   |   `-- client.auth.setup.ts # Fresh Client login before each Client command
|   |-- client/
|   |   |-- smoke/
|   |   `-- regression/
|   |-- admin/
|   |   |-- smoke/
|   |   `-- regression/
|   `-- workflows/              # Client/Admin cross-system workflows
|-- playwright.config.ts
`-- tsconfig.json
```

## Isolation Model

- Client tests import `fixtures/client.fixture.ts` and Page Objects from `pages/client`.
- The `client` project depends on `client-auth`. Every Client command logs in once with a clean context, overwrites `auth/client.json`, and only then starts the selected Client tests.
- `npm run auth:client` is an optional setup-only debugging command. It is not required before normal Client commands.
- Admin tests import `fixtures/admin.fixture.ts` and Page Objects from `pages/admin`.
- Workflow tests import `fixtures/workflow.fixture.ts`, which creates separate `clientContext` and `adminContext` instances from the same browser process. It exposes `clientPage` and `adminPage` without sharing cookies, local storage, session storage, or storageState.
- Client authentication reads `CLIENT_BASE_URL`, `CLIENT_USERNAME`, `CLIENT_PASSWORD`, and `CLIENT_OTP`. The generated `auth/client.json` is command-scoped cache material, not a permanent credential.
- Admin uses `ADMIN_BASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `auth/admin.json`.
- The state files are optional until login automation generates them. A missing state file means a fresh unauthenticated context; it is never replaced with fabricated login data.

## Testing Guidelines

- Keep Client and Admin tests, fixtures, and Page Objects within their own boundaries.
- Share only utilities or data that are genuinely system-agnostic.
- Prefer stable user-facing locators after inspecting the real UI.
- Never commit `.env`, credentials, or generated storageState files.
- Keep Client automatic authentication separate from money authorization. `client-auth` never changes `ALLOW_MONEY_TESTS`, and money tests remain disabled by default.
- Do not use fixed waits or skipped assertions to hide navigation and readiness failures.

## Current Status

Client login, smoke coverage, exchange pre-submit validation, and exchange security-key validation are available. The real exchange mutation remains disabled unless its dedicated safety switch is explicitly approved.
