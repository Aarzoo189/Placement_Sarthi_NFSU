import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./components/layout/ProtectedRoute";
import { Activate } from "./pages/Activate";
import { CoordinatorDashboard, PlacementOfficerDashboard, SuperAdminDashboard } from "./pages/dashboards/StaffDashboards";
import { HrPipeline } from "./pages/hr/Pipeline";
import { CompanyReportPage, ProposalsPage } from "./pages/officer/OfficerPages";
import { DrivesPage } from "./pages/shared/Drives";
import { AuditPage, ExportsPage, PolicyPage } from "./pages/shared/Governance";
import { ExceptionsPage, OffersPage, ReviewPage, SwitchingPage } from "./pages/shared/Operations";
import { Security } from "./pages/shared/Security";
import { StudentsPage } from "./pages/shared/Students";
import { SignIn } from "./pages/SignIn";
import { StudentDashboard } from "./pages/student/StudentDashboard";
import { StudentApplications, StudentDrives, StudentNotifications, StudentOffers } from "./pages/student/StudentPages";
import { AccountsPage, SystemPage } from "./pages/superadmin/SuperAdminPages";

// The Placement Administrator role has no area in this portal.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<SignIn />} />
      <Route path="/activate" element={<Activate />} />

      <Route path="/student/*" element={<ProtectedRoute role="student"><Routes>
        <Route index element={<StudentDashboard />} />
        <Route path="drives" element={<StudentDrives />} />
        <Route path="applications" element={<StudentApplications />} />
        <Route path="offers" element={<StudentOffers />} />
        <Route path="notifications" element={<StudentNotifications />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/student" replace />} />
      </Routes></ProtectedRoute>} />

      <Route path="/coordinator/*" element={<ProtectedRoute role="coordinator"><Routes>
        <Route index element={<CoordinatorDashboard />} />
        <Route path="students" element={<StudentsPage mode="coordinator" />} />
        <Route path="drives" element={<DrivesPage role="coordinator" />} />
        <Route path="offers" element={<OffersPage role="coordinator" />} />
        <Route path="switching" element={<SwitchingPage />} />
        <Route path="review" element={<ReviewPage role="coordinator" />} />
        <Route path="exceptions" element={<ExceptionsPage role="coordinator" />} />
        <Route path="exports" element={<ExportsPage role="coordinator" />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/coordinator" replace />} />
      </Routes></ProtectedRoute>} />

      <Route path="/placement-officer/*" element={<ProtectedRoute role="placement_officer"><Routes>
        <Route index element={<PlacementOfficerDashboard />} />
        <Route path="drives" element={<DrivesPage role="placement_officer" />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="offers" element={<OffersPage role="placement_officer" />} />
        <Route path="students" element={<StudentsPage mode="officer" />} />
        <Route path="switching" element={<SwitchingPage />} />
        <Route path="review" element={<ReviewPage role="placement_officer" />} />
        <Route path="exceptions" element={<ExceptionsPage role="placement_officer" />} />
        <Route path="policy" element={<PolicyPage mode="officer" />} />
        <Route path="companies" element={<CompanyReportPage />} />
        <Route path="exports" element={<ExportsPage role="placement_officer" />} />
        <Route path="audit" element={<AuditPage role="placement_officer" />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/placement-officer" replace />} />
      </Routes></ProtectedRoute>} />

      <Route path="/company-hr/*" element={<ProtectedRoute role="company_hr"><Routes>
        <Route index element={<HrPipeline />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/company-hr" replace />} />
      </Routes></ProtectedRoute>} />

      <Route path="/super-admin/*" element={<ProtectedRoute role="super_admin"><Routes>
        <Route index element={<SuperAdminDashboard />} />
        <Route path="policy" element={<PolicyPage mode="superadmin" />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="audit" element={<AuditPage role="super_admin" />} />
        <Route path="students" element={<StudentsPage mode="superadmin" />} />
        <Route path="exports" element={<ExportsPage role="super_admin" />} />
        <Route path="security" element={<Security />} />
        <Route path="*" element={<Navigate to="/super-admin" replace />} />
      </Routes></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
