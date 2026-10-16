import {randomUUID} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {createWorkspaceReads} from "../apps/server/src/ap/workspace.js";
const connection=process.env.AP_TEST_DATABASE_URL;
if(!connection||connection===process.env.DATABASE_URL)throw new Error("Dedicated test database required");
const schema=`workspace_${randomUUID().replaceAll('-','')}`;
const admin=new Pool({connectionString:connection,max:1});const pool=new Pool({connectionString:connection,max:2,options:`-c search_path=${schema} -c statement_timeout=10000`});
const reads=createWorkspaceReads(pool),business=randomUUID(),other=randomUUID();const ids:string[]=[];
beforeAll(async()=>{
 await admin.query(`CREATE SCHEMA ${schema}`);
 for(const filename of(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await pool.query(await readFile(`migrations/${filename}`,'utf8'));
 for(const [i,id] of[business,other].entries())await pool.query("INSERT INTO ap_treasuries(business_id,wallet_id,wallet_address,chain_id,token_address,policy) VALUES($1,$1,$2,5042002,'0x3600000000000000000000000000000000000000','{}')",[id,`0x${String(i+1).repeat(40)}`]);
 for(let i=0;i<28;i++){
  const id=randomUUID();ids.push(id);const owner=i===27?other:business;
  await pool.query("INSERT INTO ap_obligations(business_id,id,input_sha256,idempotency_key,input_fingerprint,status,normalized_invoice_number,amount_micro_usdc) VALUES($1,$2::uuid,$3,$2::text,$3,'OPEN',$4,9007199254740993)",[owner,id,randomUUID().replaceAll('-','').repeat(2),`invoice-${String(i).padStart(2,'0')}`]);
  const action=i===0?'REQUIRE_APPROVAL':i===1?'HOLD':i===2?'SCHEDULE':'PAY_NOW';
  await pool.query("INSERT INTO ap_decisions(business_id,id,obligation_id,obligation_version,action,reason,evidence_ids,policy_version,treasury_snapshot,evaluated_at,expires_at) VALUES($1,$2,$3,1,$4,'Stored reason','[]',1,'{}',now(),now()+interval '30 seconds')",[owner,randomUUID(),id,action]);
 }
 await pool.query("INSERT INTO ap_events(business_id,event_key,actor_id,entity_id,entity_version,event_type,payload) VALUES($1,'event','owner',$2,1,'REVIEWED',$3)",[business,ids[0],JSON.stringify({reason:'Actual stored reason',credential:'DO_NOT_EXPOSE'})]);
 await pool.query("INSERT INTO ap_events(business_id,event_key,actor_id,entity_id,entity_version,event_type,payload) VALUES($1,'private-other','owner',$1,1,'OTHER','{}')",[other]);
},30000);
afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
describe('owned workspace read models',()=>{
 it('counts the full business and pages without cross-business records or floating point money',async()=>{
  const summary=await reads.summary(business);expect(summary.counts).toMatchObject({total:27,approvals:1,held:1,scheduled:1,settled:0});expect(summary.recentInvoices).toHaveLength(5);expect(summary.actionQueue).toHaveLength(3);expect(summary.actionQueue[0]?.decision).toBe("REQUIRE_APPROVAL");
  const first=await reads.invoices(business,{offset:0,q:''}),second=await reads.invoices(business,{offset:25,q:''});expect(first.total).toBe(27);expect(first.invoices).toHaveLength(25);expect(first.nextOffset).toBe(25);expect(second.invoices).toHaveLength(2);expect(second.nextOffset).toBeNull();expect(first.invoices[0]?.amountMicroUsdc).toBe('9007199254740993');expect(new Set([...first.invoices,...second.invoices].map(i=>i.id)).size).toBe(27);
 });
 it('filters before pagination and does not treat SQL patterns as invented matches',async()=>{
  expect((await reads.invoices(business,{offset:0,q:'invoice-00',decision:'REQUIRE_APPROVAL'})).total).toBe(1);
  expect((await reads.invoices(business,{offset:0,q:'%',decision:'HOLD'})).total).toBe(0);
  expect((await reads.invoices(business,{offset:0,q:'',decision:'HOLD'})).invoices[0]?.reason).toBe('Stored reason');
 });
 it('returns only current-version decisions',async()=>{
  await pool.query('UPDATE ap_obligations SET version=2 WHERE business_id=$1 AND id=$2',[business,ids[1]]);
  expect((await reads.invoices(business,{offset:0,q:'',decision:'HOLD'})).total).toBe(0);
 });
 it('exposes only safe owned activity fields and restricts optional invoice filters',async()=>{
  const own=await reads.activity(business,0,null);expect(own.events).toHaveLength(1);expect(own.events[0]).toMatchObject({invoiceId:ids[0],reason:'Actual stored reason'});expect(JSON.stringify(own)).not.toContain('DO_NOT_EXPOSE');expect((await reads.activity(business,0,ids[27]!)).events).toEqual([]);
 });
 it('returns an actual empty payment list, then all historical attempts without signing material',async()=>{
  expect((await reads.payments(business,0,null)).payments).toEqual([]);
  const decision=(await pool.query<{id:string}>('SELECT id FROM ap_decisions WHERE business_id=$1 AND obligation_id=$2',[business,ids[0]])).rows[0]!;
  for(const state of['CANCELLED','FAILED'])await pool.query("INSERT INTO ap_payment_intents(business_id,id,obligation_id,decision_id,terms,request_fingerprint,provider_idempotency_key,amount_micro_usdc,fee_allowance_micro_usdc,state,failure_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,9007199254740993,1000,$8,'{}')",[business,randomUUID(),ids[0],decision.id,JSON.stringify({recipient:`0x${'3'.repeat(40)}`,'secret':'DO_NOT_EXPOSE'}),'f'.repeat(64),randomUUID(),state]);
  const all=await reads.payments(business,0,null);expect(all.payments).toHaveLength(2);expect(all.payments[0]?.amountMicroUsdc).toBe('9007199254740993');expect(JSON.stringify(all)).not.toContain('DO_NOT_EXPOSE');expect((await reads.payments(other,0,null)).payments).toEqual([]);expect((await reads.payments(business,0,'FAILED')).payments).toHaveLength(1);
 });
});


describe('action queue filtering and global sorting',()=>{
 it('sorts before pagination with exact money and excludes closed/unrelated records from open actions',async()=>{
  const owner=randomUUID();await pool.query("INSERT INTO ap_treasuries(business_id,wallet_id,wallet_address,chain_id,token_address,policy) VALUES($1,$1,$2,5042002,'0x3600000000000000000000000000000000000000','{}')",[owner,`0x${'4'.repeat(40)}`]);
  const ordered:string[]=[];
  for(let i=0;i<31;i++){
   const id=randomUUID();ordered.push(id);const status=i===28?'REJECTED':i===29?'SETTLED':'OPEN';
   await pool.query("INSERT INTO ap_obligations(business_id,id,input_sha256,idempotency_key,input_fingerprint,status,normalized_invoice_number,amount_micro_usdc,due_date) VALUES($1,$2::uuid,$3,$2::text,$3,$4,$5,$6,$7)",[owner,id,randomUUID().replaceAll('-','').repeat(2),status,`QUEUE-${i}`,i===27?'9007199254740993':String(28-i+3),i<27?`2026-10-${String(i+1).padStart(2,'0')}`:null]);
   // Rejection can invalidate the old decision version; closed records must still be discoverable.
   if(i!==28)await pool.query("INSERT INTO ap_decisions(business_id,id,obligation_id,obligation_version,action,reason,evidence_ids,policy_version,treasury_snapshot,evaluated_at,expires_at) VALUES($1,$2,$3,1,$4,'Synthetic queue sorting evidence','[]',1,'{}',now(),now()+interval '30 seconds')",[owner,randomUUID(),id,i===30?'PAY_NOW':'HOLD']);
  }
  await pool.query("INSERT INTO ap_invoice_revisions(business_id,obligation_id,version,actor_id,action,reason,corrections) VALUES($1,$2,1,'synthetic-owner','REJECT','Owner rejected with independent evidence','{}')",[owner,ordered[28]]);
  const first=await reads.invoices(owner,{offset:0,q:'',queue:'open_actions',sort:'due_asc'});
  const second=await reads.invoices(owner,{offset:25,q:'',queue:'open_actions',sort:'due_asc'});
  expect(first.total).toBe(28);expect(first.invoices[0]?.id).toBe(ordered[0]);expect(first.nextOffset).toBe(25);
  expect(second.invoices.map(i=>i.id)).toEqual(ordered.slice(25,28));expect(second.nextOffset).toBeNull();
  expect((await reads.invoices(owner,{offset:0,q:'',queue:'open_actions',sort:'due_desc'})).invoices[0]?.id).toBe(ordered[26]);
  expect((await reads.invoices(owner,{offset:0,q:'',queue:'open_actions',sort:'amount_desc'})).invoices[0]?.amountMicroUsdc).toBe('9007199254740993');
  expect((await reads.invoices(owner,{offset:0,q:'',queue:'open_actions',sort:'amount_asc'})).invoices[0]?.id).toBe(ordered[26]);
  const rejected=await reads.invoices(owner,{offset:0,q:'',queue:'rejected'});expect(rejected.total).toBe(1);expect(rejected.invoices[0]).toMatchObject({id:ordered[28],status:'REJECTED',decision:null,reason:'Owner rejected with independent evidence'});
  expect((await reads.invoices(owner,{offset:0,q:'QUEUE-28',queue:'open_actions'})).total).toBe(0);
  const summary=await reads.summary(owner);expect(summary.counts).toMatchObject({held:28,rejected:1,settled:1});
 });
});
