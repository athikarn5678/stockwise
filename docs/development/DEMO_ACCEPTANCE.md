# Demo acceptance suite (STOCKWISE-DEMO-E2E-01)

Automated Playwright journeys for the AWS Academy Learner Lab demonstration on
Better Auth Native Live (`ADR-039`). This is a **demo gate**, not D5-P5
production acceptance: it proves only that the essential Register, Login,
Onboarding and Invitation flows work end to end on the real application.

## Run

```powershell
node tests/e2e/demo-acceptance/run-demo.mts
```

Optional: `--docker <absolute path to docker.exe>` when Docker is not on `PATH`.
Requires Docker, free ports `3202`/`3203`, and installed Playwright Chromium.

The runner starts the test-only Native browser stack
(`tests/e2e/better-auth-d5/browser-stack.mts`; see
`BETTER_AUTH_MIGRATION.md`, "Native browser acceptance stack"): the built
Next.js application and the unmodified `apps/api/src/main.ts` with
`STOCKWISE_AUTHENTICATION_AUTHORITY=native`, on a freshly migrated, NATIVE-sealed,
receipt-owned disposable PostgreSQL, with controlled non-delivery mail capture.
It then runs `playwright.demo.config.ts` and scans every retained output for
leaks. Each run writes only to a fresh `test-results/demo-acceptance/run-*`
directory (printed as `DEMO_RUN_DIRECTORY:`), ending with `demo-summary.json`.

Once the launcher has started, teardown is unconditional: whatever fails
(Playwright, an output write, a read/parse, the leak scan, validation, an
interruption), the runner requests the launcher's stop, waits (bounded) for its
own verified cleanup, independently verifies that cleanup, and only then writes
the summary. The runner deletes nothing itself. Failures are reported as
`DEMO_FAILURE:<stage>:<code>`, teardown/verification problems separately as
`DEMO_CLEANUP_FAILURE:<stage>:<code>` (codes only, never messages), followed by
`DEMO_CLEANUP_VERIFIED:YES|NO` and `DEMO_GATE:PASS|FAIL`. If the launcher does not
exit, the runner says so; the launcher then cleans up at its own run deadline,
after which `browser-stack.mts --purge-stale <run>/stack-config.json` applies.

The runner exits `0` with `DEMO_GATE:PASS` only when all of these hold:

- all four journeys pass, with no execution, validation or report failure, and
  the launcher exits `0`;
- cleanup is independently verified: `CAPTURE_LOG_SCAN:CLEAN`,
  `CAPTURE_CLEANUP:COMPLETE`, `OWNED_SOURCE_COPY_CLEANUP:COMPLETE`; no capture
  directory; every journaled Docker resource removed and absent per
  `docker inspect`; no new Docker container, network or volume and no new
  source copy compared with the pre-run snapshot; ports `3202`/`3203` released;
- no synthetic password or captured OTP, link or token appears in any retained
  run output.

Runner regression tests (deterministic, no Docker):

```powershell
node --test tests/e2e/demo-acceptance/demo-runner.test.mts
```

## Journeys

1. **Register** — real `/register` form, `202`, pending verification with no
   session, OTP from the capture, verification through the UI, no automatic
   login.
2. **Login and workspace** — sign-in, first-organization onboarding (branch
   `MAIN`), workspace and session persist across refresh, logout locks
   protected routes.
3. **Invitation** — OWNER invites a second synthetic account as `CASHIER` for
   `MAIN` through `/app/members`; the invitee opens the captured link,
   registers, verifies, signs in, explicitly accepts, and lands in the
   authorized workspace with the expected organization, role and branch.
4. **Reliability** — navigation, refresh, back/forward, logout, server-side
   authorization denials for the CASHIER and for a foreign organization.
   Every journey fails on any HTTP 5xx or uncaught browser error.

## Credentials

Identities are `d5br-demo-<run>-<label>@example.invalid` (the only recipients
the capture records). Passwords are derived in memory from a per-run random
seed held only by the runner and the Playwright process; they are never
printed or written. Reports keep no trace, video, screenshot or HTML report.
No real email is sent and no shared database is touched.

## Not covered

HTTPS/production cookies, real email delivery, AWS hosting, BFCache, rate-limit
bursts, password reset, and the D5-P5 production-only checks. Those remain
separately gated and must not be reported as passed by this suite.
