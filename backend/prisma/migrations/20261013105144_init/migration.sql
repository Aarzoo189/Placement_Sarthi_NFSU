-- CreateEnum
CREATE TYPE "Role" AS ENUM ('student', 'coordinator', 'officer', 'hr', 'admin', 'superadmin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "MfaType" AS ENUM ('totp', 'passkey', 'email');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('not_registered', 'registered', 'deregistered');

-- CreateEnum
CREATE TYPE "EligibilityStatus" AS ENUM ('pending', 'eligible', 'ineligible');

-- CreateEnum
CREATE TYPE "OfferType" AS ENUM ('I', 'F', 'IF');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('A+', 'A', 'B', 'C');

-- CreateEnum
CREATE TYPE "DriveStatus" AS ENUM ('draft', 'open', 'closed');

-- CreateEnum
CREATE TYPE "ApplicationStage" AS ENUM ('pending_review', 'applied', 'shortlisted', 'selected', 'rejected', 'withdrawn');

-- CreateEnum
CREATE TYPE "AttendanceEvent" AS ENUM ('PPT', 'TEST', 'INTERVIEW');

-- CreateEnum
CREATE TYPE "AcceptanceStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "PpoStatus" AS ENUM ('not_applicable', 'pending', 'confirmed', 'declined');

-- CreateEnum
CREATE TYPE "JoiningStatus" AS ENUM ('pending', 'joined', 'not_joined');

-- CreateEnum
CREATE TYPE "NocStatus" AS ENUM ('not_required', 'pending', 'received');

-- CreateEnum
CREATE TYPE "DecisionResult" AS ENUM ('ALLOW', 'BLOCK', 'REVIEW');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('draft', 'proposed', 'published', 'superseded', 'rejected');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('proposed', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "CaseKind" AS ENUM ('engine_review', 'absenteeism', 'violation', 'expired_offer');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('open', 'approved', 'blocked', 'resolved');

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "last_login" TIMESTAMP(3),
    "activation_token_hash" TEXT,
    "activation_expires" TIMESTAMP(3),
    "password_changed_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "MfaType" NOT NULL,
    "secret_enc" TEXT,
    "credential_id" TEXT,
    "public_key" TEXT,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "label" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "step_up_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_device" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programme" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "programme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "placement_id" TEXT NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "mobile_enc" TEXT NOT NULL,
    "mobile_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "programme_id" UUID NOT NULL,
    "batch" INTEGER NOT NULL,
    "cgpa" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "backlogs" INTEGER NOT NULL DEFAULT 0,
    "registration_status" "RegistrationStatus" NOT NULL DEFAULT 'not_registered',
    "eligibility_status" "EligibilityStatus" NOT NULL DEFAULT 'pending',
    "resume_path" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coordinator_scope" (
    "user_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,

    CONSTRAINT "coordinator_scope_pkey" PRIMARY KEY ("user_id","programme_id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "verified_domain" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_user" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "drive" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "offer_type" "OfferType" NOT NULL,
    "ctc_lpa" DECIMAL(6,2),
    "stipend_amount" DECIMAL(10,2),
    "stipend_period" TEXT,
    "category" "Category",
    "criteria_json" JSONB NOT NULL DEFAULT '{}',
    "acceptance_deadline" TIMESTAMP(3),
    "drive_date" TIMESTAMP(3),
    "status" "DriveStatus" NOT NULL DEFAULT 'draft',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "drive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "drive_id" UUID NOT NULL,
    "engine_decision_id" UUID,
    "stage" "ApplicationStage" NOT NULL DEFAULT 'applied',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "drive_id" UUID NOT NULL,
    "event" "AttendanceEvent" NOT NULL,
    "present" BOOLEAN NOT NULL,
    "exception_id" UUID,
    "recorded_by" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "drive_id" UUID,
    "off_campus_company" TEXT,
    "type" "OfferType" NOT NULL,
    "category" "Category",
    "ctc_enc" TEXT,
    "stipend_enc" TEXT,
    "offer_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMP(3) NOT NULL,
    "acceptance_status" "AcceptanceStatus" NOT NULL DEFAULT 'pending',
    "ppo_status" "PpoStatus" NOT NULL DEFAULT 'not_applicable',
    "joining_status" "JoiningStatus" NOT NULL DEFAULT 'pending',
    "noc_status" "NocStatus" NOT NULL DEFAULT 'not_required',
    "policy_version" INTEGER,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "offer_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "actor_id" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_proposal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "drive_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "proposed_by" UUID NOT NULL,
    "ctc_enc" TEXT,
    "stipend_enc" TEXT,
    "note" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'proposed',
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "offer_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_version" (
    "version" INTEGER NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'draft',
    "note" TEXT,
    "created_by" UUID,
    "proposed_by" UUID,
    "published_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "effective_from" TIMESTAMP(3),

    CONSTRAINT "policy_version_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "policy_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "params_json" JSONB NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "drive_id" UUID NOT NULL,
    "result" "DecisionResult" NOT NULL,
    "fired_rules_json" JSONB NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "exception_id" UUID,
    "trigger" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_placement_state" (
    "student_id" UUID NOT NULL,
    "placement_status" TEXT NOT NULL,
    "current_category" "Category",
    "highest_ctc_enc" TEXT,
    "accepted_offer_count" INTEGER NOT NULL DEFAULT 0,
    "switching_json" JSONB NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_placement_state_pkey" PRIMARY KEY ("student_id")
);

-- CreateTable
CREATE TABLE "exception" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "exception_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_change_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "student_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "new_value_enc" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_case" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "CaseKind" NOT NULL,
    "student_id" UUID,
    "programme_id" UUID,
    "application_id" UUID,
    "ref_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "CaseStatus" NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution_reason" TEXT,

    CONSTRAINT "review_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "role" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "before_json" JSONB,
    "after_json" JSONB,
    "meta" JSONB,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "filter_json" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "fields" JSONB NOT NULL,
    "file_hash" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_activation_token_hash_key" ON "user_account"("activation_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factor_credential_id_key" ON "mfa_factor"("credential_id");

-- CreateIndex
CREATE INDEX "mfa_factor_user_id_idx" ON "mfa_factor"("user_id");

-- CreateIndex
CREATE INDEX "recovery_code_user_id_idx" ON "recovery_code"("user_id");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_device_token_hash_key" ON "trusted_device"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "programme_code_key" ON "programme"("code");

-- CreateIndex
CREATE UNIQUE INDEX "student_placement_id_key" ON "student"("placement_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_user_id_key" ON "student"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_mobile_hash_key" ON "student"("mobile_hash");

-- CreateIndex
CREATE UNIQUE INDEX "student_email_key" ON "student"("email");

-- CreateIndex
CREATE INDEX "student_programme_id_batch_idx" ON "student"("programme_id", "batch");

-- CreateIndex
CREATE UNIQUE INDEX "company_name_key" ON "company"("name");

-- CreateIndex
CREATE INDEX "drive_company_id_idx" ON "drive"("company_id");

-- CreateIndex
CREATE INDEX "application_drive_id_stage_idx" ON "application"("drive_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "application_student_id_drive_id_key" ON "application"("student_id", "drive_id");

-- CreateIndex
CREATE INDEX "attendance_student_id_at_idx" ON "attendance"("student_id", "at");

-- CreateIndex
CREATE INDEX "attendance_drive_id_idx" ON "attendance"("drive_id");

-- CreateIndex
CREATE INDEX "offer_student_id_acceptance_status_idx" ON "offer"("student_id", "acceptance_status");

-- CreateIndex
CREATE INDEX "offer_event_offer_id_at_idx" ON "offer_event"("offer_id", "at");

-- CreateIndex
CREATE INDEX "offer_proposal_status_idx" ON "offer_proposal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "policy_rule_version_code_key" ON "policy_rule"("version", "code");

-- CreateIndex
CREATE INDEX "engine_decision_student_id_drive_id_at_idx" ON "engine_decision"("student_id", "drive_id", "at");

-- CreateIndex
CREATE INDEX "review_case_status_kind_idx" ON "review_case"("status", "kind");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_device" ADD CONSTRAINT "trusted_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student" ADD CONSTRAINT "student_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student" ADD CONSTRAINT "student_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coordinator_scope" ADD CONSTRAINT "coordinator_scope_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coordinator_scope" ADD CONSTRAINT "coordinator_scope_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_user" ADD CONSTRAINT "hr_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_user" ADD CONSTRAINT "hr_user_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drive" ADD CONSTRAINT "drive_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application" ADD CONSTRAINT "application_engine_decision_id_fkey" FOREIGN KEY ("engine_decision_id") REFERENCES "engine_decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_exception_id_fkey" FOREIGN KEY ("exception_id") REFERENCES "exception"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer" ADD CONSTRAINT "offer_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drive"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_event" ADD CONSTRAINT "offer_event_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_proposal" ADD CONSTRAINT "offer_proposal_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_rule" ADD CONSTRAINT "policy_rule_version_fkey" FOREIGN KEY ("version") REFERENCES "policy_version"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_decision" ADD CONSTRAINT "engine_decision_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_decision" ADD CONSTRAINT "engine_decision_drive_id_fkey" FOREIGN KEY ("drive_id") REFERENCES "drive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_placement_state" ADD CONSTRAINT "student_placement_state_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception" ADD CONSTRAINT "exception_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_change_request" ADD CONSTRAINT "contact_change_request_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
