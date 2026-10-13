-- The first version of student_select went through app_can_see_student(id) -> app_student_programme(id), a STABLE function that
-- looks the row up by id. Inside the same statement as an INSERT ... RETURNING, that lookup cannot see the row being inserted, so a
-- coordinator creating a student (or importing a CSV) was rejected by their own policy. The policy now reads the row's own columns.
DROP POLICY student_select ON student;
CREATE POLICY student_select ON student FOR SELECT USING (
     app_role() IN ('system', 'officer', 'admin', 'superadmin')
  OR (app_role() = 'student' AND user_id = app_uid())
  OR (app_role() = 'coordinator' AND programme_id IN (SELECT app_coord_programmes()))
  OR (app_role() = 'hr' AND id IN (SELECT app_hr_students()))
);
