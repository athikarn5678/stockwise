-- Durable database fence for the Legacy-to-Native authentication transition.
-- Trigger row locks serialize authentication DML with the migration runner's
-- ACCESS EXCLUSIVE table locks and the singleton state transition.
ALTER TYPE "verification_revocation_reason" ADD VALUE 'NATIVE_CUTOVER';
BEGIN;

CREATE TABLE "native_auth_transition" (
    "id" BOOLEAN NOT NULL DEFAULT TRUE,
    "state" VARCHAR(16) NOT NULL DEFAULT 'LEGACY',
    "run_id" UUID,
    "quiesced_at" TIMESTAMPTZ(3),
    "sealed_at" TIMESTAMPTZ(3),
    "baseline" JSONB,
    CONSTRAINT "native_auth_transition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "native_auth_transition_singleton_check" CHECK ("id" = TRUE),
    CONSTRAINT "native_auth_transition_state_check" CHECK ("state" IN ('LEGACY', 'QUIESCED', 'NATIVE')),
    CONSTRAINT "native_auth_transition_state_shape_check" CHECK (
        ("state" = 'LEGACY' AND "run_id" IS NULL AND "quiesced_at" IS NULL AND "sealed_at" IS NULL AND "baseline" IS NULL)
        OR ("state" = 'QUIESCED' AND "run_id" IS NOT NULL AND "quiesced_at" IS NOT NULL AND "sealed_at" IS NULL
            AND "baseline" IS NOT NULL AND jsonb_typeof("baseline") = 'array')
        OR ("state" = 'NATIVE' AND "run_id" IS NOT NULL AND "quiesced_at" IS NOT NULL AND "sealed_at" IS NOT NULL
            AND "baseline" IS NOT NULL AND jsonb_typeof("baseline") = 'array' AND "quiesced_at" <= "sealed_at")
    )
);
INSERT INTO "native_auth_transition" ("id", "state") VALUES (TRUE, 'LEGACY');

CREATE TABLE "native_auth_enrollments" (
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "source_credential_version" BIGINT NOT NULL,
    "source_password_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "native_auth_enrollments_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "native_auth_enrollments_account_id_key" UNIQUE ("account_id"),
    CONSTRAINT "native_auth_enrollments_source_version_check" CHECK ("source_credential_version" > 0),
    CONSTRAINT "native_auth_enrollments_source_digest_check" CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "native_auth_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "native_auth_enrollments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "better_auth_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "guard_native_auth_transition_row"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'native authentication transition singleton cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."id" IS NOT TRUE THEN
        RAISE EXCEPTION 'native authentication transition singleton id is immutable';
    END IF;
    IF NEW."state" IS NOT DISTINCT FROM OLD."state" THEN
        IF (NEW."run_id", NEW."quiesced_at", NEW."sealed_at", NEW."baseline")
            IS DISTINCT FROM (OLD."run_id", OLD."quiesced_at", OLD."sealed_at", OLD."baseline") THEN
            RAISE EXCEPTION 'native authentication transition metadata is immutable within a state';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."state" = 'LEGACY' AND NEW."state" = 'QUIESCED' THEN
        IF OLD."run_id" IS NOT NULL OR OLD."quiesced_at" IS NOT NULL OR OLD."sealed_at" IS NOT NULL OR OLD."baseline" IS NOT NULL
           OR NEW."run_id" IS NULL OR NEW."quiesced_at" IS NULL OR NEW."sealed_at" IS NOT NULL THEN
            RAISE EXCEPTION 'invalid native authentication quiesce transition';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."state" = 'QUIESCED' AND NEW."state" = 'NATIVE' THEN
        IF (NEW."run_id", NEW."quiesced_at", NEW."baseline") IS DISTINCT FROM (OLD."run_id", OLD."quiesced_at", OLD."baseline")
           OR OLD."sealed_at" IS NOT NULL OR NEW."sealed_at" IS NULL THEN
            RAISE EXCEPTION 'invalid native authentication seal transition';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'native authentication transition cannot regress or skip states';
END;
$$;
CREATE TRIGGER "native_auth_transition_guard" BEFORE UPDATE OR DELETE ON "native_auth_transition"
FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_transition_row"();

CREATE FUNCTION "reject_native_auth_enrollment_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'native authentication enrollment provenance is append-only';
END;
$$;
CREATE TRIGGER "native_auth_enrollments_immutable" BEFORE UPDATE OR DELETE ON "native_auth_enrollments"
FOR EACH ROW EXECUTE FUNCTION "reject_native_auth_enrollment_mutation"();

CREATE FUNCTION "guard_native_auth_enrollment_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    transition_state TEXT;
    transition_run UUID;
BEGIN
    SELECT "state", "run_id" INTO transition_state, transition_run
    FROM "native_auth_transition" WHERE "id" = TRUE FOR SHARE;
    IF transition_state <> 'QUIESCED'
       OR current_setting('stockwise.transition_run', TRUE) IS DISTINCT FROM transition_run::TEXT
       OR NEW."run_id" IS DISTINCT FROM transition_run THEN
        RAISE EXCEPTION 'native authentication enrollment requires the active transition run';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM "users" u
        JOIN "better_auth_accounts" a ON a."id" = NEW."account_id"
        WHERE u."id" = NEW."user_id"
          AND a."user_id" = u."id"
          AND a."provider_id" = 'credential'
          AND a."account_id" = u."id"::TEXT
          AND a."password" = u."password_hash"
          AND u."credential_version" = NEW."source_credential_version"
          AND u."password_changed_at" = NEW."source_password_changed_at"
    ) THEN
        RAISE EXCEPTION 'native authentication enrollment source does not match Legacy identity';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "native_auth_enrollments_insert_guard" BEFORE INSERT ON "native_auth_enrollments"
FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_enrollment_insert"();

CREATE FUNCTION "guard_native_auth_dml"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    transition_state TEXT;
    transition_run UUID;
    transition_quiesced_at TIMESTAMPTZ(3);
    is_insert BOOLEAN := (TG_OP = 'INSERT');
    is_delete BOOLEAN := (TG_OP = 'DELETE');
    local_run TEXT;
BEGIN
    SELECT "state", "run_id", "quiesced_at" INTO transition_state, transition_run, transition_quiesced_at
    FROM "native_auth_transition" WHERE "id" = TRUE FOR SHARE;
    IF transition_state IS NULL THEN
        RAISE EXCEPTION 'native authentication transition fence is missing';
    END IF;
    IF transition_state = 'LEGACY' THEN
        RETURN CASE WHEN is_delete THEN OLD ELSE NEW END;
    END IF;

    local_run := current_setting('stockwise.transition_run', TRUE);
    IF transition_state = 'QUIESCED' THEN
        IF local_run IS DISTINCT FROM transition_run::TEXT THEN
            RAISE EXCEPTION 'authentication writes are quiesced';
        END IF;
        IF TG_TABLE_NAME = 'users' THEN
            IF is_insert OR is_delete THEN RAISE EXCEPTION 'users cannot be inserted or deleted during authentication transition'; END IF;
            IF (to_jsonb(NEW) - ARRAY['native_registration_completed_at', 'better_auth_email_verified', 'updated_at'])
                    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['native_registration_completed_at', 'better_auth_email_verified', 'updated_at']) THEN
                RAISE EXCEPTION 'unrelated Legacy identity mutation is not allowed during authentication transition';
            END IF;
            IF NEW."native_registration_completed_at" IS DISTINCT FROM OLD."native_registration_completed_at"
               AND (OLD."native_registration_completed_at" IS NOT NULL OR NEW."native_registration_completed_at" IS NULL
                    OR NEW."better_auth_email_verified" IS DISTINCT FROM OLD."better_auth_email_verified"
                    OR NOT EXISTS (SELECT 1 FROM "native_auth_enrollments" e WHERE e."user_id" = OLD."id" AND e."run_id" = transition_run)) THEN
                RAISE EXCEPTION 'only first Native enrollment marking with durable provenance is allowed during authentication transition';
            END IF;
            IF NEW."better_auth_email_verified" IS DISTINCT FROM OLD."better_auth_email_verified"
               AND (OLD."native_registration_completed_at" IS NOT NULL
                    OR NEW."better_auth_email_verified" IS DISTINCT FROM (OLD."email_verified_at" IS NOT NULL)
                    OR EXISTS (SELECT 1 FROM "better_auth_accounts" a
                               WHERE a."user_id" = OLD."id"
                                  OR (a."provider_id" = 'credential' AND a."account_id" = OLD."id"::TEXT))) THEN
                RAISE EXCEPTION 'Legacy email verification reconciliation requires an unenrolled identity without a Native destination';
            END IF;
        ELSIF TG_TABLE_NAME = 'better_auth_accounts' THEN
            IF NOT is_insert OR NEW."provider_id" <> 'credential'
               OR NEW."account_id" <> NEW."user_id"::TEXT
               OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = NEW."user_id" AND u."password_hash" = NEW."password") THEN
                RAISE EXCEPTION 'only a credential account containing the exact Legacy verifier may be transferred';
            END IF;
        ELSIF TG_TABLE_NAME IN ('sessions', 'better_auth_sessions', 'better_auth_verifications') THEN
            IF is_insert THEN RAISE EXCEPTION 'authentication authority cannot be created during transition'; END IF;
            IF TG_TABLE_NAME = 'sessions' THEN
                IF NOT is_delete AND (NEW."revoked_at" IS NULL
                   OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])
                      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])) THEN
                    RAISE EXCEPTION 'only terminal Legacy session revocation is allowed during transition';
                END IF;
            ELSIF TG_TABLE_NAME = 'better_auth_sessions' AND NOT is_delete THEN
                RAISE EXCEPTION 'Native sessions must be invalidated during transition';
            ELSIF TG_TABLE_NAME = 'better_auth_verifications' AND NOT is_delete THEN
                RAISE EXCEPTION 'Native verifications must be removed during transition';
            END IF;
        ELSIF TG_TABLE_NAME = 'password_reset_tokens' THEN
            IF is_insert THEN RAISE EXCEPTION 'reset authority cannot be created during transition'; END IF;
            IF NOT is_delete AND (NEW."revoked_at" IS NULL
               OR (to_jsonb(NEW) - ARRAY['revoked_at', 'replaced_at', 'updated_at'])
                  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'replaced_at', 'updated_at'])) THEN
                RAISE EXCEPTION 'only terminal reset revocation is allowed during transition';
            END IF;
        ELSIF TG_TABLE_NAME = 'email_verification_challenges' THEN
            IF is_insert THEN RAISE EXCEPTION 'verification authority cannot be created during transition'; END IF;
            IF NOT is_delete AND (NEW."revoked_at" IS NULL
               OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])
                  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])) THEN
                RAISE EXCEPTION 'only terminal verification revocation is allowed during transition';
            END IF;
        ELSIF TG_TABLE_NAME = 'pending_registrations' THEN
            IF is_insert THEN RAISE EXCEPTION 'registration authority cannot be created during transition'; END IF;
            IF NOT is_delete AND (NEW."revoked_at" IS NULL
               OR (to_jsonb(NEW) - ARRAY['revoked_at'])
                  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at'])) THEN
                RAISE EXCEPTION 'only terminal registration revocation is allowed during transition';
            END IF;
        END IF;
        RETURN CASE WHEN is_delete THEN OLD ELSE NEW END;
    END IF;

    -- NATIVE: the old application tables are permanently fenced. Native reset
    -- changes the Better Auth credential/account plus the User version only.
    IF TG_TABLE_NAME = 'users' THEN
        IF is_delete THEN RAISE EXCEPTION 'user deletion is not permitted'; END IF;
        IF is_insert THEN
            IF NEW."native_registration_completed_at" IS NULL THEN RAISE EXCEPTION 'new users require Native registration provenance'; END IF;
            RETURN NEW;
        END IF;
        IF NEW."credential_version" < OLD."credential_version" OR NEW."credential_version" <= 0
           OR NEW."email_verified_at" IS DISTINCT FROM OLD."email_verified_at"
           OR NEW."password_hash" IS DISTINCT FROM OLD."password_hash"
           OR NEW."native_registration_completed_at" IS DISTINCT FROM OLD."native_registration_completed_at"
           OR (OLD."native_registration_completed_at" IS NULL AND (NEW."credential_version" IS DISTINCT FROM OLD."credential_version" OR NEW."password_changed_at" IS DISTINCT FROM OLD."password_changed_at")) THEN
            RAISE EXCEPTION 'Legacy identity authority is immutable in Native mode';
        END IF;
    ELSIF TG_TABLE_NAME = 'sessions' THEN
        IF is_insert OR is_delete THEN RAISE EXCEPTION 'Legacy sessions are disabled in Native mode'; END IF;
        IF OLD."revoked_at" IS NOT NULL OR NEW."revoked_at" IS NULL
           OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])
              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revocation_reason', 'updated_at']) THEN
            RAISE EXCEPTION 'only terminal Legacy session revocation is permitted';
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
    ELSIF TG_TABLE_NAME = 'email_verification_challenges' THEN
        IF is_delete THEN RAISE EXCEPTION 'verification history cannot be deleted'; END IF;
        IF is_insert THEN
            IF NEW."is_legacy" OR NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = NEW."user_id" AND u."native_registration_completed_at" IS NOT NULL) THEN
                RAISE EXCEPTION 'Legacy verification authority is disabled in Native mode';
            END IF;
            RETURN NEW;
        END IF;
        IF OLD."is_legacy" THEN
            IF OLD."revoked_at" IS NOT NULL OR NEW."revoked_at" IS NULL
               OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revocation_reason', 'updated_at'])
                  IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revocation_reason', 'updated_at']) THEN
                RAISE EXCEPTION 'Legacy verification authority permits terminal revocation only';
            END IF;
        ELSIF NEW."is_legacy" IS DISTINCT FROM OLD."is_legacy"
           OR NEW."link_token_hash" IS DISTINCT FROM OLD."link_token_hash" OR NEW."otp_mac" IS DISTINCT FROM OLD."otp_mac"
           OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
           OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
            RAISE EXCEPTION 'Native verification authority is immutable';
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
        IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL
           AND OLD."issued_at" <= transition_quiesced_at THEN
            IF NEW."credential_version" <= OLD."credential_version"
               OR NEW."issued_at" <= OLD."issued_at"
               OR NEW."challenge_id" IS NOT DISTINCT FROM OLD."challenge_id"
               OR NEW."password_hash" IS NULL OR NEW."consumed_at" IS NOT NULL
               OR NEW."user_id" IS NOT NULL OR OLD."consumed_at" IS NOT NULL THEN
                RAISE EXCEPTION 'revoked registration requires a fresh credential generation';
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

CREATE TRIGGER "users_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "sessions_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "sessions" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "password_reset_tokens_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "password_reset_tokens" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "email_verification_challenges_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "email_verification_challenges" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "better_auth_accounts_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "better_auth_accounts" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "better_auth_sessions_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "better_auth_sessions" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "better_auth_verifications_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "better_auth_verifications" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();
CREATE TRIGGER "pending_registrations_native_auth_fence" BEFORE INSERT OR UPDATE OR DELETE ON "pending_registrations" FOR EACH ROW EXECUTE FUNCTION "guard_native_auth_dml"();

COMMIT;
