import type { ReactNode } from "react";
import { WorkspaceShell } from "./WorkspaceShell";
import "./dashboard.css";
import "./payables.css";
import "./workspace.css";
import "./invoice-review.css";
export default function DashboardLayout({children}:{children:ReactNode}) { return <WorkspaceShell>{children}</WorkspaceShell>; }
