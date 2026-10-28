-- StockWise Learner Lab demo: one-time database role bootstrap (ADR-039/ADR-040).
-- Run as the RDS master user by the ops-bootstrap ECS task
-- (ops/ops-task.sh bootstrap-roles); idempotent.
-- Passwords arrive through psql \getenv from the process environment and are
-- never on a command line, in this file, in Terraform state or in Git.
--   stockwise_migrator  owns the public schema; migrations, grants, cutover,
--                       optional demo seeding.
--   stockwise_app       runtime role: DML only; cannot own, alter, truncate or
--                       disable triggers on any table, and only reads the
--                       Native authentication fence (see grants.sql).
\set ON_ERROR_STOP on
\getenv migrator_password STOCKWISE_MIGRATOR_DB_PASSWORD
\getenv app_password STOCKWISE_APP_DB_PASSWORD

SELECT 'CREATE ROLE stockwise_migrator LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stockwise_migrator') \gexec
SELECT 'CREATE ROLE stockwise_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stockwise_app') \gexec

-- CREATE ROLE already yields NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
-- NOBYPASSRLS. They are not restated here: PostgreSQL 16 only lets a role change
-- those attributes if it holds them, and the RDS master is not a superuser. The
-- guard below fails the bootstrap instead if either role is ever privileged.
ALTER ROLE stockwise_migrator WITH LOGIN PASSWORD :'migrator_password';
ALTER ROLE stockwise_app WITH LOGIN NOINHERIT PASSWORD :'app_password';

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('stockwise_migrator', 'stockwise_app')
             AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'stockwise_migrator and stockwise_app must not hold elevated role attributes';
  END IF;
END
$$;

-- The master must be a member to hand the schema to the migrator (RDS master
-- is not a true superuser).
GRANT stockwise_migrator TO CURRENT_USER;
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO stockwise_migrator', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO stockwise_app', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec

ALTER SCHEMA public OWNER TO stockwise_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO stockwise_app;

-- Tables the migrator creates later inherit runtime DML grants.
ALTER DEFAULT PRIVILEGES FOR ROLE stockwise_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stockwise_app;
ALTER DEFAULT PRIVILEGES FOR ROLE stockwise_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO stockwise_app;
