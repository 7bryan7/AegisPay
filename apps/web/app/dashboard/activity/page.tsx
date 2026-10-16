"use client";
import {useCallback,useState,type FormEvent} from "react";
import {useWorkspace} from "../WorkspaceProvider";
import {Events,Header,Pager,ResourceState,useResource} from "../WorkspaceUI";
export default function Activity(){const {api}=useWorkspace();const [offset,setOffset]=useState(0),[input,setInput]=useState(''),[invoiceId,setInvoiceId]=useState('');const result=useResource(useCallback(()=>api.activity(new URLSearchParams({offset:String(offset),...(invoiceId?{invoiceId}:{})}).toString()),[api,offset,invoiceId]));function filter(e:FormEvent){e.preventDefault();setInvoiceId(input.trim());setOffset(0);}
 return <><Header title="Activity and Audit" description="Business scoped events from the database. Open an invoice for its private evidence and JSON export."/><section className="ap-panel"><form className="ws-filter" onSubmit={filter}><label>Invoice ID filter (optional)<input value={input} maxLength={36} onChange={e=>setInput(e.target.value)}/></label><button>Apply filter</button><button type="button" onClick={result.refresh}>Refresh activity</button></form><ResourceState loading={result.loading} error={result.error} empty={result.data?.events.length===0}/>{result.data&&<><Events events={result.data.events}/><Pager offset={offset} next={result.data.nextOffset} onChange={setOffset}/></>}</section></>;
}
