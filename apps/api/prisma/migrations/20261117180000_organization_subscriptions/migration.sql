-- M6-S1 / ADR-047: Stripe test-mode subscription per Organization.
-- Additive only: two enums and one new table, no existing table is rewritten or
-- locked. The Stripe IDs are references (not credentials); the CHECKs pin the
-- Stripe object prefixes so a malformed value cannot be stored. Forward recovery:
-- the table can be dropped when nothing references it (nothing does yet).
-- CreateEnum
CREATE TYPE "subscription_plan" AS ENUM ('STARTER', 'GROWTH', 'BUSINESS');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateTable
CREATE TABLE "organization_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan" "subscription_plan" NOT NULL,
    "status" "subscription_status" NOT NULL,
    "stripe_customer_id" VARCHAR(255) NOT NULL,
    "stripe_subscription_id" VARCHAR(255) NOT NULL,
    "stripe_checkout_session_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_organization_id_key" ON "organization_subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_stripe_subscription_id_key" ON "organization_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_stripe_checkout_session_id_key" ON "organization_subscriptions"("stripe_checkout_session_id");

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Stripe object prefixes (test mode ids start with cus_/sub_/cs_test_).
ALTER TABLE "organization_subscriptions"
    ADD CONSTRAINT "organization_subscriptions_stripe_customer_id_check"
        CHECK ("stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$'),
    ADD CONSTRAINT "organization_subscriptions_stripe_subscription_id_check"
        CHECK ("stripe_subscription_id" ~ '^sub_[A-Za-z0-9]+$'),
    ADD CONSTRAINT "organization_subscriptions_stripe_checkout_session_id_check"
        CHECK ("stripe_checkout_session_id" ~ '^cs_test_[A-Za-z0-9]+$');
