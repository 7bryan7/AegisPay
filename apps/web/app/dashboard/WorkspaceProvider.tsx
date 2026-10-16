"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { ApSession } from "@agentpay/core";
import { PayablesApi, PayablesApiError } from "../../lib/payables";
import { ReviewerExamples } from "./ReviewerExamples";

type Context = { mode:string|null; checking:boolean; establish:(session:ApSession)=>void; api: PayablesApi; session: ApSession; busy: boolean; message: string; notify: (message:string)=>void; expire:()=>void; action: (work:()=>Promise<void>)=>Promise<void> };
const WorkspaceContext=createContext<Context|null>(null);
export function useWorkspace() { const value=useContext(WorkspaceContext); if(!value)throw new Error("Workspace provider required");return value; }
export function WorkspaceProvider({children}:{children:ReactNode}) {
 const api=useMemo(()=>new PayablesApi(process.env.NEXT_PUBLIC_API_BASE_URL??"http://localhost:4000"),[]);
 const [session,setSession]=useState<ApSession>({authenticated:false,loginAvailable:false});
 const [mode,setMode]=useState<string|null>(null);
 const [checking,setChecking]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const lock=useRef(false);
 const action=useCallback(async(work:()=>Promise<void>)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setMessage("");
  try{await work();}catch(error){
   if(error instanceof PayablesApiError&&error.status===401)setSession({authenticated:false,loginAvailable:true});
   setMessage(error instanceof PayablesApiError?`${error.message}${error.code?` (${error.code})`:""}`:"Request failed. Review your input or refresh before retrying.");
  }finally{lock.current=false;setBusy(false);}
 },[]);
 useEffect(()=>{let active=true;void api.session().then(s=>{if(active)setSession(s);}).catch(()=>{if(active)setMessage("API unavailable. Check the server before signing in.");}).finally(()=>{if(active)setChecking(false);});return()=>{active=false;};},[api]);
 useEffect(()=>{let active=true;if(session.authenticated)void api.readiness().then(r=>{if(active)setMode(r.configuredMode);}).catch(()=>{if(active)setMode(null);});else setMode(null);return()=>{active=false;};},[api,session.authenticated]);
 const expire=useCallback(()=>setSession({authenticated:false,loginAvailable:true}),[]);
 const value=useMemo(()=>({api,session,busy,message,notify:setMessage,action,expire,checking,establish:setSession,mode}),[api,session,busy,message,action,expire,checking,mode]);
 return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
export function WorkspaceGate({children}:{children:ReactNode}){
 const {api,session,busy,checking,action,establish,expire,message,mode}=useWorkspace();
 const [code,setCode]=useState("");const pathname=usePathname();
 function login(e:FormEvent){e.preventDefault();void action(async()=>{establish(await api.login(code));setCode("");});}
 return <><div className="ap-toolbar"><span>{session.authenticated?`${session.role.toLowerCase()} access`:"Workspace access"}{mode?` · ${mode}`:""}</span>{session.authenticated&&<button disabled={busy} onClick={()=>void action(async()=>{await api.logout();expire();})}>Sign out</button>}</div>
 {mode==="fixture"&&<p className="ap-notice">Fixture mode — isolated synthetic test data. No real settlement.</p>}
 {message&&<p role="status" className="ap-message">{message}</p>}
 {checking?<p role="status">Checking session…</p>:!session.authenticated?<section className="ap-panel ap-login"><h1>Treasury workspace</h1><h2>Workspace access</h2><p>Use your assigned access code. Reviewers cannot view private invoices or move funds.</p><form onSubmit={login}><label htmlFor="access-code">Access code</label><input id="access-code" type="password" autoComplete="current-password" value={code} onChange={e=>setCode(e.target.value)} required/><button disabled={busy||!session.loginAvailable}>Sign in</button></form></section>
 :session.role==="REVIEWER"?<section className="ap-panel"><h1>Reviewer access</h1><p>Private business records and payment controls are unavailable to this role.</p>{pathname==="/reviewer"?<ReviewerExamples api={api} busy={busy} action={action}/>:<a className="ap-source-link" href="/reviewer">Open isolated reviewer examples</a>}</section>
 :<div key="operator" className="ap-route-content">{children}</div>}</>;
}
