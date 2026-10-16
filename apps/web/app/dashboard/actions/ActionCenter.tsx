"use client";
import {useCallback,useState} from "react";
import Link from "next/link";
import type {WorkspaceQuery} from "@agentpay/core";
import {InvoicePaymentCard} from "./InvoicePaymentCard";
import {useWorkspace} from "../WorkspaceProvider";
import {Chip,Pager,ResourceState,money,readable,useResource} from "../WorkspaceUI";

type Queue="REQUIRE_APPROVAL"|"HOLD"|"SCHEDULE"|"REJECT"|"ALL";
const queues=[
 {value:"REQUIRE_APPROVAL",label:"Awaiting approval",note:"Requires your review",icon:"document"},
 {value:"HOLD",label:"On hold",note:"Resolve recorded issues",icon:"pause"},
 {value:"SCHEDULE",label:"Scheduled",note:"Funding rechecked when due",icon:"calendar"},
 {value:"REJECT",label:"Rejected",note:"Closed invoices",icon:"reject"},
 {value:"ALL",label:"All open actions",note:"Across open queues",icon:"list"}
] as const;
function Icon({name}:{name:string}){
 const paths:Record<string,React.ReactNode>={document:<><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>,pause:<><circle cx="12" cy="12" r="9"/><path d="M10 8v8M14 8v8"/></>,calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3v3H7z"/></>,reject:<><circle cx="12" cy="12" r="9"/><path d="m8 8 8 8M16 8l-8 8"/></>,list:<><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/></>,bolt:<path d="m14 2-9 12h7l-2 8 9-12h-7z"/>};
 return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.document}</svg>;
}
function guidance(reason:string|null,decision:string|null,payment:string|null){
 if(payment==='UNKNOWN')return 'Payment outcome is unresolved after submission. Funds remain held and further approvals are blocked. Open the invoice payment evidence to investigate the existing attempt.';
 if(payment==='SUBMITTING'||payment==='PENDING')return 'The existing payment is processing. Settlement is not confirmed. Monitor its payment evidence; do not approve or send again.';
 if(payment==='SETTLED')return 'Settlement is recorded. Review the verified payment evidence and audit record.';
 if(reason==='SOFT_THRESHOLD')return 'This invoice exceeds the configured automatic approval threshold and requires exact operator approval. Approval cannot bypass hard limits, reserves or duplicate checks.';
 if(reason)return reason;
 if(decision==='SCHEDULE')return 'Review the recorded schedule in the invoice. Funding and eligibility are checked again before dispatch.';
 return 'No decision reason recorded. Open the invoice to inspect the available evidence and current state.';
}
export function ActionCenter(){
 const {api}=useWorkspace();
 const [activeQueue,setQueue]=useState<Queue>('REQUIRE_APPROVAL');
 const [sort,setSort]=useState<NonNullable<WorkspaceQuery['sort']>>('due_asc'),[offset,setOffset]=useState(0),[selectedId,setSelectedId]=useState<string|null>(null);
 const summary=useResource(useCallback(()=>api.summary(),[api]));
 const records=useResource(useCallback(()=>api.invoices(new URLSearchParams({offset:String(offset),q:'',sort,queue:activeQueue==='REJECT'?'rejected':'open_actions',...(activeQueue!=='ALL'&&activeQueue!=='REJECT'?{decision:activeQueue}:{})}).toString()),[api,offset,activeQueue,sort]));
 const counts=summary.data?.counts;
 const totals=counts?{REQUIRE_APPROVAL:counts.approvals,HOLD:counts.held,SCHEDULE:counts.scheduled,REJECT:counts.rejected,ALL:counts.approvals+counts.held+counts.scheduled}:null;
 const selected=records.data?.invoices.find(i=>i.id===selectedId)??records.data?.invoices[0];
 function changeQueue(value:Queue){setQueue(value);setOffset(0);setSelectedId(null);}
 function refresh(){summary.refresh();records.refresh();}
 return <div className="ac-page">
  <header className="ac-header"><div><p className="ap-eyebrow">ACCOUNTS PAYABLE</p><h1>Action Center</h1><p>Choose a decision queue, review an invoice, and proceed with its eligible payment actions.</p></div><Link href="/dashboard/invoices/new" className="ac-upload">↑ Upload invoice</Link></header>
  <div className="ac-queues" aria-label="Action queues">{queues.map(queue=><button key={queue.value} className="ac-queue" data-queue={queue.value} aria-label={`${queue.label} queue`} aria-pressed={activeQueue===queue.value} onClick={()=>changeQueue(queue.value)}><span className="ac-queue-icon"><Icon name={queue.icon}/></span><span><strong>{totals?totals[queue.value]:summary.loading?'…':'Unavailable'}</strong><span>{queue.label}</span><small>{queue.note}</small></span></button>)}</div>
  {summary.error&&<p role="alert">Queue totals unavailable. Refresh to retry.</p>}
  <section className="ap-panel ac-results" aria-labelledby="ac-results-title"><header className="ac-panel-heading"><Icon name="document"/><div><h2 id="ac-results-title">{records.data?`${records.data.total} matching invoice${records.data.total===1?'':'s'}`:'Invoice results'}</h2><p>Showing stored invoices in the selected decision queue.</p></div><button className="ac-secondary" onClick={refresh}>Refresh</button><div className="ac-sort"><label htmlFor="action-sort">Sort by</label><select id="action-sort" value={sort} onChange={e=>{setSort(e.target.value as NonNullable<WorkspaceQuery['sort']>);setOffset(0);setSelectedId(null);}}><option value="due_asc">Due date (oldest first)</option><option value="due_desc">Due date (newest first)</option><option value="amount_desc">Amount (highest first)</option><option value="amount_asc">Amount (lowest first)</option><option value="created_desc">Most recently received</option></select></div></header>
   <ResourceState loading={records.loading} error={records.error}/>
   {records.data&&<>{records.data.invoices.length?<div className="ap-table-wrap"><table className="ac-table"><thead><tr><th><span className="ac-sr-only">Select one invoice</span></th><th>Invoice and vendor</th><th>Amount</th><th>Due date</th><th>Obligation</th><th>Decision</th><th>Payment</th><th>Review</th></tr></thead><tbody>{records.data.invoices.map(invoice=><tr key={invoice.id} data-selected={selected?.id===invoice.id}><td><input type="radio" name="selected-action-invoice" aria-label={`Select invoice ${invoice.invoiceNumber??invoice.id}`} checked={selected?.id===invoice.id} onChange={()=>setSelectedId(invoice.id)}/></td><td><strong>{invoice.invoiceNumber??'Invoice number unavailable'}</strong><small>{invoice.vendorName??'Vendor not verified'}</small></td><td>{money(invoice.amountMicroUsdc)}</td><td>{invoice.dueDate??'Unverified'}</td><td><Chip state={invoice.status}/></td><td><Chip state={invoice.decision}/></td><td>{invoice.paymentState?<Chip state={invoice.paymentState}/>:'No payment'}</td><td><Link className="ap-source-link" href={`/dashboard/invoices/${invoice.id}`}>View invoice →</Link></td></tr>)}</tbody></table></div>:<div className="ac-empty"><Icon name="list"/><h3>No matching invoices</h3><p>Choose another queue. No sample records are substituted.</p></div>}
   {(offset>0||records.data.nextOffset!==null)&&<Pager offset={offset} next={records.data.nextOffset} onChange={value=>{setOffset(value);setSelectedId(null);}}/>}</>}
  </section>
  {selected&&<div className="ac-review"><InvoicePaymentCard key={selected.id} id={selected.id} updated={refresh}/>
   <section className="ap-panel ac-guidance" aria-labelledby="ac-guidance-title"><header className="ac-panel-heading"><Icon name="bolt"/><div><h2 id="ac-guidance-title">Review guidance</h2><p>Why this invoice needs your attention.</p></div></header><div className="ac-guidance-message" data-decision={selected.decision}><strong>{selected.paymentState==='UNKNOWN'?'Payment unresolved':selected.paymentState==='PENDING'||selected.paymentState==='SUBMITTING'?'Payment processing':selected.paymentState==='SETTLED'?'Payment settled':selected.reason==='SOFT_THRESHOLD'?'Automatic approval threshold':selected.status==='REJECTED'?'Invoice rejected':selected.decision?readable(selected.decision):'Decision unavailable'}</strong><p>{guidance(selected.reason,selected.decision,selected.paymentState)}</p></div></section></div>}
  <p className="ac-caption">Queue totals cover this business. Rejected invoices are closed and excluded from all open actions. Actions require current eligibility, a reason and confirmation of the selected invoice.</p>
 </div>;
}
