# UAT provisioning runbook and operator pitfalls (Learner Lab)

Owner-authorized on 2026-10-28 for account `136037785698`, `us-east-1`, ADR-040. Everything below is non-destructive: it never resets, truncates or edits existing users, organizations or data, and it never sends email.

## Order of operations

Run from the repository root in Git Bash after sourcing the deployment environment (see "Pitfalls"). `CSV` is the local credential file outside Git, for example `D:/Projects/stockwise-deploy-r3/.secrets/stockwise-uat-accounts.csv`; `SPEC` is a scratch directory.

```bash
node infra/learner-lab/uat/uat-generate.mjs --csv "$CSV" --spec-dir "$SPEC"        # passwords + hash-only specs
operator/run-ops-task.sh uat-provision --uat-phase accounts --uat-spec-file "$SPEC/uat-accounts-spec.json"
node infra/learner-lab/uat/uat-seed.mjs --csv "$CSV" --stage structure               # onboarding + branches through the API
operator/run-ops-task.sh uat-provision --uat-phase memberships --uat-spec-file "$SPEC/uat-memberships-spec.json"
node infra/learner-lab/uat/uat-seed.mjs --csv "$CSV" --stage data                    # catalog, POs, receipts, sales, adjustments, refund
node infra/learner-lab/uat/uat-verify.mjs --csv "$CSV" --report "$SPEC/report.json" --scenarios
```

Every step is rerunnable: existing users, memberships, products and purchase orders are detected, writes carry deterministic `Idempotency-Key`s, and `uat-verify.mjs` restores any state its `--scenarios` mode changes.

## What the provisioning guarantees

- The ops task (`uat-provision`) accepts only `uat-*@hcn920.com` addresses, organization names that start with `UAT `, and **Argon2id hashes**: plaintext passwords exist only in the local CSV and in memory on the operator machine.
- Users are created exactly like a completed Native registration (verified email, completed registration marker, credential account). Memberships go through the real invitation repository (`issueInvitation` → `acceptInvitation` with an in-process token), so authorization, branch-scope checks, provenance and access events are those of production. No session is fabricated; every account must pass a real login before it is marked READY.
- All business data is created through the public HTTP API with a real login for each role, so the ledger, non-negative stock, idempotency and RBAC rules apply.

## Pitfalls (record of what failed on this machine)

- **Terraform refresh:** the Learner Lab denies `s3:GetBucketObjectLockConfiguration`, which `aws_s3_bucket` reads on refresh. Use `TF_CLI_ARGS_plan/apply/destroy="-refresh=false"`; no source change.
- **Git Bash path conversion:** arguments such as `/stockwise/...` are rewritten into Windows paths. Export `MSYS2_ARG_CONV_EXCL=/stockwise` for operator scripts and use `MSYS_NO_PATHCONV=1` for ad-hoc AWS CLI calls.
- **Encoding:** `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 AWS_CLI_FILE_ENCODING=UTF-8` so the AWS CLI can print Prisma output.
- **Terraform lockfile:** the Windows provider hash differs; use the isolated deployment copy, never edit the repository lockfile.
- **Learner Lab credentials** rotate per session and are kept in a restricted file outside the repository, deleted after use.
- **ECS override size:** the UAT spec travels as a base64 environment override and must stay under 7000 characters (`run-ops-task.sh` enforces it).
