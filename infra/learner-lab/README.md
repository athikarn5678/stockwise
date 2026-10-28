# StockWise — AWS Academy Learner Lab demo deployment (ADR-040)

Source for the time-limited educational demo on AWS Academy Learner Lab:

- Edge: Browser → (optional CloudFront) → internet-facing ALB with ACM HTTPS.
- Compute: ECS on EC2, with an Auto Scaling Group across two Availability Zones.
- Database: private RDS PostgreSQL 16 Multi-AZ.
- Supporting services: Secrets Manager, ECR, S3, CloudWatch.

The topology, its constraints and the owner decisions are in
[`docs/architecture/DECISIONS.md`](../../docs/architecture/DECISIONS.md) (`ADR-040`). The diagram and a
service-by-service explanation are in [ARCHITECTURE.md](ARCHITECTURE.md).

**Status:** source implemented and verified locally only (mocked Terraform
tests, image builds, a local rehearsal of the ECS task definitions). Nothing is
published or provisioned. No Learner Lab create permission has been
exercised. **Planning deadline: 2026-10-31 23:59 Asia/Bangkok =
`2026-10-31T16:59:00Z`.** Teardown must finish before it.

| Path | Purpose |
| --- | --- |
| `terraform/` | VPC (3 tiers × 2 AZs, two NAT gateways), ALB + ACM, optional CloudFront, ECS cluster + ASG + capacity provider, task definitions, service, RDS Multi-AZ, Secrets Manager, ECR, S3, CloudWatch, budget guard. Zero `aws_iam_*` resources. |
| `terraform/templates/` | ECS container definitions and per-role ops secrets (also rendered by the local rehearsal) |
| `terraform/tests/` | `terraform test` with a mocked AWS provider (no credentials) |
| `docker/` | `web`, `api` and `ops` images; the API entrypoint that composes `DATABASE_URL` |
| `db/` | Database role bootstrap and runtime grants (unchanged from ADR-039) |
| `ops/` | `ops-task.sh`, the ops image entrypoint for one-off ECS tasks; the loopback seeding wrapper |
| `operator/` | Operator-machine scripts: secrets, image copy to ECR, ops tasks, deploy, smoke, rollback, pause/resume, budget check, teardown |
| `smoke/` | Local rehearsal of the task definitions (Docker only) |

## Invariants

- **Authentication:** Better Auth Native only. The task definition fixes `STOCKWISE_AUTHENTICATION_AUTHORITY=native` and production mode, and the API refuses a database not sealed NATIVE. There is no Legacy fallback.
- **Exactly one application task.** The login/password-proof limiter is process-local, so `app_desired_count` is 0 or 1, and releases stop the old task before starting the new one.
  - The ASG scales EC2 capacity, not application replicas.
  - The configuration is not fully highly available: a failed task is replaced on the other AZ's instance after a short outage.
  - Running more replicas requires the PostgreSQL-backed limiter described in ADR-040.
- **Loopback API.** The API listens on `127.0.0.1:3001` inside the task's network namespace. Only Next.js (`:3000`) is an ALB target.
- **Migrations and cutover.** Forward-only migrations run, then grants are re-applied. Optional seeding happens only while LEGACY. The one-way Native cutover runs only with the service at 0 tasks and no `stockwise_app` session. The application starts only after that.
- **Secrets.** No secret in Git, images, Terraform state, logs or evidence. The application task has no IAM task role; only the export task has `LabRole`.
- **No ALB request logging (F1).** ALB access logs would record the `?token=` query strings of the emailed verification, reset and invitation links. They stay disabled, and no variable can re-enable them. Request visibility comes from CloudWatch metrics, alarms and the containers' logs; the API logs paths without query strings.
- **Container log boundary (R2-F1, R3-F1).** The `web` and `api` servers run under `docker/redacting-log-pipe.mjs`. Query redaction includes punctuation-bearing values and supported percent/Unicode/hex-escaped representations; authorization schemes are case-insensitive. CR and backslash-newline continuations cannot split a credential from its context. Bounded records discard oversized tails through their continuations. Paths, error codes and other diagnostics remain. This is a contextual redactor, not a detector for arbitrary unlabelled plaintext secrets.
- **Every AWS call is identity-checked (F3, R2-F3).** Every operator entry point that calls AWS, including `run-ops-task.sh`, `verify-export.sh` and `budget-check.sh` called directly, refuses before any service call. It requires a `voclabs`/`LabRole` session, in the account and region recorded in Terraform state.
- **The seeder verifies RDS TLS (F5, R2-F5).** The optional seed path verifies the RDS CA chain, validity and hostname before forwarding any byte; no-verify settings are refused. Negotiation always settles within its deadline (early EOF, close, malformed reply or timeout) and leaves no connection open.
- **Secrets readiness is verified (R2-NEW-F1, R3-F2).** `put-secrets.sh` treats any AWS error, empty or malformed answer as a failure. Its Node helper parses the complete read-back JSON, rejects duplicate decoded keys, requires the exact flat credential fields and string types, and accepts harmless formatting whitespace. CLI detection compares canonical real paths so symlinks and junctions cannot skip validation. The shell requires both exit 0 and the fixed `STOCKWISE_SECRET_JSON:VALID` marker for each required secret before READY. Values enter the helper through stdin only; parser failures print no input.

## Approvals (each separate, from the owner)

| Gate | Action |
| --- | --- |
| G2 | Git publication of this source |
| G3 | Image publication (GHCR workflow and the ECR copy) |
| G4 | `terraform apply` (chargeable provisioning) |
| G5 | DNS records (ACM validation and the demo hostname) |
| G6 | Public deploy and the one-way Native cutover |
| G7 | Real email through Resend |

## Prerequisites (operator machine)

- Tools: Node.js 24 (the repository runtime, also used by the secret validator), AWS CLI v2, Terraform ≥ 1.11, Docker with buildx, bash (Linux, macOS or Git Bash), curl and OpenSSL.
- Learner Lab session credentials from **AWS Details**, exported in the operator's own shell only. Never write them to a file. The scripts check that the identity is a Learner Lab role, and that its account matches the Terraform state.
- `terraform/demo.tfvars`, copied from `example.tfvars` (ignored by Git), holding the hostname and `email_from`.
- **CloudFront is gated off (F4).** Its origin-protection header secret would be stored in plaintext in the operator's Terraform state (`sensitive` only hides it from output). Terraform refuses `enable_cloudfront = true` unless `cloudfront_secret_in_state_approved = true`. Set that only after:
  - the owner explicitly approves that limitation (or a secret-free design such as CloudFront VPC origins with an internal ALB, which needs its own review);
  - CloudFront access is verified (see "AWS capability checks").

  Then create `operator/.state/cloudfront-origin-secret` (mode 0600) holding 43 base64url characters, generated with `openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '='`. The default configuration holds no origin secret anywhere.

## Deployment runbook

Each step's completion check is in **bold**. Each gate (G3–G7) is a separate owner approval. Approving this source does not authorize any of them, DNS changes (G5) included.

1. **Images (G3).** Run the `Learner Lab images` workflow for a commit with green Quality gates. Its summary lists three GHCR digests. **Three `ghcr.io/...@sha256:` references.**
2. **ACM certificate and ECR repositories (G4).**
   ```bash
   cd infra/learner-lab/terraform && terraform init
   terraform apply -var-file=demo.tfvars -target=data.aws_caller_identity.current -target=aws_acm_certificate.app -target=aws_ecr_repository.image
   terraform output acm_validation_records
   terraform output account_id
   ```
   **The certificate is pending validation, the three repositories exist, and `account_id` prints (the operator scripts fail closed without it).**
3. **Certificate validation DNS (G5).** Create the `acm_validation_records` CNAMEs at the DNS provider. **ACM shows the certificate as `ISSUED`.**
4. **Copy images into ECR (G3).**
   ```bash
   operator/mirror-images.sh --web <web@sha256> --api <api@sha256> --ops <ops@sha256> --revision <40-char sha>
   ```
   **`.state/release-<sha>.env` exists, and every ECR digest equals its GHCR source digest.**
5. **Full apply with the application at zero tasks (G4).** Use the three digests from the release file:
   ```bash
   terraform apply -var-file=demo.tfvars -var web_image=<WEB_IMAGE> -var api_image=<API_IMAGE> -var ops_image=<OPS_IMAGE> -var app_desired_count=0
   ```
   **Apply complete: two `RUNNING` container instances in the cluster, and RDS `available` with Multi-AZ.**
6. **Public hostname DNS (G5).** Create the `public_dns_record` output (a DNS-only CNAME to the ALB) and wait until it resolves.
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' "$(terraform output -raw public_origin)/api/health"
   ```
   **`503`: valid HTTPS for the hostname, no task yet. `000` means DNS or TLS is not ready.** `deploy.sh` repeats this check and refuses to migrate or cut over until it passes.
7. **Secrets.**
   ```bash
   operator/put-secrets.sh --resend-key-file <file>
   ```
   With `db_master_password_mode = write_only`, add `--master-password-from-env`. **`STOCKWISE_SECRETS:READY`.**
8. **Database roles.**
   ```bash
   operator/run-ops-task.sh bootstrap-roles
   ```
   **`STOCKWISE_BOOTSTRAP:COMPLETE`.**
9. **Deploy, optional seed, and cutover (G6).**
   ```bash
   operator/deploy.sh --release <release.env> --var-file terraform/demo.tfvars [--seed-demo] --native-cutover
   ```
   This checks public HTTPS, then runs `prepare` (migrate, grants, fence state), the optional seed, `cutover`, and one application task. It then waits for stability and runs `smoke.sh` against the public hostname. **`STOCKWISE_SMOKE:PASS`.**
10. **Baseline export.**
    ```bash
    operator/run-ops-task.sh export
    ```
    **A `STOCKWISE_EXPORT_RESULT:v1 ... sha256=...` line.**
11. **Real email (G7).** Separate approval; see "Email" below.

Later releases: steps 1, 4 and 9, without the cutover flag. `deploy.sh` applies new ops task definitions first, migrates, and only then rolls the application.

### Interrupted cutover (fence `QUIESCED`)

`deploy.sh` and `ops-task.sh` refuse to continue. Inspect the ops log and the
D5-P3 runbook in `docs/development/BETTER_AUTH_MIGRATION.md`, then resume
deliberately: run the ops image's `node dist/native-cutover/native-cutover-main.js --resume`
in a one-off task. The application stays at 0 tasks throughout.

## Operations

| Need | Command | Notes |
| --- | --- | --- |
| Health | `operator/smoke.sh` | No credentials; HTTPS, HSTS, nosniff, redirect, cross-origin refusal |
| Rollback | `operator/rollback.sh --var-file …` | Previous web/api digests; NATIVE only; no down-migrations |
| Logs | CloudWatch `/stockwise/<prefix>/{web,api,ops}` | 7-day retention; RDS logs in `/aws/rds/instance/<id>/postgresql` |
| Dashboard / alarms | `terraform output dashboard_url` | 11 alarms to SNS (`alarm_email` optional). The no-healthy-target alarm judges availability against the ECS service's desired count: a missing target metric is an outage, and an intentional pause (desired 0) is not. `capacity.sh resume`, `deploy.sh` and `rollback.sh` re-arm an alarm left in ALARM, so a failed resume notifies (R2-F8). |
| Export | `operator/run-ops-task.sh export` | `pg_dump` custom format to the private exports bucket; prints one `STOCKWISE_EXPORT_RESULT:v1` line |
| Pause / resume | `operator/capacity.sh pause|resume --var-file …` | Stops EC2 and RDS hours only; the ALB, both NAT gateways and IPv4 keep billing |
| Budget | `operator/budget-check.sh --remaining-usd <panel amount>` | Running resources, estimated rate, projection to the deadline |

**Learner Lab sessions:**
- EC2 instances stop when a session ends and restart at the next one.
- How the ASG and ECS react to that is unverified. Start the session well before a demonstration, then run `smoke.sh`.
- RDS, the ALB and the NAT gateways keep running and billing between sessions.

## Budget guard and teardown

**Cost.** The estimate is ≈ $0.23/h, ≈ $5.5/day, with everything running. These are us-east-1 list prices, excluding data transfer:
- 2 NAT gateways ≈ $0.09
- ALB ≈ $0.04
- 2× t3.small with volumes ≈ $0.05
- RDS Multi-AZ db.t4g.micro + storage ≈ $0.04
- IPv4, Secrets Manager and alarms

Exceeding the Learner Lab budget disables the account and deletes everything.

**Guards:**
- `budget-check.sh`, with the panel amount.
- `deploy.sh`, `rollback.sh` and `capacity.sh resume` refuse to run after the deadline.
- An ASG scheduled action scales the container instances to 0 at `demo_end_time`. This is only a backstop: the ALB, NAT gateways and RDS keep billing.
- Optional AWS Budgets alert (`enable_aws_budget`; access unverified).

**Teardown** (irreversible; before the deadline):
```bash
operator/teardown.sh --var-file terraform/demo.tfvars --confirm <name_prefix>
```
Real teardown needs the owner's separate authorization. It **fails closed (F2)**: nothing is destroyed unless all of the following hold.
1. A final export task bound to a fresh export id exits successfully and prints exactly one matching result marker.
2. `verify-export.sh` downloads exactly that S3 object to `operator/.state/exports/` (or `--export-dir`).
3. The downloaded file is non-empty and matches the marker's size and SHA-256, and the object's checksum metadata.
4. Pinned `pg_restore` 16 lists it as an archive of the expected database, containing `users`, `native_auth_transition` and `_prisma_migrations`.
5. Every other stored export also downloads.

There is no flag that skips the export. Only then does it lift deletion protection, run `terraform destroy` and check for residual resources. **It must end with `STOCKWISE_TEARDOWN_VERIFIED`.** Remove the DNS records afterwards (G5).

## Email (Resend, D-09)

Production always uses Resend. Before G7:
1. Verify a sending domain (SPF/DKIM and DMARC `p=none`).
2. `email_from` must use that domain.
3. Create a sending-only API key for it, then store it with `put-secrets.sh --resend-key-file`.

The first test goes to `delivered@resend.dev`, then to one owner-controlled mailbox only.

## AWS capability checks (read-only; correct lab account only)

Before G4, with lab credentials (`aws sts get-caller-identity` must show `voclabs`):

- **CloudFront:** `aws cloudfront list-distributions`, `aws cloudfront list-cache-policies --type managed`.
- **IAM simulation:** `aws iam simulate-principal-policy --policy-source-arn <role arn> --action-names cloudfront:CreateDistribution ecs:CreateCapacityProvider rds:CreateDBInstance secretsmanager:CreateSecret ecr:PutImage elasticloadbalancing:CreateLoadBalancer ec2:CreateNatGateway`.
- **RDS:** `aws rds describe-orderable-db-instance-options --engine postgres --db-instance-class db.t4g.micro --query 'OrderableDBInstanceOptions[?MultiAZCapable]|[0].EngineVersion'`.

A successful read proves read access only. Create rights are proven only by the authorized apply.

## Local verification (no AWS)

```bash
# Terraform (no credentials; mocked provider)
cd infra/learner-lab/terraform && terraform init -backend=false && terraform validate && terraform test
# Images
docker build -f infra/learner-lab/docker/Dockerfile --target <web|api|ops> -t stockwise-local/<target>:ecs-candidate .
# Task-definition rehearsal (TLS PostgreSQL and S3 stand-ins; unique lls-ecs-* resources, label cleanup)
infra/learner-lab/smoke/local-ecs-rehearsal.sh
# Operator regression tests (stub AWS/Terraform; real pg_restore in a labelled container)
infra/learner-lab/operator/tests/operator-tests.sh
# Seeder TLS verification tests (local openssl test certificates)
node --test infra/learner-lab/ops/verified-postgres-forwarder.test.mjs
# Container log redaction tests (the signal case runs on Linux)
node --test infra/learner-lab/docker/redacting-log-pipe.test.mjs
# Complete JSON syntax, duplicate decoded keys, value types and quiet stdin CLI
node --test infra/learner-lab/operator/validate-secret-json.test.mjs
# Outage-alarm scenario model (pause/resume; reads terraform/monitoring.tf)
node --test infra/learner-lab/operator/tests/outage-alarm-model.test.mjs
```

## Cloudflare proxy in front of the ALB (owner-approved 2026-10-29)

CloudFront is denied to the Learner Lab role, so `stockwise.hcn920.com` is a **proxied** Cloudflare record (orange cloud) pointing at the same ALB. Cloudflare config (zone `hcn920.com`, this hostname only, set through the API; not in Terraform):

- TLS: Configuration Rule `ssl = strict` for the hostname (Full strict against the ACM certificate); zone-wide mode untouched (`full`).
- WAF: Cloudflare Free Managed Ruleset executed for the hostname (default actions); no blanket challenges.
- Cache Rules: only `/_next/static/*` is cache-eligible (respect origin); everything else, including `/api/*`, is bypassed.

ALB security group `alb` (Terraform: `allowed_ingress_ipv4_cidrs`, `allowed_http_ingress_ipv4_cidrs`): TCP 443 and 80 (redirect only) from the official Cloudflare IPv4 ranges. The ALB is IPv4-only. This is a **network-source restriction only**: it does not prove a request came through our Cloudflare zone, because any Cloudflare customer can send traffic from these ranges.

Refreshing the ranges (Cloudflare publishes them at <https://www.cloudflare.com/ips-v4>; changes are rare, check before each release): run `operator/cloudflare-ranges.sh`, replace both lists in `demo.tfvars`, then `terraform apply -refresh=false -var-file=demo.tfvars -target=aws_vpc_security_group_ingress_rule.alb_https -target=aws_vpc_security_group_ingress_rule.alb_http_redirect`. Keep the old ranges in place until the new apply succeeds.

Rollback, in this order: (1) reopen the ALB: set both lists to `["0.0.0.0/0"]` in `demo.tfvars` and apply the same targeted command; (2) confirm `https://<alb-dns>/api/health` answers directly; (3) set the Cloudflare record `proxied` to `false` (original: CNAME to the ALB DNS name, DNS-only, TTL 300); (4) optionally empty the `http_request_cache_settings`, `http_config_settings` and `http_request_firewall_managed` entrypoint rulesets. Original values are in `D:\Projects\stockwise-deploy-r3\rollback-cloudflare-proxy\`.
