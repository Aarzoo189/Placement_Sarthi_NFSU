-- =====================================================================================================================
-- Security layer (architecture doc, sections 3, 6 and 8). Runs as placement_owner after the table migration.
--
--  1. pgcrypto + request-context helpers (app.user_id / app.role are set per transaction by DbService.run)
--  2. Integrity: CHECK constraints and triggers (server-computed fields cannot be written by the wrong role)
--  3. Views (dashboards read only from views; views run with the caller's rights so row-level security still applies)
--  4. Grants for placement_app: append-only tables get INSERT/SELECT only
--  5. Row-level security: the database enforces role -> scope even if an API check is forgotten
--
-- NOTE: when the Prisma schema adds tables, add their GRANT/RLS lines in a new migration (default privileges are not used,
-- so a new table is invisible to the app role until it is granted on purpose).
-- =====================================================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------------- 1. context
CREATE OR REPLACE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.role', true), '') $$;

CREATE OR REPLACE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Scope lookups run as the function owner (SECURITY DEFINER) so that policies can consult scope tables without
-- re-entering row-level security (which would recurse).
CREATE OR REPLACE FUNCTION app_coord_programmes() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT programme_id FROM coordinator_scope WHERE user_id = app_uid() $$;

CREATE OR REPLACE FUNCTION app_hr_drives() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT d.id FROM drive d JOIN hr_user h ON h.company_id = d.company_id WHERE h.user_id = app_uid() AND h.valid_until > now() $$;

CREATE OR REPLACE FUNCTION app_student_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id FROM student WHERE user_id = app_uid() $$;

CREATE OR REPLACE FUNCTION app_hr_students() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT a.student_id FROM application a WHERE a.drive_id IN (SELECT app_hr_drives()) $$;

CREATE OR REPLACE FUNCTION app_student_programme(sid uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT programme_id FROM student WHERE id = sid $$;

CREATE OR REPLACE FUNCTION app_offer_student(oid uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT student_id FROM offer WHERE id = oid $$;

CREATE OR REPLACE FUNCTION app_offer_drive(oid uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT drive_id FROM offer WHERE id = oid $$;

-- Convenience predicates used by the policies below.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() IN ('system', 'officer', 'admin') $$;

CREATE OR REPLACE FUNCTION app_can_see_student(sid uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() IN ('system', 'officer', 'admin', 'superadmin')
       OR (app_role() = 'student' AND sid = app_student_id())
       OR (app_role() = 'coordinator' AND app_student_programme(sid) IN (SELECT app_coord_programmes()))
       OR (app_role() = 'hr' AND sid IN (SELECT app_hr_students())) $$;

-- ------------------------------------------------------------------------------------------------ 2. integrity
ALTER TABLE student ADD CONSTRAINT student_cgpa_range CHECK (cgpa >= 0 AND cgpa <= 10);
ALTER TABLE student ADD CONSTRAINT student_backlogs_nonneg CHECK (backlogs >= 0);
ALTER TABLE student ADD CONSTRAINT student_batch_range CHECK (batch BETWEEN 2000 AND 2100);
ALTER TABLE student ADD CONSTRAINT student_placement_id_format CHECK (placement_id ~ '^[A-Z0-9-]{6,20}$');
ALTER TABLE drive ADD CONSTRAINT drive_ctc_range CHECK (ctc_lpa IS NULL OR (ctc_lpa > 0 AND ctc_lpa <= 1000));
ALTER TABLE drive ADD CONSTRAINT drive_stipend_nonneg CHECK (stipend_amount IS NULL OR stipend_amount >= 0);
ALTER TABLE drive ADD CONSTRAINT drive_ctc_matches_type CHECK (offer_type = 'I' OR ctc_lpa IS NOT NULL OR status = 'draft');
ALTER TABLE exception ADD CONSTRAINT exception_expiry_after_creation CHECK (expires_at > created_at);
ALTER TABLE offer ADD CONSTRAINT offer_deadline_after_issue CHECK (deadline >= offer_date);
ALTER TABLE policy_rule ADD CONSTRAINT policy_rule_params_object CHECK (jsonb_typeof(params_json) = 'object');

-- Placement ID never changes once issued.
CREATE OR REPLACE FUNCTION trg_student_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.placement_id IS DISTINCT FROM OLD.placement_id THEN
    RAISE EXCEPTION 'placement_id is immutable' USING ERRCODE = '42501';
  END IF;
  -- A student can only confirm their own registration. Everything else on the row is staff-controlled.
  IF app_role() = 'student' AND (
       NEW.name, NEW.mobile_enc, NEW.mobile_hash, NEW.email, NEW.programme_id, NEW.batch, NEW.cgpa, NEW.backlogs,
       NEW.eligibility_status, NEW.user_id, NEW.archived_at
     ) IS DISTINCT FROM (
       OLD.name, OLD.mobile_enc, OLD.mobile_hash, OLD.email, OLD.programme_id, OLD.batch, OLD.cgpa, OLD.backlogs,
       OLD.eligibility_status, OLD.user_id, OLD.archived_at
     ) THEN
    RAISE EXCEPTION 'students may only change their registration status' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER student_immutable BEFORE UPDATE ON student FOR EACH ROW EXECUTE FUNCTION trg_student_immutable();

-- A student can accept or decline an offer, and nothing else: CTC, category, type and deadline are untouchable.
CREATE OR REPLACE FUNCTION trg_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_role() = 'student' THEN
    IF (NEW.student_id, NEW.drive_id, NEW.off_campus_company, NEW.type, NEW.category, NEW.ctc_enc, NEW.stipend_enc,
        NEW.offer_date, NEW.deadline, NEW.ppo_status, NEW.joining_status, NEW.noc_status, NEW.policy_version)
       IS DISTINCT FROM
       (OLD.student_id, OLD.drive_id, OLD.off_campus_company, OLD.type, OLD.category, OLD.ctc_enc, OLD.stipend_enc,
        OLD.offer_date, OLD.deadline, OLD.ppo_status, OLD.joining_status, OLD.noc_status, OLD.policy_version) THEN
      RAISE EXCEPTION 'students may only accept or decline an offer' USING ERRCODE = '42501';
    END IF;
    IF OLD.acceptance_status <> 'pending' OR NEW.acceptance_status NOT IN ('accepted', 'declined') THEN
      RAISE EXCEPTION 'offer is no longer open for a response' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offer_guard BEFORE UPDATE ON offer FOR EACH ROW EXECUTE FUNCTION trg_offer_guard();

-- ------------------------------------------------------------------------------------------------------ 3. views
-- security_invoker: a view runs with the CALLER's rights, so row-level security on the base tables still filters it.
CREATE VIEW attendance_current_v WITH (security_invoker = true) AS
SELECT DISTINCT ON (student_id, drive_id, event)
       id, student_id, drive_id, event, present, exception_id, recorded_by, at
FROM attendance
ORDER BY student_id, drive_id, event, at DESC, id DESC;

CREATE VIEW student_status_v WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.placement_id, s.name, s.programme_id, p.code AS programme_code, p.name AS programme_name,
       s.batch, s.registration_status, s.eligibility_status, s.archived_at,
       COALESCE(st.placement_status, 'Unplaced') AS placement_status,
       st.current_category, COALESCE(st.accepted_offer_count, 0) AS accepted_offer_count,
       st.switching_json, st.policy_version, st.updated_at AS state_updated_at
FROM student s
JOIN programme p ON p.id = s.programme_id
LEFT JOIN student_placement_state st ON st.student_id = s.id;

CREATE VIEW offer_current_v WITH (security_invoker = true) AS
SELECT o.id AS offer_id, o.student_id, s.placement_id, s.name AS student_name, s.programme_id, p.code AS programme_code, s.batch,
       o.drive_id, COALESCE(c.name, o.off_campus_company) AS company, o.type, o.category,
       o.acceptance_status, o.ppo_status, o.joining_status, o.noc_status, o.offer_date, o.deadline,
       (o.drive_id IS NULL) AS off_campus, o.ctc_enc, o.stipend_enc
FROM offer o
JOIN student s ON s.id = o.student_id
JOIN programme p ON p.id = s.programme_id
LEFT JOIN drive d ON d.id = o.drive_id
LEFT JOIN company c ON c.id = d.company_id;

CREATE VIEW application_pipeline_v WITH (security_invoker = true) AS
SELECT a.id AS application_id, a.drive_id, a.student_id, a.stage, a.created_at, a.updated_at, a.engine_decision_id,
       s.name, s.programme_id, p.code AS programme_code, s.batch, s.cgpa
FROM application a
JOIN student s ON s.id = a.student_id
JOIN programme p ON p.id = s.programme_id;

-- ----------------------------------------------------------------------------------------------------- 4. grants
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO placement_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO placement_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO placement_app;
GRANT SELECT ON attendance_current_v, student_status_v, offer_current_v, application_pipeline_v TO placement_app;

-- Hard deletes are allowed only where the data has no history value.
GRANT DELETE ON session, mfa_factor, recovery_code, trusted_device, coordinator_scope, hr_user TO placement_app;

-- Append-only: history is kept, never rewritten. (A compromised API process still cannot edit these.)
REVOKE UPDATE, DELETE ON offer_event, engine_decision, attendance, audit_log, export_log FROM placement_app;
-- Authorised users and migrations are not the app's to alter at the schema level.
REVOKE CREATE ON SCHEMA public FROM placement_app;

-- ------------------------------------------------------------------------------------------ 5. row-level security
-- Every table below is filtered by role -> scope. The `system` role is used by background jobs only.

-- student ----------------------------------------------------------------------------------------------------------
ALTER TABLE student ENABLE ROW LEVEL SECURITY;
CREATE POLICY student_select ON student FOR SELECT USING (app_can_see_student(id));
CREATE POLICY student_insert ON student FOR INSERT WITH CHECK (
  app_is_staff() OR (app_role() = 'coordinator' AND programme_id IN (SELECT app_coord_programmes())));
CREATE POLICY student_update ON student FOR UPDATE
  USING (app_is_staff()
      OR (app_role() = 'coordinator' AND programme_id IN (SELECT app_coord_programmes()))
      OR (app_role() = 'student' AND user_id = app_uid()))
  WITH CHECK (app_is_staff()
      OR (app_role() = 'coordinator' AND programme_id IN (SELECT app_coord_programmes()))
      OR (app_role() = 'student' AND user_id = app_uid()));

-- student_placement_state: written only by the rule engine (system) ---------------------------------------------------
ALTER TABLE student_placement_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY sps_select ON student_placement_state FOR SELECT USING (app_can_see_student(student_id));
CREATE POLICY sps_insert ON student_placement_state FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY sps_update ON student_placement_state FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

-- application -------------------------------------------------------------------------------------------------------
ALTER TABLE application ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_select ON application FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin'
  OR (app_role() = 'student' AND student_id = app_student_id())
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));
CREATE POLICY application_insert ON application FOR INSERT WITH CHECK (
  app_is_staff() OR (app_role() = 'student' AND student_id = app_student_id()));
CREATE POLICY application_update ON application FOR UPDATE
  USING (app_is_staff()
      OR (app_role() = 'student' AND student_id = app_student_id())
      OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())))
  WITH CHECK (app_is_staff()
      OR (app_role() = 'student' AND student_id = app_student_id())
      OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));

-- offer / offer_event -----------------------------------------------------------------------------------------------
ALTER TABLE offer ENABLE ROW LEVEL SECURITY;
CREATE POLICY offer_select ON offer FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin'
  OR (app_role() = 'student' AND student_id = app_student_id())
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));
CREATE POLICY offer_insert ON offer FOR INSERT WITH CHECK (
  app_is_staff() OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes())));
CREATE POLICY offer_update ON offer FOR UPDATE
  USING (app_is_staff()
      OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
      OR (app_role() = 'student' AND student_id = app_student_id()))
  WITH CHECK (app_is_staff()
      OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
      OR (app_role() = 'student' AND student_id = app_student_id()));

ALTER TABLE offer_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY offer_event_select ON offer_event FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin' OR app_can_see_student(app_offer_student(offer_id)));
CREATE POLICY offer_event_insert ON offer_event FOR INSERT WITH CHECK (
  app_is_staff()
  OR (app_role() = 'coordinator' AND app_student_programme(app_offer_student(offer_id)) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'student' AND app_offer_student(offer_id) = app_student_id()));

-- offer_proposal: HR proposes for their own drive; Officer/Admin decide ---------------------------------------------------
ALTER TABLE offer_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY proposal_select ON offer_proposal FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin' OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));
CREATE POLICY proposal_insert ON offer_proposal FOR INSERT WITH CHECK (
  app_role() = 'system' OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives()) AND proposed_by = app_uid()));
CREATE POLICY proposal_update ON offer_proposal FOR UPDATE USING (app_is_staff()) WITH CHECK (app_is_staff());

-- attendance (append-only) ------------------------------------------------------------------------------------------
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY attendance_select ON attendance FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin'
  OR (app_role() = 'student' AND student_id = app_student_id())
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));
CREATE POLICY attendance_insert ON attendance FOR INSERT WITH CHECK (
  app_is_staff()
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'hr' AND drive_id IN (SELECT app_hr_drives())));

-- engine_decision (append-only). HR never sees eligibility reasoning. -----------------------------------------------------
ALTER TABLE engine_decision ENABLE ROW LEVEL SECURITY;
CREATE POLICY decision_select ON engine_decision FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin'
  OR (app_role() = 'student' AND student_id = app_student_id())
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes())));
CREATE POLICY decision_insert ON engine_decision FOR INSERT WITH CHECK (
  app_is_staff()
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes()))
  OR (app_role() = 'student' AND student_id = app_student_id()));

-- exception: only Officer / Admin record them; coordinators can read for their programme ------------------------------------
ALTER TABLE exception ENABLE ROW LEVEL SECURITY;
CREATE POLICY exception_select ON exception FOR SELECT USING (
  app_is_staff() OR app_role() = 'superadmin'
  OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes())));
CREATE POLICY exception_insert ON exception FOR INSERT WITH CHECK (app_is_staff());
CREATE POLICY exception_update ON exception FOR UPDATE USING (app_is_staff()) WITH CHECK (app_is_staff());

-- contact_change_request -----------------------------------------------------------------------------------------------
ALTER TABLE contact_change_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY ccr_select ON contact_change_request FOR SELECT USING (app_can_see_student(student_id) AND app_role() <> 'hr');
CREATE POLICY ccr_insert ON contact_change_request FOR INSERT WITH CHECK (app_role() = 'student' AND student_id = app_student_id());
CREATE POLICY ccr_update ON contact_change_request FOR UPDATE
  USING (app_is_staff() OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes())))
  WITH CHECK (app_is_staff() OR (app_role() = 'coordinator' AND app_student_programme(student_id) IN (SELECT app_coord_programmes())));

-- review_case: the officer's queue; coordinators see their programme's cases ---------------------------------------------
ALTER TABLE review_case ENABLE ROW LEVEL SECURITY;
CREATE POLICY case_select ON review_case FOR SELECT USING (
  app_is_staff() OR (app_role() = 'coordinator' AND programme_id IN (SELECT app_coord_programmes())));
CREATE POLICY case_insert ON review_case FOR INSERT WITH CHECK (app_role() = 'system' OR app_is_staff());
CREATE POLICY case_update ON review_case FOR UPDATE USING (app_is_staff()) WITH CHECK (app_is_staff());
