"use client";
import Link from "next/link";
import {useWorkspace} from "../WorkspaceProvider";
import {Header} from "../WorkspaceUI";
import {AdministrationControls} from "../AdministrationControls";
export function RecordScreen({view}:{view:'vendors'|'orders'}){const {api,busy,action,notify}=useWorkspace();return <><Header title={view==='vendors'?'Vendors':'Purchase Orders'} description="Owner maintained records. Verification and acceptance references must reflect your actual evidence."/><nav className="ws-tabs" aria-label="Business records"><Link href="/dashboard/records/vendors">Vendors</Link><Link href="/dashboard/records/purchase-orders">Purchase Orders</Link></nav><AdministrationControls view={view} api={api} busy={busy} action={action} updated={message=>{notify(message);return Promise.resolve();}}/></>;}
