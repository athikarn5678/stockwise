-- StockWise Learner Lab demo: runtime grants, re-applied after every
-- `prisma migrate deploy` by the ops ECS task (ops/ops-task.sh prepare), as
-- stockwise_migrator. Idempotent.
\set ON_ERROR_STOP on

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stockwise_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stockwise_app;

-- The Native fence, its enrollment provenance and the migration history are
-- written only by migrations and the operator native:cutover; the runtime
-- (including the startup preflight) only reads them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON native_auth_transition, native_auth_enrollments, _prisma_migrations FROM stockwise_app;
GRANT SELECT ON native_auth_transition, native_auth_enrollments, _prisma_migrations TO stockwise_app;
-- The fence trigger guard_native_auth_dml() reads the fence row FOR SHARE on
-- every guarded write (e.g. a Native session insert), and PostgreSQL requires
-- UPDATE on at least one column for row locks. Grant only the "id" column;
-- native_auth_transition_guard still rejects any actual UPDATE or DELETE.
GRANT UPDATE ("id") ON native_auth_transition TO stockwise_app;

-- Never: TRUNCATE, REFERENCES, TRIGGER, ownership or schema CREATE for the app.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM stockwise_app;
REVOKE CREATE ON SCHEMA public FROM stockwise_app;

-- Fail the deploy if the runtime role could alter the fence.
DO $$
BEGIN
  IF has_table_privilege('stockwise_app', 'native_auth_transition', 'UPDATE')
     OR EXISTS (SELECT FROM information_schema.column_privileges
                WHERE grantee = 'stockwise_app' AND table_name = 'native_auth_transition'
                  AND privilege_type = 'UPDATE' AND column_name <> 'id')
     OR has_table_privilege('stockwise_app', 'native_auth_transition', 'DELETE')
     OR has_table_privilege('stockwise_app', 'native_auth_transition', 'TRUNCATE')
     OR has_schema_privilege('stockwise_app', 'public', 'CREATE')
     OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = 'stockwise_app')
     OR EXISTS (SELECT FROM pg_roles WHERE rolname = 'stockwise_app'
                AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication))
  THEN
    RAISE EXCEPTION 'stockwise_app has more than runtime privileges';
  END IF;
END
$$;
