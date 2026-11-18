-- M6-S2 / ADR-050: billing interval and Stripe-less EXPIRED rows.
-- Existing rows are all monthly (ADR-047), hence DEFAULT 'MONTH'. The three
-- Stripe reference columns become nullable only so an operator-created EXPIRED
-- row (no Stripe objects) can exist; the CHECK keeps every other status bound
-- to a complete set of Stripe ids. Unique indexes ignore NULLs, so they still
-- guarantee at most one row per Stripe object. Table is tiny; no backfill.
-- Forward recovery: set the columns back to NOT NULL once no EXPIRED row
-- without Stripe ids exists; the enum and column are otherwise inert.
-- CreateEnum
CREATE TYPE "subscription_interval" AS ENUM ('MONTH', 'YEAR');

ALTER TABLE "organization_subscriptions"
    ADD COLUMN "interval" "subscription_interval" NOT NULL DEFAULT 'MONTH',
    ALTER COLUMN "stripe_customer_id" DROP NOT NULL,
    ALTER COLUMN "stripe_subscription_id" DROP NOT NULL,
    ALTER COLUMN "stripe_checkout_session_id" DROP NOT NULL;

ALTER TABLE "organization_subscriptions"
    ADD CONSTRAINT "organization_subscriptions_stripe_ids_check"
        CHECK (
            "status" = 'EXPIRED'
            OR (
                "stripe_customer_id" IS NOT NULL
                AND "stripe_subscription_id" IS NOT NULL
                AND "stripe_checkout_session_id" IS NOT NULL
            )
        );
