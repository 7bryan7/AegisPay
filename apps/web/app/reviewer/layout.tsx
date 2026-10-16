import type {ReactNode} from "react";
import {WorkspaceShell} from "../dashboard/WorkspaceShell";
import "../dashboard/dashboard.css";
import "../dashboard/payables.css";
import "../dashboard/workspace.css";
export default function Layout({children}:{children:ReactNode}){return <WorkspaceShell>{children}</WorkspaceShell>;}
