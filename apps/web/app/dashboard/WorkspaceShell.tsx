"use client";
import {useEffect,useRef,useState,type ReactNode} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {WorkspaceProvider,WorkspaceGate,useWorkspace} from "./WorkspaceProvider";
const items=[['/dashboard','Overview'],['/dashboard/invoices','Invoices'],['/dashboard/actions','Action Center'],['/dashboard/payments','Payments'],['/dashboard/treasury','Treasury'],['/dashboard/records','Business Records'],['/dashboard/activity','Activity and Audit']];
export function WorkspaceShell({children}:{children:ReactNode}){return <WorkspaceProvider><WorkspaceFrame>{children}</WorkspaceFrame></WorkspaceProvider>;}
function WorkspaceFrame({children}:{children:ReactNode}){
 const {session}=useWorkspace();
 const navigation=session.authenticated?(session.role==="OPERATOR"?items:[["/reviewer","Reviewer examples"]]):[["/dashboard","Workspace access"]];
 const [mobile,setMobile]=useState(false);
 useEffect(()=>{const media=window.matchMedia("(max-width:1000px)");const update=()=>{setMobile(media.matches);if(!media.matches)setOpen(false);};update();media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
 const path=usePathname(),[open,setOpen]=useState(false),toggle=useRef<HTMLButtonElement>(null),drawer=useRef<HTMLElement>(null);
 useEffect(()=>{if(!open)return;const first=drawer.current?.querySelector<HTMLAnchorElement>('a');first?.focus();function close(e:KeyboardEvent){if(e.key==='Escape'){setOpen(false);toggle.current?.focus();}if(e.key==='Tab'){const links=drawer.current?.querySelectorAll<HTMLAnchorElement>('a');if(!links?.length)return;const start=links[0],last=links[links.length-1];if(e.shiftKey&&document.activeElement===start){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();start?.focus();}}}document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close);},[open]);
 return <div className={`dash-shell ws-shell ${open?'ws-nav-open':''}`}>
  <button ref={toggle} className="ws-menu" aria-expanded={open} aria-controls="workspace-nav" onClick={()=>setOpen(!open)}>Menu</button>
  {open&&<button className="ws-scrim" aria-label="Close navigation" onClick={()=>setOpen(false)}/>}
  <aside id="workspace-nav" inert={mobile&&!open} aria-hidden={mobile&&!open?true:undefined} ref={drawer} className="dash-sidebar"><video className="dash-sidebar-video" src="/videos/sidebar-bg.mp4" autoPlay muted loop playsInline aria-hidden="true" tabIndex={-1}/><div className="dash-sidebar-overlay" aria-hidden="true"/><Link href="/" className="dash-brand"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M23.8588 4.80005L40.8 14.4V33.8824L23.8588 43.2001L7.20001 33.8824V14.4L23.8588 4.80005ZM12.847 17.7883L23.8587 11.2942L34.8705 17.7883L29.7882 20.8942L23.8587 17.2236L18.494 20.8942V33.8825L12.847 30.4942V17.7883Z" fill="currentColor"/></svg><span>AgentPay</span></Link>
   <nav className="dash-nav" aria-label="Workspace"><p className="dash-nav-label">ACCOUNTS PAYABLE</p>{navigation.map(([href,label])=><Link key={href} href={href!} onClick={()=>setOpen(false)} aria-current={(href==='/dashboard'?path===href:path.startsWith(href!))?'page':undefined} className={`dash-nav-link ${(href==='/dashboard'?path===href:path.startsWith(href!))?'active':''}`}><span>{label}</span></Link>)}</nav>
   <div className="dash-sidebar-foot">{session.authenticated&&session.role==="OPERATOR"&&<Link href="/dashboard/settings" onClick={()=>setOpen(false)}>Settings and Status</Link>}<Link href="/reviewer" onClick={()=>setOpen(false)}>Reviewer access</Link><span>Arc Testnet · USDC</span></div>
  </aside>
  <div className="dash-main"><video className="dash-main-video" src="/videos/sidebar-bg.mp4" autoPlay muted loop playsInline aria-hidden="true" tabIndex={-1}/><div className="dash-main-overlay" aria-hidden="true"/><main className="dash-content"><div className="ap-workspace"><WorkspaceGate>{children}</WorkspaceGate></div></main></div>
 </div>;
}
