# Fidere Live Run Monitor

Live Monitor is a local, optional observer for Flow Engine business events. It uses one shared SSE event stream and one Dashboard for every Flow. It does not parse terminal output and it never controls Playwright.

## Start

```powershell
npm run test:live
npm run test:live -- --flow corporate-registration
npm run test:live -- --flow registration
```

Live mode starts a local URL on an available `127.0.0.1` port, opens the Dashboard, and runs the selected Playwright command headed. Safe Dry Runs remain non-mutation commands. `--flow corporate-registration` selects `REG-C-002` and therefore requires an explicit one-run confirmation plus `ALLOW_CLIENT_MUTATION_TESTS=true`; it must never run from regression or without named authorization.

For automated verification, `--no-open --exit-after-run` suppresses the OS browser launch and closes the local server after the test finishes. `--headless` is available for monitor infrastructure checks; interactive Live execution defaults to headed.

## Defaults

| Level / Journey | Default |
| --- | --- |
| L0 Smoke | Off |
| L1 Validation | Off |
| L2 Readonly | Off |
| L3 Dry Run | Optional for complex Flows |
| L4 Mutation E2E | Recommended after explicit mutation authorization |
| Fresh User / Corporate / US Opening / complex Wealth | On when launched through `test:live` |
| `npm run regression` | Off and headless |

Mutation Flows still require the exact confirmation phrase and every registered safety switch. Live Monitor never edits `.env`.

## Event Contract

The shared reporter emits `RUN_STARTED`, `CASE_STARTED`, step-plan/progress/result events, whitelisted business-data updates, document progress, Resume changes, mutation boundaries, and case/run completion. When `FIDERE_LIVE_MONITOR_URL` and `FIDERE_LIVE_RUN_ID` are absent, event delivery is a no-op.

The client uses a short, best-effort queue. If the local server becomes unavailable, Live delivery disables itself and the Flow continues unchanged. Screenshots remain governed by Playwright's failure evidence policy; the monitor never captures per-step screenshots.
# Journey support

The shared Live Monitor also accepts Journey-level events. A Golden Journey keeps its nine-Flow progress, current Flow, current balance, Resume Flow, and mutation count while the existing detail area continues to show the active child Flow's internal steps. This is the same observer service; no Journey-specific Dashboard process is required.

Live Monitor remains optional and fail-open. A Dashboard start, event-post, or persistence error cannot change a Playwright or Journey result.
