-- M3-F1 / ADR-045 condition (b): drop the unused users.password_hash column.
-- Nothing reads or writes it any more (the credential lives in
-- better_auth_accounts.password). The column is dropped in the same migration
-- that replaces the guard, and the guard is replaced FIRST: PL/pgSQL resolves
-- NEW."password_hash" when the statement runs, so a guard that still named the
-- dropped column would make every later users UPDATE fail. The guard below is
-- the 20261117000000 version minus the users.password_hash immutability rule;
-- its references to pending_registrations.password_hash are a different column
-- and stay. The column's CHECK constraint (users_password_hash_not_blank_check)
-- is dropped with it. Not reversible: take a pg_dump before applying it to any
-- database you cannot recreate.
CREATE OR REPLACE FUNCTION "guard_native_auth_dml"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    is_insert BOOLEAN := (TG_OP = 'INSERT');
    is_delete BOOLEAN := (TG_OP = 'DELETE');
BEGIN
    IF TG_TABLE_NAME = 'users' THEN
        IF is_delete THEN RAISE EXCEPTION 'user deletion is not permitted'; END IF;
        IF NOT is_insert THEN
            IF NEW."credential_version" < OLD."credential_version" OR NEW."credential_version" <= 0 THEN
                RAISE EXCEPTION 'credential version cannot decrease or become non-positive';
            END IF;
            IF (OLD."native_registration_completed_at" IS NOT NULL
                    AND NEW."native_registration_completed_at" IS DISTINCT FROM OLD."native_registration_completed_at")
               OR (OLD."email_verified_at" IS NOT NULL
                    AND NEW."email_verified_at" IS DISTINCT FROM OLD."email_verified_at") THEN
                RAISE EXCEPTION 'user registration and email verification provenance is write-once';
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'password_reset_tokens' THEN
        IF is_delete THEN RAISE EXCEPTION 'reset history cannot be deleted'; END IF;
        IF is_insert THEN
            IF NEW."requires_native_delivery_confirmation" IS NOT TRUE
               OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = NEW."user_id" AND u."native_registration_completed_at" IS NOT NULL) THEN
                RAISE EXCEPTION 'Native reset tokens require Native delivery and enrollment';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."requires_native_delivery_confirmation" IS DISTINCT FROM OLD."requires_native_delivery_confirmation"
           OR (to_jsonb(NEW) - ARRAY['delivery_confirmed_at', 'consumed_at', 'revoked_at', 'replaced_at', 'updated_at'])
              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['delivery_confirmed_at', 'consumed_at', 'revoked_at', 'replaced_at', 'updated_at'])
           OR (OLD."delivery_confirmed_at" IS NOT NULL AND NEW."delivery_confirmed_at" IS DISTINCT FROM OLD."delivery_confirmed_at")
           OR (num_nonnulls(OLD."consumed_at", OLD."revoked_at", OLD."replaced_at") > 0
               AND NEW."delivery_confirmed_at" IS DISTINCT FROM OLD."delivery_confirmed_at")
           OR (OLD."consumed_at" IS NOT NULL AND NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at")
           OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
           OR (OLD."replaced_at" IS NOT NULL AND NEW."replaced_at" IS DISTINCT FROM OLD."replaced_at")
           OR (NOT OLD."requires_native_delivery_confirmation" AND (
               OLD."revoked_at" IS NOT NULL OR OLD."replaced_at" IS NOT NULL
               OR NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at"
               OR NEW."delivery_confirmed_at" IS DISTINCT FROM OLD."delivery_confirmed_at"
               OR (NEW."revoked_at" IS NULL AND NEW."replaced_at" IS NULL)
           )) THEN
            RAISE EXCEPTION 'reset authority cannot be modified in Native mode';
        END IF;
    ELSIF TG_TABLE_NAME = 'better_auth_sessions' THEN
        IF is_delete THEN RETURN OLD; END IF;
        IF is_insert THEN
            IF NEW."stockwise_purpose" IS NOT NULL OR NEW."stockwise_credential_version" IS NOT NULL
               OR NOT EXISTS (
                   SELECT 1 FROM "users" u
                   WHERE u."id" = NEW."user_id"
                     AND u."status" = 'ACTIVE' AND u."disabled_at" IS NULL
                     AND u."better_auth_email_verified" AND u."email_verified_at" IS NOT NULL
                     AND u."native_registration_completed_at" IS NOT NULL
               ) THEN
                RAISE EXCEPTION 'Native provisional session requires an active verified Native user';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."token" IS DISTINCT FROM OLD."token"
           OR NOT EXISTS (
               SELECT 1 FROM "users" u
               WHERE u."id" = NEW."user_id"
                 AND u."status" = 'ACTIVE' AND u."disabled_at" IS NULL
                 AND u."better_auth_email_verified" AND u."email_verified_at" IS NOT NULL
                 AND u."native_registration_completed_at" IS NOT NULL
                 AND u."credential_version" = NEW."stockwise_credential_version"
           )
           OR NOT (
               (OLD."stockwise_purpose" IS NULL AND OLD."stockwise_credential_version" IS NULL
                AND NEW."stockwise_purpose" = 'APPLICATION')
               OR (OLD."stockwise_purpose" = 'APPLICATION'
                   AND OLD."stockwise_credential_version" = NEW."stockwise_credential_version"
                   AND NEW."stockwise_purpose" = 'APPLICATION')
           ) THEN
            RAISE EXCEPTION 'Native session finalization or update is invalid';
        END IF;
    ELSIF TG_TABLE_NAME = 'better_auth_accounts' THEN
        IF is_delete THEN RAISE EXCEPTION 'Native accounts cannot be deleted'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = CASE WHEN is_insert THEN NEW."user_id" ELSE OLD."user_id" END AND u."native_registration_completed_at" IS NOT NULL) THEN
            RAISE EXCEPTION 'Native account mutation requires Native registration provenance';
        END IF;
        IF is_insert THEN RETURN NEW; END IF;
        IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."account_id" IS DISTINCT FROM OLD."account_id" OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id" THEN
            RAISE EXCEPTION 'Native account identity is immutable';
        END IF;
    ELSIF TG_TABLE_NAME = 'better_auth_verifications' THEN
        IF is_delete THEN RETURN OLD; END IF;
    ELSIF TG_TABLE_NAME = 'pending_registrations' THEN
        IF is_delete THEN RETURN OLD; END IF;
        IF is_insert THEN
            RETURN NEW;
        END IF;
        IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN
            IF NOT (
                -- (i) fresh generation (register path)
                (NEW."email" = OLD."email"
                 AND NEW."credential_version" > OLD."credential_version"
                 AND NEW."issued_at" > OLD."issued_at"
                 AND NEW."challenge_id" IS DISTINCT FROM OLD."challenge_id"
                 AND NEW."password_hash" IS NOT NULL AND NEW."consumed_at" IS NULL
                 AND NEW."user_id" IS NULL AND OLD."consumed_at" IS NULL)
                OR
                -- (ii) delivery recovery (resend path): same password, version,
                -- issue and expiry; only the challenge is replaced
                (NEW."email" = OLD."email"
                 AND NEW."credential_version" = OLD."credential_version"
                 AND NEW."issued_at" = OLD."issued_at"
                 AND NEW."password_hash" IS NOT NULL
                 AND NEW."password_hash" IS NOT DISTINCT FROM OLD."password_hash"
                 AND NEW."expires_at" = OLD."expires_at" AND NEW."expires_at" > now()
                 AND NEW."user_id" IS NULL AND NEW."consumed_at" IS NULL AND OLD."consumed_at" IS NULL
                 AND NEW."challenge_id" IS DISTINCT FROM OLD."challenge_id")
            ) THEN
                RAISE EXCEPTION 'revoked registration requires a fresh credential generation or delivery recovery';
            END IF;
        END IF;
        IF OLD."consumed_at" IS NOT NULL AND (NEW."consumed_at" IS DISTINCT FROM OLD."consumed_at"
           OR NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."password_hash" IS NOT NULL) THEN
            RAISE EXCEPTION 'consumed registration cannot be reopened or reassigned';
        END IF;
    END IF;
    RETURN CASE WHEN is_delete THEN OLD ELSE NEW END;
END;
$$;

ALTER TABLE "users" DROP COLUMN "password_hash";
