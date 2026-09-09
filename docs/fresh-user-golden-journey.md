# Fresh User Golden Journey v1

## Purpose

`Fresh User Golden Journey` is an orchestration layer. It does not own Client or Admin DOM selectors and does not duplicate Exchange, Transfer, Deposit, Withdrawal, or Account Opening behavior.

The Journey calls a Registry Flow only when all of these are true:

- Flow Capability status is `Ready` or `Mutation Ready`; a Specific Run Resume state is not a capability status.
- The Flow is implemented and has a registered command.
- A Fresh User adapter accepts the Journey identity and writes the Flow references and balances back to `JourneyContext`.
- The current user, account, balance, Admin session, and third-party prerequisites pass before that Flow starts.

`Ready` in the Flow Registry alone is not sufficient. A historical Resume command is not a Fresh User adapter.

## Commands

```text
npm run test:journey:fresh-user:readiness
npm run test:journey:fresh-user
```

The readiness command is read-only. The execution command first runs the same checks. Only a blocked Required Flow prevents confirmation; an unavailable Optional Flow is reported as `SKIPPED_PREREQUISITE` or `SKIPPED_NOT_READY`.

When all steps are ready, execution requires the exact phrase:

```text
EXECUTE fresh-user-journey
```

The runner does not edit `.env`. Domain Mutation Guards remain authoritative, and every child Flow runs headed with one worker, zero retries, and one repeat.

The budget reads `JOURNEY_INITIAL_USD_BALANCE` and known cost hints, then adds `JOURNEY_BUDGET_SAFETY_MARGIN`. An unknown optional fee does not block the Journey when the configured balance is above known costs plus the safety margin. Domain pages remain the execution-time source of truth.

## Context

Journey state is stored under `.journey-context/fresh-user/`, which is ignored by Git. It may contain the synthetic Sandbox user identity, balances, domain references, per-Flow status, Resume Flow, and mutation count.

It must never contain passwords, OTPs, Security Keys, cookies, tokens, Authorization headers, or storageState.

## Reports

- Latest: `reports/journey/latest.html`
- History: `reports/journey/history/<journeyId>/report.html`
- History index: `reports/journey/history/index.html`

Rendered identities and business references are masked. A readiness report always records `Mutation Count = 0`.

## Current Readiness Contract

| Step | Requirement | Current Journey disposition |
| --- | --- | --- |
| J-001 REG-P-002 | Required | Ready; local pool can deterministically generate an unused Sandbox identity |
| J-002 REG-P-003 | Required | Ready; explicitly targets this Journey registration runId |
| J-003 Balance Bootstrap | Required | Ready; exact configured credit, independent Resume state, TXN and Decimal balance Oracle |
| J-004 EX-001 | Optional | Skip prerequisite while the Fresh User has no supported source asset |
| J-005 TR-003 | Optional | Skip prerequisite while the Fresh User has no broker account |
| J-006 DP-003 | Optional | Ready; Fresh User input and TXN/balance output are connected |
| J-007 WD-003 | Optional | Skip not ready until the Fresh Withdrawal adapter exists |
| J-008 OPEN-BH-003 | Optional | Skip not ready until the Mutation implementation exists |
| J-009 OPEN-US-003 | Optional | Capability Ready; skip not ready until a Fresh User adapter is connected |

## Execution Disposition

- `PASS`: continue.
- Diagnostic-only information: continue and do not affect statistics.
- `SKIPPED_NOT_APPLICABLE`: continue.
- `SKIPPED_PREREQUISITE`: continue and do not count as failure.
- `SKIPPED_NOT_READY`: continue and do not count as failure.
- Pre-mutation `BLOCKED`: record it; only independent later steps may continue.
- `FAIL`: pause at the current Flow.
- Unknown post-mutation state: persist Resume and stop all later mutations.
