# StockWise Learner Lab — multi-role manual UAT guide

Site: <https://stockwise.hcn920.com/login>. Real authentication and real RBAC only: there is no impersonation, bypass or test switch. Credentials are in the local file the operator hands over (never in Git). All records are fictional and carry the `UAT` prefix.

## 1. Roles (complete list)

StockWise has exactly **five** built-in organization roles (`ORGANIZATION_ROLES` in `apps/api/src/modules/identity/authorization-policy.ts`). There are no custom or configurable roles and no system-level (platform) role; a user holds one role per organization and may hold different roles in different organizations. `OWNER` and `ADMIN` are organization-wide; `BRANCH_MANAGER`, `INVENTORY_STAFF` and `CASHIER` act only in branches they are assigned to.

## 2. Role–permission matrix (from the implemented policy)

✔ allowed · ✖ denied · branch = only in assigned branches · ★ see note

| Capability | OWNER | ADMIN | BRANCH_MANAGER | INVENTORY_STAFF | CASHIER |
| --- | --- | --- | --- | --- | --- |
| Catalog / category view | ✔ | ✔ | ✔ branch | ✔ branch | ✔ branch |
| Catalog create / edit | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| Catalog deactivate / reactivate | ✔ | ✔ | ✔ branch | ✖ | ✖ |
| Supplier view | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| Supplier create / edit | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| Supplier deactivate | ✔ | ✔ | ✖ | ✖ | ✖ |
| Inventory view (balances, history) | ✔ | ✔ | ✔ branch | ✔ branch | ✔ branch |
| Stock adjustment | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| Purchase orders view / create / edit | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| Receiving (receipts) | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| POS checkout | ✔ | ✔ | ✔ branch | ✖ | ✔ branch |
| Whole-sale discount | ✔ | ✔ | ✔ branch | ✖ | ✖ |
| Sales history / receipts | ✔ | ✔ | ✔ branch | ✖ | ✔ branch |
| Sales cost / COGS visibility | ✔ | ✔ | ✔ branch | ✖ | ✖ |
| Create refund | ✔ | ✔ | ✔ branch | ✖ | ✖ |
| View refunds | ✔ | ✔ | ✔ branch | ✖ | ✔ branch |
| Business analytics | ✔ | ✔ | ✔ branch ★1 | ✖ | ✖ |
| Inventory analytics, forecast, reorder | ✔ | ✔ | ✔ branch | ✔ branch | ✖ |
| AI business summaries | ✔ | ✔ | ✔ branch | ✖ | ✖ |
| Sales VAT configuration | ✔ | ✔ | ✖ | ✖ | ✖ |
| Organization settings (name) | ✔ | ✔ | ✖ | ✖ | ✖ |
| Branch create / edit / deactivate | ✔ | ✔ | ✖ | ✖ | ✖ |
| View members and invitations | ✔ | ✔ | ✖ | ✖ | ✖ |
| Invite / change / remove **ADMIN** members | ✔ | ✖ ★2 | ✖ | ✖ | ✖ |
| Invite / change / remove BRANCH_MANAGER, INVENTORY_STAFF, CASHIER | ✔ | ✔ | ✖ | ✖ | ✖ |
| Invite, promote or reactivate someone as **OWNER** | ✖ ★3 | ✖ | ✖ | ✖ | ✖ |
| Change or remove **own** membership | ✖ ★3 | ✖ | ✖ | ✖ | ✖ |
| Change, demote or remove the **OWNER** | ✖ | ✖ | ✖ | ✖ | ✖ |
| Ownership *transfer* workflow | not implemented ★4 | — | — | — | — |

Notes
1. A branch manager asking for organization-scope analytics receives figures filtered to the assigned branches (verified: totals differ per manager).
2. Strict hierarchy (ADR-041): `OWNER > ADMIN > BRANCH_MANAGER > INVENTORY_STAFF > CASHIER`. An actor may manage only members strictly below their own role and may assign only roles strictly below their own, so an ADMIN manages only the three roles under ADMIN and cannot manage another ADMIN. Violations return `403 FORBIDDEN`.
3. Each organization has exactly **one** OWNER (the creator). Nobody can invite, promote, accept or reactivate an OWNER, and nobody, the OWNER included, can change, demote or remove themselves (`403 SELF_MODIFICATION_FORBIDDEN`).
4. Ownership transfer is not implemented and is not part of the accepted model. This is a product decision for the owner of the project. BRANCH_MANAGER has no member-management permission and none was added.

Removed (deactivated) members lose access immediately on their next request, even with an open session. An invitation is refused for any email that already has a membership in that organization: an active member returns `409 MEMBERSHIP_ALREADY_EXISTS`; a removed member returns `409 MEMBERSHIP_INACTIVE_EXISTS` and is brought back with **Include inactive → Reactivate** (not with a new invitation).

## 3. Test identities

Passwords are in the credential CSV. Emails are `@hcn920.com` addresses that belong to the project owner; no email is sent to them by provisioning. Org A is **"UAT Demo Siam Mart (สยามมาร์ท)"** with branches `MAIN` (สาขาสยามสแควร์), `BR-001` (สาขาเชียงใหม่), `BR-002` (สาขาขอนแก่น). Org B is **"UAT Isolation Lab (ห้องทดลองแยกข้อมูล)"** with one branch.

| Account | Role | Organization / branches | Typical use |
| --- | --- | --- | --- |
| `uat-owner` | OWNER | A, all | creator; full control |
| `uat-owner2` | ADMIN (was OWNER until the ADR-041 reconciliation) | A, all | peer-ADMIN limits: cannot be managed by another ADMIN; managed by `uat-owner` |
| `uat-admin`, `uat-admin2` | ADMIN | A, all | admin limits; self-modification; peer-ADMIN and owner protection |
| `uat-manager-main` | BRANCH_MANAGER | A: MAIN | branch-scoped management, refunds, discounts |
| `uat-manager-cm` | BRANCH_MANAGER | A: BR-001 | cross-branch isolation |
| `uat-manager-multi` | BRANCH_MANAGER | A: MAIN + BR-002 | branch switcher |
| `uat-inventory-main` | INVENTORY_STAFF | A: MAIN | stock, purchasing, receiving; no POS |
| `uat-inventory-cm` | INVENTORY_STAFF | A: BR-001 | cross-branch isolation |
| `uat-cashier-main` | CASHIER | A: MAIN | POS, no discount, no refund |
| `uat-cashier-cm` | CASHIER | A: BR-001 | cross-branch isolation |
| `uat-cashier-kk` | CASHIER | A: BR-002 | smallest branch stock |
| `uat-removed` | INVENTORY_STAFF | A: MAIN | removal / stale session / reactivation |
| `uat-multi` | CASHIER in A, ADMIN in B | A: MAIN; B | different role per organization |
| `uat-orgb-owner` | OWNER | B | other tenant; must see none of A |
| `uat-orgb-cashier` | CASHIER | B | other tenant cashier |

## 4. Isolated sessions (Chrome / Edge)

Use one **browser profile** per role (Chrome: profile picker → Add; Edge: Settings → Profiles → Add profile), or a separate **Incognito/InPrivate window** per account (only one InPrivate account at a time shares a session). Never sign two accounts into one profile: the session cookie `stockwise_session` is shared by every tab of a profile. Name the profile after the role. Sign out with the account menu before switching.

## 5. Main pages (after login, pick the organization and branch in the shell)

| Page | URL | Who should see it |
| --- | --- | --- |
| Home / branch switcher | `/app` | everyone |
| Catalog | `/app/catalog` | all roles (edit controls by role) |
| Inventory | `/app/inventory` | all roles |
| Suppliers | `/app/suppliers` | OWNER, ADMIN, BRANCH_MANAGER, INVENTORY_STAFF |
| Purchase orders / receiving | `/app/purchase-orders` | same four |
| POS | `/app/pos` | OWNER, ADMIN, BRANCH_MANAGER, CASHIER |
| Sales history | `/app/sales` | OWNER, ADMIN, BRANCH_MANAGER, CASHIER |
| Analytics / forecast / AI | `/app/analytics` | OWNER, ADMIN, BRANCH_MANAGER (analytics, AI); INVENTORY_STAFF (inventory analytics, forecast) |
| Branches | `/app/branches` | OWNER, ADMIN |
| Members | `/app/members` | OWNER, ADMIN |
| Organization settings | `/app/organization-settings` | OWNER, ADMIN |
| Profile | `/app/profile` | everyone |

The UI hides what a role cannot do; the real authority is the API, so a denied direct URL must show a safe forbidden/empty state and never data.

## 6. Checklist per role (allowed → denied)

Record each line as PASS / FAIL / BLOCKED.

- **OWNER** — create a branch without typing a code (expect `BR-003`); invite an admin and lower roles (OWNER is not offered); change a lower member's role and branch scope, demote or remove an ADMIN; reach organization settings, VAT, analytics, AI, refunds; your own row and any OWNER row are read-only.
- **ADMIN** — everything operational; open Members: can offer only BRANCH_MANAGER, INVENTORY_STAFF and CASHIER; owner rows, ADMIN rows (including another admin) and the own row are read-only; an API call attempting any of them returns 403.
- **BRANCH_MANAGER** — sees only assigned branches; can apply a discount, refund a sale, adjust stock, receive a PO; Members / Branches / Settings are unavailable; pasting the other branch's id in the URL shows nothing.
- **INVENTORY_STAFF** — create a PO, mark ORDERED, receive it; adjust stock; no POS, no sales history, no cost, no AI; other branches unavailable.
- **CASHIER** — POS shows **In stock at this branch: N unit** per product; add to cart, pay cash and transfer; no discount control; cannot open catalog edit, suppliers, purchasing; other branches unavailable. Oversell attempt (quantity above stock) is rejected, stock never goes negative.

## 7. Scenarios

1. **Role change:** as `uat-owner` change `uat-cashier-main` to BRANCH_MANAGER (MAIN) and back; the cashier profile must pick up the new access on its next request.
2. **No OWNER grant:** neither `uat-admin` nor `uat-owner` can make anyone OWNER (the role is not offered; a direct API call, an invitation with role OWNER and a reactivation as OWNER all return 403).
3. **Hierarchy and self-modification:** `uat-admin` edits its own row → blocked; `uat-admin` tries to change or deactivate `uat-admin2` or `uat-owner2` (both ADMIN) → blocked; `uat-owner` tries to deactivate or demote itself → blocked (`SELF_MODIFICATION_FORBIDDEN`); `uat-owner` can demote an ADMIN (restore afterwards).
4. **Remove and re-invite:** in profile B sign in as `uat-removed` and keep the tab open; in profile A `uat-owner` deactivates that member; B's next click must lose access; invite the same email → clear "removed earlier, use Reactivate" message and **no email**; Include inactive → Reactivate restores access once, no duplicate row.
5. **Real invitation + email:** invite *your own* mailbox (any role) and accept it through your own register/OTP/login; a removed member cannot be silently restored by an old link.
6. **Branch switching:** `uat-manager-multi` switches MAIN ↔ BR-002; the product/stock lists must change and carry no data from the previous branch.
7. **Cross-organization:** `uat-orgb-owner` must see no Org A data; `uat-multi` sees both organizations with different roles.
8. **Session:** log in, refresh (stays signed in), log out, press Back (protected pages must not reopen), call `/api/v1/me` → 401.

## 8. Issue report format

```
Title:
Role / account:
Organization / branch:
URL:
Action (exact clicks / API call):
Expected result:
Actual result (message, status code, screenshot):
Browser / device / time (UTC):
Severity (P0 security · P1 broken workflow · P2 defect · P3 cosmetic):
```
