-- StockWise Learner Lab demo: runtime grants, re-applied after every
-- `prisma migrate deploy` by the ops ECS task (ops/ops-task.sh prepare), as
-- stockwise_migrator. Idempotent.
\set ON_ERROR_STOP on

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO stockwise_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO stockwise_app;

-- The migration history is written only by migrations; the runtime only reads
-- it. demo_dataset_runs (ADR-043) is written only by the operator
-- provision-demo action. The Native authentication guard
-- (guard_native_auth_dml, ADR-045) reads only `users`, which the runtime role
-- may already select, so it needs no extra grant.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON _prisma_migrations, demo_dataset_runs FROM stockwise_app;
GRANT SELECT ON _prisma_migrations, demo_dataset_runs TO stockwise_app;

-- Never: TRUNCATE, REFERENCES, TRIGGER, ownership or schema CREATE for the app.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM stockwise_app;
REVOKE CREATE ON SCHEMA public FROM stockwise_app;

-- Fail the deploy if the runtime role could alter the migration history or the
-- demo provenance, or has DDL-level privileges.
DO $$
BEGIN
  IF has_table_privilege('stockwise_app', '_prisma_migrations', 'INSERT')
     OR has_table_privilege('stockwise_app', '_prisma_migrations', 'UPDATE')
     OR has_table_privilege('stockwise_app', '_prisma_migrations', 'DELETE')
     OR has_table_privilege('stockwise_app', '_prisma_migrations', 'TRUNCATE')
     OR has_table_privilege('stockwise_app', 'demo_dataset_runs', 'INSERT')
     OR has_table_privilege('stockwise_app', 'demo_dataset_runs', 'UPDATE')
     OR has_table_privilege('stockwise_app', 'demo_dataset_runs', 'DELETE')
     OR has_table_privilege('stockwise_app', 'demo_dataset_runs', 'TRUNCATE')
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
