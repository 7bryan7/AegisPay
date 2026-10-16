"use client";
import {useCallback,useState,type FormEvent} from "react";
import Link from "next/link";
import {useWorkspace} from "./WorkspaceProvider";
import {Header,InvoiceTable,Pager,ResourceState,useResource} from "./WorkspaceUI";
export function InvoiceInbox({actions=false}:{actions?:boolean}){
 const {api}=useWorkspace();const [offset,setOffset]=useState(0),[search,setSearch]=useState(''),[q,setQ]=useState(''),[decision,setDecision]=useState(actions?'REQUIRE_APPROVAL':'');
 const records=useResource(useCallback(()=>api.invoices(new URLSearchParams({offset:String(offset),q,...(decision?{decision}:{})}).toString()),[api,offset,q,decision]));
 function submit(e:FormEvent){e.preventDefault();setQ(search);setOffset(0);}
 return <><Header title={actions?'Action Center':'Invoices'} description="Search and decision filters are applied by the server across this business." action={<Link className="ws-button" href="/dashboard/invoices/new">Upload invoice</Link>}/>
 {actions&&<div className="ws-tabs" aria-label="Action queues">{[['REQUIRE_APPROVAL','Awaiting approval'],['HOLD','On hold'],['SCHEDULE','Scheduled'],['REJECT','Rejected']].map(([value,label])=><button key={value} aria-pressed={decision===value} onClick={()=>{setDecision(value!);setOffset(0);}}>{label}</button>)}</div>}
 <section className="ap-panel"><form className="ws-filter" onSubmit={submit}><label>Search invoice or vendor<input value={search} maxLength={120} onChange={e=>setSearch(e.target.value)}/></label><label>Decision filter<select value={decision} onChange={e=>{setDecision(e.target.value);setOffset(0);}}><option value="">All decisions</option>{['REQUIRE_APPROVAL','HOLD','SCHEDULE','REJECT','PAY_NOW'].map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label><button>Apply search</button><button type="button" onClick={records.refresh}>Refresh</button></form>
 <ResourceState loading={records.loading} error={records.error} empty={records.data?.invoices.length===0}/>{records.data&&<><p>{records.data.total} matching stored invoices.</p><InvoiceTable invoices={records.data.invoices}/>{actions&&<ul className="ws-evidence">{records.data.invoices.map(i=><li key={i.id}><Link className="ap-source-link" href={`/dashboard/invoices/${i.id}`}>{i.invoiceNumber??i.id}</Link><p>{i.reason??'No decision reason recorded.'}</p>{i.nextEvaluationAt&&<small>Next evaluation: {new Date(i.nextEvaluationAt).toLocaleString()}. Future funding is rechecked.</small>}</li>)}</ul>}<Pager offset={offset} next={records.data.nextOffset} onChange={setOffset}/></>}</section></>;
}
