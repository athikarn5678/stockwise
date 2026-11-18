-- M5-S2 / ADR-048: persisted on-demand AI analysis runs (tenant scoped).
-- Additive only: one new table, no existing table rewritten or locked. The branch
-- FK is the composite same-organization key used by ai_insight_reports. CHECKs:
-- supported day windows, a valid local period, and at least one language stored
-- (a language that failed generation stays NULL until it is retried).
-- CreateTable
CREATE TABLE "ai_analysis_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "local_from" DATE NOT NULL,
    "local_to" DATE NOT NULL,
    "reporting_timezone" VARCHAR(255) NOT NULL,
    "content_th" TEXT,
    "content_en" TEXT,
    "model" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_analysis_runs_scope_created_idx" ON "ai_analysis_runs"("organization_id", "branch_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "ai_analysis_runs" ADD CONSTRAINT "ai_analysis_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_analysis_runs" ADD CONSTRAINT "ai_analysis_runs_branch_id_organization_id_fkey" FOREIGN KEY ("branch_id", "organization_id") REFERENCES "branches"("id", "organization_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_analysis_runs" ADD CONSTRAINT "ai_analysis_runs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE "ai_analysis_runs"
    ADD CONSTRAINT "ai_analysis_runs_days_check" CHECK ("days" IN (7, 14, 30)),
    ADD CONSTRAINT "ai_analysis_runs_period_check" CHECK ("local_from" < "local_to"),
    ADD CONSTRAINT "ai_analysis_runs_content_check" CHECK ("content_th" IS NOT NULL OR "content_en" IS NOT NULL);
