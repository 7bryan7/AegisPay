"use client";
import {useCallback} from "react";
import Link from "next/link";
import {useWorkspace} from "./WorkspaceProvider";
import {Chip,Events,Header,ResourceState,money,useResource} from "./WorkspaceUI";
export default function Overview(){
 const {api}=useWorkspace();const summary=useResource(useCallback(()=>api.summary(),[api]));const treasury=useResource(useCallback(()=>api.treasury(),[api]));
 return <><Header title="Overview" description="Current business records and treasury evidence." action={<Link className="ws-button" href="/dashboard/invoices/new">Upload invoice</Link>}/>
 <div className="ap-toolbar"><span>Arc Testnet · Owner maintained registry screening</span><button onClick={()=>{summary.refresh();treasury.refresh();}}>Refresh overview</button></div>
 <ResourceState loading={summary.loading||treasury.loading} error={summary.error||treasury.error}/>
 {summary.data&&<p>All-invoice counts as of {new Date(summary.data.capturedAt).toLocaleString()}. Stored synthetic records remain test records, not business traction.</p>}
 <div className="ap-metrics"><div><span>Verified USDC cash</span><strong>{money(treasury.data?.cashMicroUsdc)}</strong></div><div><span>Spendable before a new transfer fee</span><strong>{money(treasury.data?.overview?.spendableMicroUsdc)}</strong></div><div><span>Active payout and fee holds</span><strong>{money(treasury.data?.holdsMicroUsdc)}</strong></div></div>
 {summary.data&&<><div className="ap-metrics"><div><span>Awaiting approval</span><strong>{summary.data.counts.approvals}</strong></div><div><span>On hold</span><strong>{summary.data.counts.held}</strong></div><div><span>Scheduled</span><strong>{summary.data.counts.scheduled}</strong></div></div>
 <div className="ws-grid"><section className="ap-panel"><h2>Action queue</h2>{summary.data.actionQueue.length?<ul className="ws-evidence">{summary.data.actionQueue.map(i=><li key={i.id}><Link className="ap-source-link" href={`/dashboard/invoices/${i.id}`}>{i.invoiceNumber??i.id}</Link><p><Chip state={i.decision}/> · {money(i.amountMicroUsdc)}</p><small>{i.reason??'No reason recorded.'}</small></li>)}</ul>:<p>No stored invoices in the approval, hold or scheduled queues.</p>}<Link className="ap-source-link" href="/dashboard/actions">Open Action Center</Link></section>
 <section className="ap-panel"><h2>Recent invoices</h2>{summary.data.recentInvoices.length?<ul className="ws-evidence">{summary.data.recentInvoices.map(i=><li key={i.id}><Link className="ap-source-link" href={`/dashboard/invoices/${i.id}`}>{i.invoiceNumber??(['RECEIVED','EXTRACTING'].includes(i.status)?'Awaiting extraction':'Invoice number unavailable')}</Link><p>{i.vendorName??'Vendor not verified'} · {money(i.amountMicroUsdc)}</p><p>Obligation <Chip state={i.status}/> · Decision <Chip state={i.decision}/></p></li>)}</ul>:<p>No invoices stored.</p>}<Link className="ap-source-link" href="/dashboard/invoices">Open complete inbox</Link></section></div>
 <section className="ap-panel"><h2>Recent activity</h2><Events events={summary.data.recentActivity}/><Link className="ap-source-link" href="/dashboard/activity">Open activity and audit</Link></section></>}
 {treasury.data&&<section className="ap-panel"><h2>Treasury status</h2><p>{treasury.data.configuredMode} · {treasury.data.paused?'Paused':'Resumed'} · dispatch {treasury.data.dispatchEnabled?'enabled':'disabled'}</p><p>{treasury.data.message}</p><p>{treasury.data.overview?.reason??'Snapshot evidence is shown in Treasury.'}</p><Link href="/dashboard/treasury" className="ap-source-link">Inspect treasury and policies</Link></section>}</>;
}
