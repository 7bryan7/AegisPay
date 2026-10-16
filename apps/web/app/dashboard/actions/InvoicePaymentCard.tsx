"use client";
import {useCallback,useRef,useState,type FormEvent} from "react";
import Link from "next/link";
import type {InvoiceDetail} from "@agentpay/core";
import {useWorkspace} from "../WorkspaceProvider";
import {Chip,ConfirmDialog,ResourceState,money,useResource} from "../WorkspaceUI";

type ActionKind='approve'|'reject'|'evaluate';
function calendarDate(value:string|null|undefined){if(!value)return 'Unverified';const date=new Date(`${value}T00:00:00Z`);return Number.isNaN(date.getTime())?value:date.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});}
function locked(detail:InvoiceDetail){return ['SUBMITTING','PENDING','UNKNOWN','SETTLED'].includes(detail.payment?.state??'')||['SETTLED','REJECTED'].includes(detail.invoice.status);}
function explanation(detail:InvoiceDetail){
 if(detail.payment?.state==='UNKNOWN')return 'Your approval was recorded, but the payment outcome is unresolved. Funds remain held. Open the invoice payment evidence; another approval or transfer is blocked to prevent duplicate payment.';
 if(detail.payment&&['SUBMITTING','PENDING'].includes(detail.payment.state))return 'Your approval was recorded and payment processing has started. Settlement is not confirmed. Review the existing payment; do not create another transfer.';
 if(detail.invoice.status==='SETTLED')return 'Settlement is recorded. Review the payment evidence in the full invoice.';
 if(detail.invoice.status==='REJECTED')return 'This invoice is rejected. Review its recorded history in the full invoice.';
 if(detail.decision?.reason==='SOFT_THRESHOLD')return 'Payment requires operator approval because it exceeds the automatic payment threshold.';
 return detail.decision?.reason??'No verified decision recorded. Review the invoice evidence before proceeding.';
}
export function InvoicePaymentCard({id,updated}:{id:string;updated:()=>void}){
 const {api,action,busy,notify,message}=useWorkspace();
 const resource=useResource(useCallback(()=>api.detail(id),[api,id]));
 const [confirmation,setConfirmation]=useState<{kind:ActionKind;detail:InvoiceDetail}|null>(null),[reason,setReason]=useState('');
 const commandIds=useRef(new Map<string,string>());
 const detail=resource.data;
 function begin(kind:ActionKind){void action(async()=>{
  // Refresh before presenting a confirmation. The displayed snapshot remains frozen until submit/cancel.
  const current=await api.detail(id);
  if(locked(current)){resource.refresh();notify('This invoice can no longer be changed here. Review its current invoice and payment evidence.');return;}
  if(kind==='approve'&&(!current.approvalOffer||current.decision?.action!=='REQUIRE_APPROVAL'||current.invoice.status!=='OPEN'||['RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED'].includes(current.payment?.state??''))){resource.refresh();notify('No current exact approval offer. Refresh and review the invoice.');return;}
  setReason('');setConfirmation({kind,detail:current});
 });}
 function submit(event:FormEvent){event.preventDefault();if(!confirmation||!reason.trim())return;const snapshot=confirmation;
  void action(async()=>{
   if(snapshot.kind==='approve'){
    const offer=snapshot.detail.approvalOffer;if(!offer)throw Error('Approval offer unavailable');
    await api.approve(id,offer.decisionId,reason,offer);
   }else{
    const fingerprint=JSON.stringify({kind:snapshot.kind,version:snapshot.detail.invoice.version,reason});
    if(!commandIds.current.has(fingerprint))commandIds.current.set(fingerprint,crypto.randomUUID());
    const command={commandId:commandIds.current.get(fingerprint)!,expectedVersion:snapshot.detail.invoice.version,reason};
    if(snapshot.kind==='reject')await api.reject(id,command);else await api.evaluate(id,{...command,reextract:false});
   }
   setConfirmation(null);resource.refresh();updated();
   notify(snapshot.kind==='approve'?'Exact approval recorded. The worker must recheck eligibility before payment.':snapshot.kind==='reject'?'Invoice rejected. Any safe unsubmitted reservation was released.':'Re-evaluation queued for the current evidence. Previous unsubmitted authorization was invalidated.');
  });
 }
 const offer=confirmation?.kind==='approve'?confirmation.detail.approvalOffer:null;
 const canApprove=detail?.invoice.status==='OPEN'&&detail.decision?.action==='REQUIRE_APPROVAL'&&!!detail.approvalOffer&&!locked(detail)&&!['RESERVED','SUBMITTING','PENDING','UNKNOWN','SETTLED'].includes(detail.payment?.state??'');
 const title=confirmation?.kind==='approve'?'Approve exact payment terms':confirmation?.kind==='reject'?'Reject invoice':'Re-evaluate invoice';
 return <section className="ap-panel ac-payment-card" aria-label="Invoice payment actions">
  <ResourceState loading={resource.loading} error={resource.error}/>
  {detail&&<><header><div><h2>{detail.facts?.invoiceNumber??detail.invoice.invoiceNumber??'Invoice number unavailable'}</h2><p>{detail.facts?.vendorName??detail.invoice.vendorName??'Vendor not verified'}</p></div><Chip state={locked(detail)?detail.payment?.state??detail.invoice.status:detail.decision?.action??detail.invoice.status}/></header>
   <div className="ac-payment-facts"><div><span>Invoice amount</span><strong>{money(detail.facts?.amountMicroUsdc??detail.invoice.amountMicroUsdc)}</strong></div><div><span>Due date</span><strong>{calendarDate(detail.facts?.dueDate??detail.invoice.dueDate)}</strong></div></div>
   <p className="ac-payment-explanation"><span aria-hidden="true">ⓘ</span>{explanation(detail)}</p>
   <div className="ac-payment-buttons"><button className="ac-approve" disabled={busy||!canApprove} onClick={()=>begin('approve')}><span aria-hidden="true">✓ </span>Approve exact terms</button><button className="ac-secondary" disabled={busy||locked(detail)} onClick={()=>begin('reject')}><span aria-hidden="true">× </span>Reject</button><button className="ac-secondary" disabled={busy||locked(detail)} onClick={()=>begin('evaluate')}><span aria-hidden="true">↻ </span>Re-evaluate</button></div>
   {!canApprove&&!locked(detail)&&<small>No current exact approval offer. Review the invoice or request re-evaluation.</small>}
   <Link className="ap-source-link" href={`/dashboard/invoices/${id}`}>Open full invoice review →</Link>
  </>}
  {confirmation&&<ConfirmDialog title={title} pending={busy} onClose={()=>setConfirmation(null)}>
   <p>{confirmation.detail.invoice.invoiceNumber??confirmation.detail.invoice.id} · invoice version {confirmation.detail.invoice.version}</p>
   {offer?<><dl className="ap-facts"><dt>Exact payout</dt><dd>{money(offer.terms.amountMicroUsdc)}</dd><dt>Recipient</dt><dd>{offer.terms.recipient}</dd><dt>Network</dt><dd>Arc Testnet · chain {offer.terms.chainId}</dd><dt>Token</dt><dd>{offer.terms.token}</dd><dt>Policy version</dt><dd>{offer.terms.policyVersion}</dd><dt>Vendor address version</dt><dd>{offer.terms.vendorAddressVersion}</dd><dt>PO version</dt><dd>{offer.terms.purchaseOrderVersion}</dd><dt>Expires</dt><dd>{new Date(offer.expiresAt).toLocaleString()}</dd></dl><p>Approval binds these exact terms. It cannot override reserves, hard caps, duplicate checks or verification. Payment submission may follow if eligible.</p></>:<p>{confirmation.kind==='reject'?'This rejects the unsubmitted invoice and releases any safe unsubmitted reservation. It cannot reverse a submitted payment.':'This requests a new evaluation and invalidates previous unsubmitted authorization. The worker will check evidence and policy again; eligible invoices may proceed under the configured payment settings.'}</p>}
   {message&&<p role="alert">{message}</p>}
   <form onSubmit={submit}><label htmlFor="payment-action-reason">Action reason<input id="payment-action-reason" required maxLength={2000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label><button disabled={busy||!reason.trim()}>{confirmation.kind==='approve'?'Confirm exact approval':confirmation.kind==='reject'?'Confirm rejection':'Confirm re-evaluation'}</button></form>
  </ConfirmDialog>}
 </section>;
}
