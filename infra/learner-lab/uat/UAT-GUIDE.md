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
| Invite / change / remove **non-owner** members | ✔ | ✔ ★2 | ✖ | ✖ | ✖ |
| Invite / change / remove **OWNER** members | ✔ | ✖ | ✖ | ✖ | ✖ |
| Change or remove **own** membership | ✔ ★3 | ✖ | ✖ | ✖ | ✖ |
| Last active OWNER can be removed or demoted | ✖ | ✖ | ✖ | ✖ | ✖ |
| Ownership *transfer* workflow | not implemented ★4 | — | — | — | — |

Notes
1. A branch manager asking for organization-scope analytics receives figures filtered to the assigned branches (verified: totals differ per manager).
2. ADMIN can never grant `OWNER`, and can neither demote nor remove an OWNER.
3. Only an OWNER may change or leave their own membership, and only while another active OWNER remains (`409 LAST_ACTIVE_OWNER` otherwise). Every other role gets `403 SELF_MODIFICATION_FORBIDDEN`.
4. The accepted model (ADR-021) allows **several OWNERs**; one OWNER may grant OWNER to another and may deactivate another OWNER while at least one remains. A separate "primary owner / transfer ownership" workflow is not part of the accepted model and is not implemented. This is a product decision for the owner of the project.

Removed (deactivated) members lose access immediately on their next request, even with an open session. An invitation is refused for any email that already has a membership in that organization: an active member returns `409 MEMBERSHIP_ALREADY_EXISTS`; a removed member returns `409 MEMBERSHIP_INACTIVE_EXISTS` and is brought back with **Include inactive → Reactivate** (not with a new invitation).

## 3. Test identities

Passwords are in the credential CSV. Emails are `@hcn920.com` addresses that belong to the project owner; no email is sent to them by provisioning. Org A is **"UAT Demo Siam Mart (สยามมาร์ท)"** with branches `MAIN` (สาขาสยามสแควร์), `BR-001` (สาขาเชียงใหม่), `BR-002` (สาขาขอนแก่น). Org B is **"UAT Isolation Lab (ห้องทดลองแยกข้อมูล)"** with one branch.

| Account | Role | Organization / branches | Typical use |
| --- | --- | --- | --- |
| `uat-owner` | OWNER | A, all | creator; full control |
| `uat-owner2` | OWNER | A, all | second owner: grant/remove/step-down tests |
| `uat-admin`, `uat-admin2` | ADMIN | A, all | admin limits; self-demotion; owner protection |
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

- **OWNER** — create a branch without typing a code (expect `BR-003`); invite a new owner and an admin; change a member's role and branch scope; reach organization settings, VAT, analytics, AI, refunds; cannot remove or demote the last owner.
- **ADMIN** — everything operational; open Members: cannot offer **OWNER** as a role, cannot edit or deactivate an owner row, cannot change own role or deactivate self (message shown).
- **BRANCH_MANAGER** — sees only assigned branches; can apply a discount, refund a sale, adjust stock, receive a PO; Members / Branches / Settings are unavailable; pasting the other branch's id in the URL shows nothing.
- **INVENTORY_STAFF** — create a PO, mark ORDERED, receive it; adjust stock; no POS, no sales history, no cost, no AI; other branches unavailable.
- **CASHIER** — POS shows **In stock at this branch: N unit** per product; add to cart, pay cash and transfer; no discount control; cannot open catalog edit, suppliers, purchasing; other branches unavailable. Oversell attempt (quantity above stock) is rejected, stock never goes negative.

## 7. Scenarios

1. **Role change:** as `uat-owner` change `uat-cashier-main` to BRANCH_MANAGER (MAIN) and back; the cashier profile must pick up the new access on its next request.
2. **Grant OWNER:** `uat-admin` tries to make someone OWNER (not offered; direct API call returns 403); `uat-owner` can.
3. **Self-demotion:** `uat-admin` edits own row → blocked; `uat-owner2` steps down to ADMIN while `uat-owner` remains → allowed; then `uat-owner` cannot step down (`LAST_ACTIVE_OWNER`).
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
