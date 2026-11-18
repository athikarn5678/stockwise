-- M6-S2 / ADR-049: an explicit EXPIRED subscription status (renewal required).
-- Additive only. PostgreSQL forbids using a new enum value in the transaction
-- that adds it, so the CHECK that mentions it lives in the next migration.
-- Forward recovery: an enum value cannot be dropped; leave it unused.
ALTER TYPE "subscription_status" ADD VALUE 'EXPIRED';
