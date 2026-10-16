"use client";
import Link from "next/link";
import {useCallback,useEffect,useRef,useState,type ReactNode} from "react";
import {microUsdcToUsdc,type InvoiceSummary,type ActivityList} from "@agentpay/core";
import {PayablesApiError} from "../../lib/payables";
import {useWorkspace} from "./WorkspaceProvider";
export const readable=(value:string)=>value.replaceAll('_',' ').toLowerCase();
export const money=(value:string|null|undefined)=>value==null?'Unavailable':`${microUsdcToUsdc(BigInt(value))} USDC`;
export function Chip({state}:{state:string|null|undefined}) {return <span className="ws-chip" data-state={state??''}>{state?readable(state):'Not recorded'}</span>;}
export function Header({title,description,action}:{title:string;description?:string;action?:ReactNode}){return <header className="ws-header"><div><p className="ap-eyebrow">ACCOUNTS PAYABLE</p><h1>{title}</h1>{description&&<p>{description}</p>}</div>{action??<span className="ap-badge">Arc Testnet</span>}</header>;}
export function useResource<T>(load:()=>Promise<T>){
 const {expire}=useWorkspace();
 const [generation,setGeneration]=useState(0),[state,setState]=useState<{load:typeof load;data:T|null;error:string;loading:boolean}|null>(null);
 useEffect(()=>{let active=true;setState({load,data:null,error:'',loading:true});void load().then(data=>{if(active)setState({load,data,error:'',loading:false});}).catch((e:unknown)=>{if(active){setState({load,data:null,error:e instanceof PayablesApiError?`${e.message}${e.code?` (${e.code})`:''}`:'Data unavailable. Refresh to retry.',loading:false});if(e instanceof PayablesApiError&&e.status===401)expire();}});return()=>{active=false;};},[load,generation,expire]);
 const refresh=useCallback(()=>setGeneration(g=>g+1),[]);
 return {data:state?.load===load?state.data:null,error:state?.load===load?state.error:'',loading:state?.load===load?state.loading:true,refresh};
}
export function ResourceState({loading,error,empty}:{loading:boolean;error:string;empty?:boolean}){return loading?<p aria-live="polite">Loading current records…</p>:error?<p role="alert">{error}</p>:empty?<p>No matching records. Nothing is being substituted for missing data.</p>:null;}
export function InvoiceTable({invoices}:{invoices:InvoiceSummary[]}) {return <div className="ap-table-wrap"><table><thead><tr><th>Invoice and vendor</th><th>Amount</th><th>Due date</th><th>Obligation</th><th>Decision</th><th>Payment</th><th>Review</th></tr></thead><tbody>{invoices.map(i=><tr key={i.id}><td>{i.invoiceNumber??(['RECEIVED','EXTRACTING'].includes(i.status)?'Awaiting extraction':'Invoice number unavailable')}<small>{i.vendorName??'Vendor not verified'}</small></td><td>{money(i.amountMicroUsdc)}</td><td>{i.dueDate??'Unverified'}</td><td><Chip state={i.status}/></td><td><Chip state={i.decision}/></td><td>{i.paymentState?<Chip state={i.paymentState}/>:'No payment'}</td><td><Link className="ap-source-link" href={`/dashboard/invoices/${i.id}`}>View invoice</Link></td></tr>)}</tbody></table></div>;}
export function Events({events}:{events:ActivityList['events']}){return <ol className="ap-activity">{events.map(e=><li key={e.key}><div><strong>{readable(e.type)}</strong><small>{e.actorId} · version {e.version}</small>{e.reason&&<p>{e.reason}</p>}{e.invoiceId&&<Link className="ap-source-link" href={`/dashboard/invoices/${e.invoiceId}`}>Open invoice</Link>}</div><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time></li>)}</ol>;}
export function Pager({offset,next,onChange}:{offset:number;next:number|null;onChange:(offset:number)=>void}){return <div className="ap-pagination"><button disabled={offset===0} onClick={()=>onChange(Math.max(0,offset-25))}>Previous</button><span>Records {offset+1} onward</span><button disabled={next===null} onClick={()=>onChange(next!)}>Next</button></div>;}
export function ConfirmDialog({title,children,onClose,pending=false}:{title:string;children:ReactNode;onClose:()=>void;pending?:boolean}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close();},[]);
 return <dialog ref={dialog} className="ws-confirm" aria-label={title} onCancel={event=>{event.preventDefault();if(!pending)onClose();}}><section className="ap-panel"><h2>{title}</h2>{children}<button type="button" disabled={pending} onClick={onClose}>Close</button></section></dialog>;
}
