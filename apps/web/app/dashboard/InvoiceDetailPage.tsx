"use client";
import {useCallback,useEffect,useId,useState,type FormEvent,type ReactNode} from "react";
import Link from "next/link";
import type {InvoiceDetail} from "@agentpay/core";
import {useWorkspace} from "./WorkspaceProvider";
import {Chip,ConfirmDialog,ResourceState,money,readable,useResource} from "./WorkspaceUI";
import {InvoiceReviewControls} from "./InvoiceReviewControls";

function Card({title,description,children,id}:{title:string;description?:string;children:ReactNode;id?:string}){
 const headingId=useId();
 return <section className="ap-panel ir-card" id={id} aria-labelledby={headingId}><header className="ir-card-heading"><span className="ir-section-mark" aria-hidden="true">◇</span><div><h2 id={headingId}>{title}</h2>{description&&<p>{description}</p>}</div></header>{children}</section>;
}
function paymentMessage(state:string|null|undefined){
 if(!state)return "No transfer initiated.";
 if(state==="SETTLED")return "Settled with independently verified Arc receipt.";
 if(state==="UNKNOWN")return "Provider outcome unresolved. Funds remain held; do not retry.";
 if(state==="PENDING"||state==="SUBMITTING")return "Provider processing. Settlement is not confirmed yet.";
 return readable(state);
}
function Facts({rows}:{rows:[string,ReactNode][]}){return <dl className="ap-facts ir-facts">{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??"Not recorded"}</dd></div>)}</dl>;}
function PaymentProgress({detail}:{detail:InvoiceDetail}){
 const state=detail.payment?.state;
 // Only mark the current recorded state. A terminal or pending state does not prove every earlier milestone was recorded.
 return <ol className="ir-payment-progress" aria-label="Recorded payment state">{[["RECEIVED","Invoice received"],["RESERVED","Payment reserved"],["SUBMITTING","Submission started"],["PENDING","Provider pending"],["SETTLED","Verified settlement"]].map(([key,label])=><li key={key} data-current={key===state||key==='RECEIVED'&&!state} aria-current={key===state||key==='RECEIVED'&&!state?'step':undefined}><span aria-hidden="true"/><div>{label}<small>{key==='RECEIVED'?new Date(detail.invoice.createdAt).toLocaleString():key===state?'Current recorded state':'See activity for recorded transitions'}</small></div></li>)}</ol>;
}
export function InvoiceDetailPage({id}:{id:string}){
 const {api,action,busy,notify,mode}=useWorkspace();
 const [confirming,setConfirming]=useState(false),[approvalReason,setApprovalReason]=useState("");
 const [showAllActivity,setShowAllActivity]=useState(false);
 const resource=useResource(useCallback(async()=>{
  const detail=await api.detail(id);
  // Secondary failures must not hide the invoice or its evidence.
  const [audit,treasury,policy]=await Promise.allSettled([api.audit(id),api.treasury(),api.policy()]);
  return {detail,audit:audit.status==='fulfilled'?audit.value:null,treasury:treasury.status==='fulfilled'?treasury.value:null,policy:policy.status==='fulfilled'?policy.value:null};
 },[api,id]));
 const detail=resource.data?.detail??null,audit=resource.data?.audit,treasury=resource.data?.treasury,policy=resource.data?.policy;
 useEffect(()=>{if(!detail)return;const processing=['RECEIVED','EXTRACTING'].includes(detail.invoice.status)||['RESERVED','SUBMITTING','PENDING','UNKNOWN'].includes(detail.payment?.state??'');if(!processing)return;const timer=setInterval(resource.refresh,15000);return()=>clearInterval(timer);},[detail,resource.refresh]);
 function exportAudit(){if(!audit)return;const url=URL.createObjectURL(new Blob([JSON.stringify(audit,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`invoice-${id}-activity.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function approveInvoice(event:FormEvent){event.preventDefault();if(!detail?.approvalOffer||!detail.decision)return;const offer=detail.approvalOffer;void action(async()=>{await api.approve(id,offer.decisionId,approvalReason,offer);setConfirming(false);resource.refresh();notify('Exact approval recorded. The worker must recheck eligibility before payment.');});}
 const facts=detail?.facts,decision=detail?.decision,offer=detail?.approvalOffer;
 const discount=decision?.treasury?.discountComparison;
 const orderedEvents=[...(audit?.events??[])].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.key.localeCompare(b.key));
 const visibleEvents=showAllActivity?orderedEvents:orderedEvents.slice(-20);
 return <div className="ir-page">
  <nav className="ir-breadcrumb" aria-label="Breadcrumb"><Link href="/dashboard">Overview</Link><span>/</span><Link href="/dashboard/invoices">Invoices</Link><span>/</span><span aria-current="page">Invoice detail</span></nav>
  <header className="ir-header"><div><div className="ir-title"><h1>Invoice detail</h1>{decision&&<Chip state={decision.action}/>}</div><p>Review invoice evidence, verification results, and make a decision.</p></div><div className="ir-header-actions"><span className="ap-badge">Arc Testnet</span><button className="ir-secondary" onClick={resource.refresh} disabled={resource.loading}><span aria-hidden="true">↻</span> Refresh invoice</button><Link className="ir-back" href="/dashboard/invoices">← Back to inbox</Link></div></header>
  <ResourceState loading={resource.loading} error={resource.error}/>
  {detail&&<>
   <div className="ir-summary" aria-label="Invoice summary">
    {[['Vendor',facts?.vendorName??detail.invoice.vendorName??'Not verified',detail.registry?.vendor?`Registry: ${readable(detail.registry.vendor.status)}`:'No linked registry record'],['Amount',money(facts?.amountMicroUsdc??detail.invoice.amountMicroUsdc),'Total invoice amount'],['Due date',facts?.dueDate??detail.invoice.dueDate??'Not verified','Invoice due date'],['Decision',decision?readable(decision.action):'Not recorded',`Obligation: ${readable(detail.invoice.status)}`],['Payment state',detail.payment?readable(detail.payment.state):'No payment',detail.payment?.settledAt?new Date(detail.payment.settledAt).toLocaleString():'Settlement not confirmed']].map(([label,value,note])=><div className="ir-summary-card" key={label}><span className="ir-summary-label">{label}</span><strong>{value}</strong><small>{note}</small></div>)}
   </div>
   <div className="ir-columns" id="invoice-detail"><div className="ir-evidence-column" aria-label="Invoice review evidence">
    <Card title="Invoice evidence" description="Original source image and recorded upload information.">
     <div className="ir-source"><span className="ir-file-symbol" aria-hidden="true">▧</span><div><strong>Invoice source image</strong><small>{detail.source?.mimeType??'Image metadata unavailable'}{detail.source?.byteSize?` · ${new Intl.NumberFormat().format(detail.source.byteSize)} bytes`:''}</small></div>{detail.source?.retained===false?<span>Source no longer retained</span>:<a className="ap-source-link" href={api.imageUrl(id)} target="_blank" rel="noopener noreferrer">View source image ↗</a>}</div>
     <Facts rows={[["Invoice ID",detail.invoice.id],["Source SHA-256",detail.source?.sha256],["Uploaded by",detail.source?.uploadedBy],["Upload date",new Date(detail.invoice.createdAt).toLocaleString()],["Invoice version",detail.invoice.version]]}/>
     <p>{detail.processingMessage}</p>
     {detail.source?.retained!==false&&<details><summary>Private source image preview</summary><p>Available while the source is retained. Open the authenticated source link if your browser blocks embedding.</p><iframe loading="lazy" title="Private invoice source" src={api.imageUrl(id)} className="ir-source-preview"/></details>}
    </Card>
    <Card title="Extracted & normalized fields" description="Stored invoice facts; missing values are never filled with examples.">
     {facts?<><Facts rows={[["Vendor",facts.vendorName],["Invoice number",facts.invoiceNumber],["Purchase order",facts.purchaseOrderId],["Total amount",money(facts.amountMicroUsdc)],["Currency",facts.currency],["Issue date",facts.issueDate],["Due date",facts.dueDate],["Service period",facts.servicePeriod],["Payment terms",facts.paymentTerms],["Description",facts.serviceDescription]]}/>
     {!!facts.lineItems?.length&&<details><summary>Source line items ({facts.lineItems.length})</summary><div className="ap-table-wrap"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>{facts.lineItems.map((line,index)=><tr key={index}>{(['description','quantity','unitPrice','amount'] as const).map(key=><td key={key}>{line[key].status==='EXTRACTED'?line[key].value:readable(line[key].status)}</td>)}</tr>)}</tbody></table></div></details>}</>:<p>Normalized facts unavailable. Review the original extraction and supply independently supported corrections below.</p>}
    </Card>
    <Card title="Verification results" description="Current registry checks are separate from the historical decision.">
     <div className="ir-checks">
      <details><summary><span>Vendor registry</span><Chip state={detail.registry?.vendor?.status??'UNAVAILABLE'}/></summary>{detail.registry?.vendor?<Facts rows={[["Recipient",detail.registry.vendor.address],["Address version",detail.registry.vendor.addressVersion],["Verification reference",detail.registry.vendor.verificationReference],["Settlement agreement",detail.registry.vendor.settlementAgreementReference],["Verified at",new Date(detail.registry.vendor.verifiedAt).toLocaleString()]]}/>:<p>No linked verified vendor record.</p>}</details>
      <details><summary><span>Purchase order evidence</span><span>{detail.registry?.purchaseOrder?(detail.registry.purchaseOrder.deliveryAccepted?'Acceptance recorded':'Acceptance missing'):'Unavailable'}</span></summary>{detail.registry?.purchaseOrder?<Facts rows={[["PO",detail.registry.purchaseOrder.id],["Version",detail.registry.purchaseOrder.version],["Authorized",money(detail.registry.purchaseOrder.amountMicroUsdc)],["Outstanding",money(detail.registry.purchaseOrder.outstandingMicroUsdc)],["Acceptance reference",detail.registry.purchaseOrder.acceptanceReference]]}/>:<p>No linked accepted purchase order.</p>}</details>
      <details><summary><span>Combined vendor / PO / invoice checks</span><Chip state={detail.verification?.status??'UNAVAILABLE'}/></summary><p>{detail.verification?.status==='VERIFIED'?'Current linked evidence passes the deterministic obligation checks. This does not authorize payment.':detail.verification?.reasons.map(readable).join('; ')||'Current verification results unavailable.'}</p></details>
      <details><summary><span>Similar-invoice review</span><span>{decision?.similarInvoiceIds?.length?`${decision.similarInvoiceIds.length} references`:'No references recorded'}</span></summary><p>Absence of similar references is not proof that an invoice is unique. Duplicate guards are checked again before dispatch.</p>{decision?.similarInvoiceIds?.map(ref=><Link className="ap-source-link" key={ref} href={`/dashboard/invoices/${ref}`}>{ref}</Link>)}</details>
      <details><summary><span>Treasury evaluation</span><Chip state={decision?.action}/></summary><p>{decision?.reason??'No treasury decision recorded.'}</p>{decision?.treasury?.snapshot&&<Facts rows={[["Snapshot time",new Date(decision.treasury.snapshot.capturedAt).toLocaleString()],["Spendable at evaluation",money(decision.treasury.availableMicroUsdc)],["Protected obligations",money(decision.treasury.snapshot.protectedObligationsMicroUsdc)],["Daily headroom",money(decision.treasury.dailyHeadroomMicroUsdc)],["Category headroom",money(decision.treasury.categoryHeadroomMicroUsdc)],["Fee allowance",money(decision.treasury.snapshot.feeAllowanceMicroUsdc)],["Arc block",decision.treasury.cash?.blockNumber]]}/>}<p>Historical snapshot. Dispatch requires fresh evidence.</p></details>
     </div>
    </Card>
    <Card title="Decision explanation" description="Recorded reasoning and supporting evidence.">
     <div className="ir-decision" data-state={decision?.action}><strong>{decision?readable(decision.action):'Awaiting evaluation'}</strong><p>{decision?.reason??'No verified decision yet.'}</p></div>
     {decision&&<><h3>Evidence references</h3>{decision.evidenceIds.length?<ul className="ir-reference-list">{decision.evidenceIds.map((ref,i)=><li key={`${ref}:${i}`}>{ref}</li>)}</ul>:<p>No citations recorded.</p>}
     {decision.alternativeConsidered&&<><h3>Alternative considered</h3><p>{decision.alternativeConsidered}</p></>}
     <small>Evaluated {new Date(decision.evaluatedAt).toLocaleString()}{decision.versions?` · invoice version ${decision.versions.invoice} · policy version ${decision.versions.policy}`:''}</small></>}
     {decision?.nextEvaluationAt&&<p>Next evaluation: {new Date(decision.nextEvaluationAt).toLocaleString()}. Funding is checked again before dispatch.</p>}
     {discount&&<div className="ap-notice"><strong>Verified early-payment discount</strong><span>Nominal {money(discount.nominalAmountMicroUsdc)} · adjustment {money(discount.discountAdjustmentMicroUsdc)} · payout {money(discount.payoutAmountMicroUsdc)}.</span><span>Cash-preservation cost {money(discount.cashPreservationCostMicroUsdc)} at {decision?.treasury?.annualCashPreservationCostBps??0} annual basis points; expires {new Date(discount.expiry).toLocaleString()}.</span></div>}
    </Card>
    <Card title="Correction / Re-evaluation" description="Record independent evidence and request a new evaluation." id="invoice-corrections">
     <InvoiceReviewControls key={`${id}:${detail.invoice.version}`} api={api} detail={detail} busy={busy} action={action} updated={message=>{resource.refresh();notify(message);return Promise.resolve();}}/>
    </Card>
    <Card title="Activity timeline" description="Recorded events for this invoice, including versioned updates.">
     {!audit?<p role="status">Activity unavailable. Refresh to retry; export is disabled.</p>:<><ol className="ir-timeline">{visibleEvents.map(event=><li key={event.key}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><div><strong>{readable(event.type)}</strong><small>Version {event.version}{event.actorId?` · ${event.actorId}`:''}</small>{event.reason&&<p>{event.reason}</p>}</div></li>)}</ol>{orderedEvents.length>20&&<><p>Showing {visibleEvents.length} of {orderedEvents.length} loaded events in chronological order.</p><button className="ir-secondary" onClick={()=>setShowAllActivity(!showAllActivity)}>{showAllActivity?'Show fewer events':`Show all ${orderedEvents.length} loaded events`}</button></>}{!audit.events.length&&<p>No events recorded.</p>}{audit.truncated&&<p>Only the first 500 records per section are included.</p>}</>}
    </Card>
   </div><aside className="ir-decision-column" aria-label="Decision and payment controls">
    <Card title="Current decision"><Chip state={decision?.action}/><p>{decision?.reason??'No verified decision recorded.'}</p><div className="ir-next"><strong>Next step</strong><p>{offer?'Review evidence and approve exact terms if appropriate.':detail.payment&&['PENDING','UNKNOWN','SUBMITTING'].includes(detail.payment.state)?'Monitor or reconcile the existing payment. Do not create a new transfer.':detail.invoice.status==='SETTLED'?'Review the verified settlement and audit record.':detail.invoice.status==='REJECTED'?'Invoice rejected. Review the recorded reason.':'Review the evidence and resolve the recorded issues before re-evaluation.'}</p></div></Card>
    <Card title="Operator actions">
     {decision?.action==='REQUIRE_APPROVAL'&&offer?<form onSubmit={event=>{event.preventDefault();setConfirming(true);}} className="ir-approval"><label htmlFor="approval-reason">Operator approval rationale<input id="approval-reason" value={approvalReason} maxLength={500} disabled={busy} onChange={e=>setApprovalReason(e.target.value)} required/></label><button disabled={busy||!approvalReason.trim()} type="submit">Approve invoice</button><small>Exact terms only. Payment submission may follow if eligible.</small></form>:<p>No exact approval offer available.</p>}
     <a className="ir-action-link" href="#invoice-corrections">Review, reject or re-evaluate ↓</a><button className="ir-secondary" onClick={exportAudit} disabled={!audit}>Export activity</button>
    </Card>
    <Card title="Payment status"><Chip state={detail.payment?.state??'NO_PAYMENT'}/><p>{(treasury?.configuredMode??mode)==='fixture'&&detail.payment?.state==='SETTLED'?'Synthetic settlement fixture. No real transfer occurred.':detail.payment?.state==='SETTLED'&&(treasury?.configuredMode??mode)!=='arc_testnet'?'Settlement state recorded. Network mode unavailable; inspect the payment evidence.':paymentMessage(detail.payment?.state)}</p><PaymentProgress detail={detail}/>
     {detail.payment&&<details><summary>Payment evidence</summary><Facts rows={[["Circle ID",detail.payment.providerId],["Provider state",detail.payment.providerState],["Submission stage",detail.payment.submissionIssue?.stage],["HTTP status",detail.payment.submissionIssue?.httpStatus],["Provider error code",detail.payment.submissionIssue?.providerCode],["Submission correlation ID",detail.payment.submissionIssue?.requestId],["Transaction reference",detail.payment.transactionHash],["Verification",detail.payment.verificationReference],["Nominal",money(detail.payment.nominalAmountMicroUsdc)],["Discount",money(detail.payment.discountAdjustmentMicroUsdc)],["Payout",money(detail.payment.payoutAmountMicroUsdc)],["Verified network fee",money(detail.payment.actualFeeMicroUsdc)],["Settled at",detail.payment.settledAt]]}/><p>A transaction hash alone does not prove settlement.</p></details>}
     {treasury?.configuredMode==='arc_testnet'&&detail.payment?.state==='SETTLED'&&detail.payment.verificationReference&&/^0x[0-9a-fA-F]{64}$/.test(detail.payment.transactionHash??'')&&<a className="ap-source-link" href={`https://explorer.testnet.arc.io/tx/${detail.payment.transactionHash}`} target="_blank" rel="noopener noreferrer">View verified Arc settlement ↗</a>}
    </Card>
    <Card title="Treasury impact">{treasury?<><Facts rows={[["Current spendable",money(treasury.overview?.spendableMicroUsdc)],["Minimum reserve",money(treasury.minimumReserveMicroUsdc)],["Candidate payout",money(decision?.candidate?.amountMicroUsdc)],["Fee allowance at evaluation",money(decision?.treasury?.snapshot?.feeAllowanceMicroUsdc)],["Treasury",treasury.paused?'Paused':'Resumed'],["Dispatch",treasury.dispatchEnabled?'Enabled':'Disabled']]}/><p>{treasury.overview?.status==='UNAVAILABLE'?treasury.overview.reason:'Fresh cash, fee, budget and policy checks are required before dispatch.'}</p></>:<p>Treasury information unavailable. Refresh to retry.</p>}</Card>
    <Card title="Approval scope"><Facts rows={[["Current policy version",policy?.version],["Automatic threshold",money(policy?.policy.autoPayMaxMicroUsdc)],["Hard transaction limit",money(policy?.policy.hardTxMaxMicroUsdc)],["Scope",'This invoice and exact payment terms only']]}/>{offer?<><Facts rows={[["Approval policy version",offer.terms.policyVersion],["Invoice version",offer.expectedVersion],["Exact amount",money(offer.terms.amountMicroUsdc)],["Recipient",offer.terms.recipient],["Expires",new Date(offer.expiresAt).toLocaleString()]]}/><p>Approval cannot bypass hard limits, reserves or duplicate checks.</p></>:<p>{policy?'No current exact approval offer.':'Current policy unavailable. Refresh to retry.'}</p>}<Link className="ap-source-link" href="/dashboard/treasury">View treasury policy ↗</Link></Card>
   </aside></div>
  </>}
  {confirming&&offer&&<ConfirmDialog title="Confirm exact payment approval" onClose={()=>setConfirming(false)}><p className="ap-wrap">Approve {money(offer.terms.amountMicroUsdc)} to {offer.terms.recipient} on Arc Testnet. Token {offer.terms.token}. Invoice version {offer.expectedVersion}; policy version {offer.terms.policyVersion}; vendor address version {offer.terms.vendorAddressVersion}; PO version {offer.terms.purchaseOrderVersion}. Expires {new Date(offer.expiresAt).toLocaleString()}.</p><p>Approval does not override cash reserves, hard caps, duplicate checks or verification. Payment submission may follow if eligible.</p><form onSubmit={approveInvoice}><button disabled={busy||!approvalReason.trim()}>Confirm approval</button></form></ConfirmDialog>}
 </div>;
}
