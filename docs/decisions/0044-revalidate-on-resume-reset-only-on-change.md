---
status: accepted
date: 2026-11-16
---

# ADR-044 — Revalidate on resume, reset only on change

Numbering continues the global sequence (`ADR-001`…`ADR-043` in `../architecture/DECISIONS.md`) to avoid a clash. Plan: `docs/PLAN.md` M2. Owner approved 2026-11-16 (ADR, plan, replacement of one superseded unit test, 5-minute unconfirmed limit).

## Context and Problem Statement

`apps/web/src/providers/session-lifecycle-provider.tsx` throws away all private data and remounts the authenticated view whenever the browser window merely loses and regains attention:

| Event (protected route) | Today |
| --- | --- |
| `visibilitychange → hidden` and `pagehide` | `suspend()` → `reset()`: purge TanStack Query cache, abort private fetches, `generation + 1`, `suspended = true` → `AppShell` renders the "Loading access" screen **instead of** the tree |
| `visibilitychange → visible`, `blur → focus`, `pageshow` | `resume()` → `reset()` again: purge, `generation + 1` → `WorkspaceShell` remounts under a new key, access-context is fetched from scratch |

Result: every time the user opens another window or tab and comes back, the screen flashes the loading state and all unsaved component state (POS cart, forms) is lost. The safeguard exists to stop one actor's private data from being shown to, or acted on as, another actor after a cookie change that this tab did not witness (`ADR-013` opaque revocable session; `ADR-034` no authenticated authority without fresh proof). It was implemented as "assume the worst on every window transition". The decision is not spelled out as a numbered ADR; its description lives in `ARCHITECTURE.md` (profile/organization draft paragraph), `API.md` (profile contract) and `USE_CASE_SPECS.md` (organization settings alternative flow).

The need behind the safeguard is *detect a change of actor, session or membership before stale content is trusted*. A focus or visibility transition does not itself change anything; it is only the moment at which a change made elsewhere can become visible to this tab. Resetting unconditionally is therefore stronger than the requirement and costs the user their work.

## Considered Options

1. **Keep as is** (reset on every hide/blur/focus). Safest in memory terms, unusable day to day (owner complaint).
2. **Revalidate on resume, reset only on change** (this ADR). Keep data and the mounted tree while the window is hidden or blurred; on return, silently re-fetch `GET /me/access-context` and reset only if the actor, session or membership authority differs or cannot be confirmed.
3. **Remove all lifecycle handling** and rely on 401s. Leaves a stale actor/role on screen until the next private request; also fails to notice a different actor signed in via another tab.
4. **Cover (not unmount) the tree while hidden and re-show on revalidation.** Preserves state, but adds a visible flash and a wrapper element around every route for a benefit that Option 2's revalidation already gives.

## Decision Outcome

Choose **Option 2**. This supersedes **only** the hide/blur/focus reset of the earlier decisions (the behavior implemented in the provider and described in `ARCHITECTURE.md`/`API.md`/`USE_CASE_SPECS.md`). `ADR-013` (opaque sessions, cookie attributes, revocation) and `ADR-034` (verification contract) are not changed; no API, cookie, session or schema change.

### Behavior per event (protected routes; guest routes keep today's behavior)

| Event | New behavior |
| --- | --- |
| `visibilitychange → hidden`, window `blur` | Record `leftAt` (first departure since the last confirmation). **No reset, no unmount, no state change.** |
| `visibilitychange → visible`, window `focus` after a real `blur` | **Silent revalidation** (below). Existing 500 ms burst coalescing and an in-flight guard keep it to one request. Initial `focus` at mount is still ignored. |
| `pagehide` (any `persisted` value) | **Unchanged**: purge + `suspended` loading screen. The page may enter the back/forward cache, whose frozen heap and DOM snapshot must not hold private data, and a frozen page receives no session hint. |
| `pageshow` with `persisted`, or any resume after `pagehide` | **Unchanged**: full reset, then fresh authority load. |
| Session-change hint (BroadcastChannel / `storage` fallback) and this tab's own `notifySessionChange` (login, logout, switch) | **Unchanged**: reset immediately, also in hidden tabs. |
| Private response `401` (`SESSION_UNAUTHORIZED_EVENT`) | **Unchanged**: reset with `unauthorized`, recovery screen. |

### Silent revalidation

1. Applies only when a settled `access-context` exists in the cache (a screen with private data is mounted). If it is loading or in error there is nothing private to preserve: keep today's reset-and-refetch.
2. Fetch `me/access-context` directly (not through a visible query refetch), aborted by the private-session signal, ignoring the result if a reset happened meanwhile (epoch check).
3. Compare an **authority signature** of the cached and fresh context: `user.id`, `firstOrganizationOnboarding.eligible`, and per organization `id`, `role` and the set of branch IDs. Display names, emails, organization and branch names are not authority.
4. Outcomes:
   - 2xx and equal signature → keep everything; write the fresh data into the cache (non-authority fields refresh; no re-render if deep-equal).
   - 2xx and different signature (actor, role, organization or branch scope changed) → **full reset** (purge, abort, clear account drafts, generation + 1).
   - `401` or `403` → **full reset** (shell then shows the sign-in or denied state as it does today).
   - Network error / 5xx / request timeout (cannot confirm; each revalidation request is bounded by `REVALIDATION_TIMEOUT_MS` = 15 s so a hung request releases the in-flight guard; an abort caused by a logout/reset is not "unconfirmed"): keep the screen and retry on the next resume or `online` event; if the window was away longer than `UNCONFIRMED_HIDDEN_LIMIT_MS` (**5 minutes**, owner-approved 2026-11-16) → full reset (fail closed). A negative elapsed time (clock moved backwards) counts as exceeded. The limit is an owner-tunable constant.

### What still purges private data (must keep working)

Logout in this tab and in other tabs; login/actor/session switch (own and received hints); actor change detected by the shell's access-context query; `401` on any private response; `pagehide`/bfcache restore; revalidation outcomes above; route departure for account drafts.

### Consequences

- **Good:** returning to the tab keeps the screen, scroll and unsaved form/cart state; no loading flash; one small GET per return.
- **Security trade-off (accepted by the owner 2026-11-16):** private data and the rendered DOM stay in this tab's memory while the window is hidden or blurred, where before the tree was torn down. Threat assessment:
  - *Stale authority shown/acted on after an unseen change.* Window is from resume to the revalidation response (≈ one round trip). The server remains the security boundary: every call re-resolves actor, tenant, branch and role from the cookie, so stale UI cannot gain authority; a stale screen that submits in that window acts as the *current* cookie holder, which is the pre-existing cookie-auth property and is closed by the immediate reset on any hint or revalidation mismatch. Residual risk accepted; not mitigated by blocking input (owner asked for a silent experience).
  - *Shared device, another person signs in via another tab.* Covered by the session-change hint, delivered to hidden tabs (a frozen tab processes it on unfreeze, before or with `visibilitychange`), plus revalidation on return. If both channels are unavailable the mismatch is still caught on return.
  - *bfcache / history restore.* Unchanged: `pagehide` still purges and swaps the DOM for the loading screen before the page can be frozen; `pageshow` fully resets.
  - *Long-hidden tab holds data for hours.* Bounded by server idle/absolute session expiry (`ADR-013` baselines 24 h / 7 days; first request after expiry yields 401 → reset) and by `UNCONFIRMED_HIDDEN_LIMIT_MS` when revalidation cannot confirm. Same exposure class as a foreground tab left open; the old teardown never protected an unlocked, unattended device after the user returned.
  - *Browsers that fire `pagehide` on background*: fall back to today's full reset (safe direction).
- **Cost:** provider logic gains a small state machine and a pure authority-signature helper; one existing unit test that asserts the hide-teardown (`session-lifecycle.test.tsx`, "keeps a hidden private document closed until visibility returns") is superseded by this decision and is replaced, not loosened (see PLAN M2-T2).
- **Docs to update with the code:** `ARCHITECTURE.md` (profile/draft paragraph), `API.md` (profile contract paragraph), `USE_CASE_SPECS.md` (organization settings alternative flow).
- **Not changed:** API, schema, cookie attributes, session configuration, Native/Legacy authority, dependencies.
- **Reversible:** one provider file; restoring the old handlers brings back the previous behavior.
