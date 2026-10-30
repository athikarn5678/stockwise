-- ADR-043: server-authoritative provenance for an isolated synthetic demo
-- organization. Additive and forward-only: one new table, no change to any
-- existing table or row. Written only by the operator `provision-demo` action
-- (the runtime role receives SELECT only, see infra/learner-lab/db/grants.sql).
CREATE TABLE "demo_dataset_runs" (
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "signature" CHAR(64) NOT NULL,
    "plan" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "baseline" JSONB,
    "history_digest" CHAR(64),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_dataset_runs_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "demo_dataset_runs_state_check" CHECK ("state" IN ('IN_PROGRESS', 'COMPLETE')),
    CONSTRAINT "demo_dataset_runs_complete_check" CHECK (
        ("state" = 'COMPLETE') = ("baseline" IS NOT NULL AND "history_digest" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);

ALTER TABLE "demo_dataset_runs"
    ADD CONSTRAINT "demo_dataset_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A run can only be created IN_PROGRESS, so COMPLETE is reachable solely through
-- the guarded transition. A COMPLETE run is immutable and never deleted; an
-- IN_PROGRESS run may only advance to COMPLETE without changing its identity or
-- recorded plan.
CREATE FUNCTION "demo_dataset_runs_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'IN_PROGRESS' THEN
            RAISE EXCEPTION 'a demo_dataset_runs row is created IN_PROGRESS';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'demo_dataset_runs rows are never deleted';
    END IF;
    IF OLD."state" = 'COMPLETE' THEN
        RAISE EXCEPTION 'a COMPLETE demo_dataset_runs row is immutable';
    END IF;
    IF NEW."organization_id" <> OLD."organization_id"
       OR NEW."name" <> OLD."name"
       OR NEW."signature" <> OLD."signature"
       OR NEW."plan" <> OLD."plan" THEN
        RAISE EXCEPTION 'demo_dataset_runs identity and plan are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "demo_dataset_runs_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "demo_dataset_runs"
    FOR EACH ROW EXECUTE FUNCTION "demo_dataset_runs_guard"();
