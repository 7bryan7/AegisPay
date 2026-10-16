"use client";
import {useEffect,useRef,useState,type FormEvent} from "react";
import {useRouter} from "next/navigation";
import {useWorkspace} from "../../WorkspaceProvider";
import {Header} from "../../WorkspaceUI";
export default function Upload(){const {api,action,busy,notify}=useWorkspace(),router=useRouter();const [file,setFile]=useState<File|null>(null),[hint,setHint]=useState(''),[preview,setPreview]=useState('');const key=useRef<string|null>(null);
 useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
 function submit(e:FormEvent){e.preventDefault();if(!file)return;const selected=file;if(!['image/png','image/jpeg'].includes(selected.type)||selected.size>5000000){notify('Choose one PNG or JPEG up to 5 MB.');return;}key.current??=crypto.randomUUID();const requestKey=key.current;void action(async()=>{const result=await api.upload(selected,requestKey,hint);router.push(`/dashboard/invoices/${result.obligationId}`);notify('Image saved. Extraction is asynchronous; no settlement is implied.');});}
 return <><Header title="Upload invoice" description="A PNG or JPEG becomes a stored obligation before any payment can be considered."/><section className="ap-panel"><form onSubmit={submit}><label>Invoice image<input type="file" accept="image/png,image/jpeg" required disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);key.current=null;}}/></label><label>Purchase order reference (optional)<input value={hint} maxLength={500} disabled={busy} onChange={e=>{setHint(e.target.value);key.current=null;}}/></label><p>Up to 5 MB and 20 million pixels. A PO hint cannot replace independent evidence.</p><button disabled={busy||!file}>Save invoice</button></form>{preview&&<img className="ws-image" src={preview} alt="Selected invoice preview"/>}</section></>;
}
