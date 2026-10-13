import {
  Award,
  Bell,
  Building2,
  CalendarClock,
  ClipboardList,
  Download,
  FileSearch,
  FolderKanban,
  Gauge,
  GitCompareArrows,
  GraduationCap,
  Inbox,
  Landmark,
  Megaphone,
  Scale,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "./types";

export interface NavItemDef {
  label: string;
  icon: LucideIcon;
  path: string;
  /** which routes also highlight this item */
  end?: boolean;
}

/** Base path of each role's area. */
export const BASE: Record<Role, string> = {
  student: "/student",
  coordinator: "/coordinator",
  placement_officer: "/placement-officer",
  company_hr: "/company-hr",
  super_admin: "/super-admin",
};

const item = (role: Role, label: string, icon: LucideIcon, sub = ""): NavItemDef => ({ label, icon, path: `${BASE[role]}${sub}`, end: sub === "" });

// There is no Placement Administrator area: that role is not part of this portal.
export const navByRole: Record<Role, NavItemDef[]> = {
  student: [
    item("student", "Dashboard", Gauge),
    item("student", "Drives", Megaphone, "/drives"),
    item("student", "Applications", ClipboardList, "/applications"),
    item("student", "Offers", Award, "/offers"),
    item("student", "Notifications", Bell, "/notifications"),
    item("student", "Profile & security", ShieldCheck, "/security"),
  ],
  coordinator: [
    item("coordinator", "Dashboard", Gauge),
    item("coordinator", "Students", GraduationCap, "/students"),
    item("coordinator", "Drives & attendance", CalendarClock, "/drives"),
    item("coordinator", "Offers", Award, "/offers"),
    item("coordinator", "Switching eligibility", GitCompareArrows, "/switching"),
    item("coordinator", "Review queue", FileSearch, "/review"),
    item("coordinator", "Exceptions", ShieldAlert, "/exceptions"),
    item("coordinator", "Exports", Download, "/exports"),
    item("coordinator", "Security", ShieldCheck, "/security"),
  ],
  placement_officer: [
    item("placement_officer", "Dashboard", Gauge),
    item("placement_officer", "Drives & companies", Megaphone, "/drives"),
    item("placement_officer", "Offer proposals", Inbox, "/proposals"),
    item("placement_officer", "Offers", Award, "/offers"),
    item("placement_officer", "Students", GraduationCap, "/students"),
    item("placement_officer", "Switching eligibility", GitCompareArrows, "/switching"),
    item("placement_officer", "Review queue", FileSearch, "/review"),
    item("placement_officer", "Exceptions", ShieldAlert, "/exceptions"),
    item("placement_officer", "Policy rules", Scale, "/policy"),
    item("placement_officer", "Company report", Building2, "/companies"),
    item("placement_officer", "Exports", Download, "/exports"),
    item("placement_officer", "Audit log", ScrollText, "/audit"),
    item("placement_officer", "Security", ShieldCheck, "/security"),
  ],
  company_hr: [
    item("company_hr", "Drive pipeline", FolderKanban),
    item("company_hr", "Security", ShieldCheck, "/security"),
  ],
  super_admin: [
    item("super_admin", "Dashboard", Gauge),
    item("super_admin", "Policy approval", Scale, "/policy"),
    item("super_admin", "Accounts", UserCog, "/accounts"),
    item("super_admin", "System & keys", Server, "/system"),
    item("super_admin", "Audit & integrity", ScrollText, "/audit"),
    item("super_admin", "Student lookup", Users, "/students"),
    item("super_admin", "Exports", Download, "/exports"),
    item("super_admin", "Security", ShieldCheck, "/security"),
  ],
};

export const AppIcon = Landmark;
