# StockWise Learner Lab — operator runbook (M9-T3)

Short, day-to-day procedure for the demo at `https://stockwise.hcn920.com`. The full reference (invariants, approvals, Terraform, teardown internals) is [README.md](README.md). Run every command from `infra/learner-lab/` with `~/.local/bin` on `PATH`. No command here prints a secret, and none should be changed to do so.

## 1. Start a lab session

1. In AWS Academy, start the Learner Lab and wait for the green light.
2. Refresh the temporary credentials with `learnerlab-creds`. For the 24h sprint it writes `~/.aws/credentials` (mode 600); they expire after about 4 hours (planner decision recorded in `docs/PLAN.md`). The operator scripts still check that the identity is `voclabs` and that the account matches the Terraform state.
3. Check access: `aws sts get-caller-identity`.
4. **Wait 5-10 minutes.** EC2 instances stopped when the previous session ended; the Auto Scaling Group has to start a new one before ECS can place the application task. Until then the site answers 503 and ECS logs `EMPTY CAPACITY PROVIDER`. Nothing is broken.
5. Confirm: `operator/smoke.sh` (HTTPS, HSTS, redirect), then `curl -s -o /dev/null -w '%{http_code}\n' https://stockwise.hcn920.com/api/health` should print `200`. Also check `aws ecs describe-services --cluster stockwise-demo --services stockwise-demo-app` shows running 1.

If credentials are older than about 3 hours, restart the lab and refresh them before any deploy.

## 2. Reveal the store password

The five demo accounts (`owner@`, `admin@`, `manager@`, `inventory@`, `cashier@hcn920.com`) share one password stored in Secrets Manager. Show it only in your own terminal:

```bash
aws secretsmanager get-secret-value --region us-east-1 --secret-id stockwise-demo/database \
  --query SecretString --output text \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).demo_user_password))'
```

Log in at `/login`. The organization is "Siam Mart". Do not paste the password into chat, tickets or files.

## 3. Reset Siam Mart to EXPIRED (renewal rehearsal)

```bash
operator/run-ops-task.sh expire-subscription
```

Idempotent; sets only the Siam Mart organization to `EXPIRED` (ADR-050) and prints `STOCKWISE_SUBSCRIPTION:EXPIRED organization=… previous=<status|CREATED>`. Then the store is read-only: the red banner shows, writes answer `402 SUBSCRIPTION_REQUIRED`, and the OWNER renews on `/pricing` with the Stripe test card `4242 4242 4242 4242`. Repeat the command to rehearse again. Run it once more at the end so the store is handed over EXPIRED.

## 4. Redeploy a new version

1. Merge to `main` and wait for green CI on the commit you will ship.
2. Dispatch the `Learner Lab images` workflow on `main` (`gh workflow run learner-lab-images.yml --ref main`) and wait for it. Read the three digests: `docker buildx imagetools inspect ghcr.io/athikarn5678/stockwise-<web|api|ops>:sha-<commit>`.
3. Mirror by digest into ECR: `operator/mirror-images.sh --web <ghcr digest ref> --api <…> --ops <…> --revision <commit>`. It writes `operator/.state/release-<commit>.env`.
4. Take a manual RDS snapshot first (`aws rds create-db-snapshot --db-instance-identifier stockwise-demo-postgres --db-snapshot-identifier <name>`) and wait until it is `available`; at least 90 minutes of lab time should remain.
5. Plan check. Run `terraform plan` with the same variables the deploy uses (`-var-file=terraform/demo.tfvars` and the three image variables from the release file). Expect only the four ECS task definitions to show as replaced (ECS normalizes empty arrays, so this is normal) and no change to RDS, the ALB or the ECS cluster. **Any other destroy or replacement: stop and ask the owner.**
6. Deploy: `yes yes | operator/deploy.sh --release operator/.state/release-<commit>.env --var-file terraform/demo.tfvars`. It needs stdin for its confirmations, and it runs the additive, forward-only migrations. Read the log; do not trust the exit code alone. Add `--seed-demo` only on a new, empty `*_demo` database: seeding existing data is refused, and `bootstrap-roles` must run **after** the apply that registers the new ops task definition.
7. Smoke: `operator/smoke.sh` is run by the deploy; then the checks in section 3 and a quick browser pass.

## 5. Pause, rollback, teardown

| Need | Command |
| --- | --- |
| Previous web/api digests | `operator/rollback.sh --var-file terraform/demo.tfvars` (no down-migrations; restore the snapshot for data) |
| Stop EC2 and RDS hours | `operator/capacity.sh pause --var-file terraform/demo.tfvars` (`resume` to restart) |
| Final export | `operator/run-ops-task.sh export` |
| Teardown | `operator/teardown.sh --var-file terraform/demo.tfvars --confirm <name_prefix>`: irreversible; owner approval first; refuses unless an export verifies |

Never delete AWS resources, snapshots or data on your own initiative; deletion and `terraform destroy` need the owner.

## 6. Cost notes

- About $0.23/hour, $5.5/day with everything running (2 NAT gateways ≈ $0.09, ALB ≈ $0.04, 2× t3.small ≈ $0.05, RDS Multi-AZ ≈ $0.04, plus IPv4, Secrets Manager and alarms). The ALB, NAT gateways and RDS keep billing between sessions; `capacity.sh pause` only stops EC2 and RDS hours.
- Check the budget with `operator/budget-check.sh --remaining-usd <panel amount>`.
- `demo_end_time` (currently `2026-11-21T16:59:00Z`) is enforced: `deploy.sh`, `rollback.sh` and `capacity.sh resume` refuse after it, and an ASG scheduled action scales the instances to 0 as a backstop. Exceeding the lab budget disables the account and deletes everything.
- Cloudflare is configured by the owner by hand. A 525/526 means the SSL mode or the ACM certificate for `stockwise.hcn920.com`; report it before changing any Cloudflare setting.
