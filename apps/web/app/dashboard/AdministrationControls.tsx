"use client";
import { ConfirmDialog } from "./WorkspaceUI";

import { useState, type FormEvent } from "react";
import { createVendorSchema, updateVendorSchema, createPurchaseOrderSchema, updatePurchaseOrderSchema,
  updatePolicySchema, microUsdcToUsdc, usdcToMicroUsdc } from "@agentpay/core";
import type { PayablesApi } from "../../lib/payables";

type Props = { view?: "vendors" | "orders" | "policy"; api: PayablesApi; busy: boolean; action: (work: () => Promise<void>) => Promise<void>; updated: (message: string) => Promise<void> };
const text = (form: FormData, name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
const money = (value: string) => microUsdcToUsdc(BigInt(value));
type Data = { vendors: Awaited<ReturnType<PayablesApi["vendors"]>>; orders: Awaited<ReturnType<PayablesApi["purchaseOrders"]>>;
  policy: Awaited<ReturnType<PayablesApi["policy"]>> };
const policyLabels = { autoPayMaxMicroUsdc: "Automatic payment maximum", hardTxMaxMicroUsdc: "Hard transfer ceiling",
  dailyBudgetMicroUsdc: "Daily payout budget", categoryBudgetMicroUsdc: "Monthly category budget", minReserveMicroUsdc: "Minimum reserve" };

export function AdministrationControls({ api, busy, action, updated, view }: Props) {
  const [editor,setEditor]=useState<"vendor"|"order"|null>(null);
  const [data, setData] = useState<Data | null>(null), [vendorOffset, setVendorOffset] = useState(0), [orderOffset, setOrderOffset] = useState(0);
  const [vendor, setVendor] = useState<Data["vendors"]["vendors"][number] | null>(null);
  const [order, setOrder] = useState<Data["orders"]["purchaseOrders"][number] | null>(null);
  async function load(vOffset = vendorOffset, pOffset = orderOffset) {
    const [vendors, orders, policy] = await Promise.all([api.vendors(vOffset), api.purchaseOrders(pOffset), api.policy()]);
    setData({ vendors, orders, policy }); setVendorOffset(vOffset); setOrderOffset(pOffset);
  }
  function saveVendor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void action(async () => {
      const fields = { name: text(form, "name"), aliases: text(form, "aliases").split(",").map((name) => name.trim()).filter(Boolean),
        address: text(form, "address"), category: text(form, "category"), status: text(form, "status"), chainId: 5042002,
        settlementCurrency: text(form, "currency"), settlementAgreementReference: text(form, "agreement"),
        verificationReference: text(form, "verification"), verifiedAt: text(form, "verifiedAt"), reason: text(form, "reason") };
      await api.saveVendor(vendor?.id ?? null, vendor ? updateVendorSchema.parse({ ...fields, expectedVersion: vendor.addressVersion })
        : createVendorSchema.parse({ ...fields, id: text(form, "id") }));
      setVendor(null); setEditor(null); await load(); await updated("Vendor saved. Affected unsubmitted authorizations were invalidated.");
    });
  }
  function saveOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void action(async () => {
      const fields = { vendorId: text(form, "vendorId"), amountMicroUsdc: usdcToMicroUsdc(text(form, "amount")).toString(), dueDate: text(form, "dueDate"),
        description: text(form, "description"), servicePeriod: text(form, "servicePeriod") || null, deliveryAccepted: form.get("accepted") === "on", acceptanceReference: text(form, "acceptance") || null,
        essential: form.get("essential") === "on",
        verifiedDiscount: text(form, "discountAmount") ? { discountedAmountMicroUsdc: usdcToMicroUsdc(text(form, "discountAmount")).toString(),
          validThrough: text(form, "discountExpiry"), verifiedAt: text(form, "discountVerifiedAt"),
          verificationReference: text(form, "discountReference"), settlesInFull: true } : null, reason: text(form, "reason") };
      await api.savePurchaseOrder(order?.id ?? null, order ? updatePurchaseOrderSchema.parse({ ...fields, expectedVersion: order.version })
        : createPurchaseOrderSchema.parse({ ...fields, id: text(form, "id") }));
      setOrder(null); setEditor(null); await load(); await updated("Purchase order saved with versioned acceptance evidence.");
    });
  }
  function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (!data) return;
    const version = data.policy.version;
    void action(async () => {
      await api.savePolicy(updatePolicySchema.parse({ expectedVersion: version, reason: text(form, "reason"),
        policy: { ...Object.fromEntries(Object.keys(policyLabels).map((key) => [key, usdcToMicroUsdc(text(form, key)).toString()])),
          annualCashPreservationCostBps: Number(text(form, "cashCost")) } }));
      await load(); await updated("Policy saved. Old approvals cannot authorize this policy version.");
    });
  }
  return <section className="ap-panel" id="administration"><h2>Owner administration</h2>
    <p>Maintain verified suppliers, accepted purchase orders and financial limits. Each change needs a reason and current version.</p>
    <button disabled={busy} onClick={() => void action(() => load())}>Load administration</button>
    {data && <>
      {(!view || view === "vendors") && <details open={view === "vendors"}><summary>Vendors</summary>
        <div className="ap-table-wrap"><table><thead><tr><th>Vendor</th><th>Status</th><th>Category and currency</th><th>Verified address</th><th>Version</th><th>Details</th></tr></thead><tbody>{data.vendors.vendors.map(item=><tr key={item.id}><td>{item.name}<small>{item.aliases.join(", ")}</small></td><td>{item.status}</td><td>{item.category} · {item.settlementCurrency}</td><td className="ap-wrap">{item.address}</td><td>{item.addressVersion}</td><td><button disabled={busy} onClick={()=>{setVendor(item);setEditor("vendor");}}>Edit vendor {item.id}</button></td></tr>)}</tbody></table></div>
        <button disabled={busy || vendorOffset === 0} onClick={() => void action(() => load(Math.max(0, vendorOffset - 25), orderOffset))}>Previous vendors</button>
        <button disabled={busy || data.vendors.nextOffset === null} onClick={() => void action(() => load(data.vendors.nextOffset ?? 0, orderOffset))}>Next vendors</button>
        <button disabled={busy} onClick={() => {setVendor(null);setEditor("vendor");}}>New vendor</button>
        {editor==="vendor"&&<ConfirmDialog title={vendor?"Edit verified vendor":"Enroll verified vendor"} onClose={()=>setEditor(null)}><form key={vendor ? `${vendor.id}:${vendor.addressVersion}` : `new-vendor:${data.vendors.vendors.length}`} onSubmit={saveVendor} className="ap-upload">
          <h3>{vendor ? `Edit ${vendor.name}` : "Enroll a vendor"}</h3>
          {!vendor && <label>Vendor ID<input name="id" required maxLength={500} /></label>}
          <label>Vendor name<input name="name" defaultValue={vendor?.name} required maxLength={500} /></label>
          <label>Approved aliases, separated by commas<input name="aliases" defaultValue={vendor?.aliases.join(", ")} maxLength={4000} /></label>
          <label>Verified Arc address<input name="address" defaultValue={vendor?.address} required maxLength={42} /></label>
          <label>Category<input name="category" defaultValue={vendor?.category ?? ""} required maxLength={500} /></label>
          <label>Vendor status<select name="status" defaultValue={vendor?.status ?? "APPROVED"}><option value="APPROVED">Approved</option><option value="BLOCKED">Blocked</option></select></label>
          <label>Invoice currency<select name="currency" defaultValue={vendor?.settlementCurrency ?? "USD"}><option>USD</option><option>USDC</option></select></label>
          <label>USDC settlement agreement reference<input name="agreement" defaultValue={vendor?.settlementAgreementReference} required maxLength={500} /></label>
          <label>Address verification reference<input name="verification" defaultValue={vendor?.verificationReference} required maxLength={500} /></label>
          <label>Verified at, ISO UTC<input name="verifiedAt" defaultValue={vendor?.verifiedAt ?? ""} required maxLength={30} /></label>
          <label>Vendor change reason<input name="reason" required maxLength={2000} /></label><button disabled={busy}>Save vendor</button>
        </form></ConfirmDialog>}
      </details>}
      {(!view || view === "orders") && <details open={view === "orders"}><summary>Purchase orders</summary>
        <div className="ap-table-wrap"><table><thead><tr><th>PO and vendor</th><th>Authorized</th><th>Outstanding</th><th>Due</th><th>Acceptance</th><th>Version</th><th>Details</th></tr></thead><tbody>{data.orders.purchaseOrders.map(item=><tr key={item.id}><td>{item.id}<small>{item.vendorId}</small></td><td>{money(item.amountMicroUsdc)} USDC</td><td>{money(item.outstandingMicroUsdc)} USDC</td><td>{item.dueDate}</td><td>{item.deliveryAccepted?"Accepted":"Not accepted"}</td><td>{item.version}</td><td><button disabled={busy} onClick={()=>{setOrder(item);setEditor("order");}}>Edit purchase order {item.id}</button></td></tr>)}</tbody></table></div>
        <button disabled={busy || orderOffset === 0} onClick={() => void action(() => load(vendorOffset, Math.max(0, orderOffset - 25)))}>Previous purchase orders</button>
        <button disabled={busy || data.orders.nextOffset === null} onClick={() => void action(() => load(vendorOffset, data.orders.nextOffset ?? 0))}>Next purchase orders</button>
        <button disabled={busy} onClick={() => {setOrder(null);setEditor("order");}}>New purchase order</button>
        {editor==="order"&&<ConfirmDialog title={order?"Edit purchase order":"Record purchase order"} onClose={()=>setEditor(null)}><form key={order ? `${order.id}:${order.version}` : `new-order:${data.orders.purchaseOrders.length}`} onSubmit={saveOrder} className="ap-upload">
          <h3>{order ? `Edit ${order.id}` : "Record a purchase order"}</h3>
          {!order && <label>Purchase order ID<input name="id" required maxLength={500} /></label>}
          <label>Purchase order vendor ID<input name="vendorId" defaultValue={order?.vendorId} required maxLength={500} /></label>
          <label>Authorized amount, USDC<input name="amount" defaultValue={order ? money(order.amountMicroUsdc) : ""} required inputMode="decimal" /></label>
          <label>Purchase order due date<input name="dueDate" type="date" defaultValue={order?.dueDate} required /></label>
          <label>Accepted service description<input name="description" defaultValue={order?.description} required maxLength={500} /></label>
          <label>Accepted service period<input name="servicePeriod" defaultValue={order?.servicePeriod ?? ""} maxLength={500} /></label>
          <label><input name="accepted" type="checkbox" defaultChecked={order?.deliveryAccepted ?? false} /> Delivery accepted</label>
          <label>Independent acceptance reference<input name="acceptance" defaultValue={order?.acceptanceReference ?? ""} maxLength={500} /></label>
          <label><input name="essential" type="checkbox" defaultChecked={order?.essential ?? true} /> Protect this essential obligation</label>
          <p>A verified discount must fully settle the original invoice. Blank amount removes the discount. Expiry includes the selected UTC day.</p>
          <label>Exact discounted payout, USDC<input name="discountAmount" defaultValue={order?.verifiedDiscount ? money(order.verifiedDiscount.discountedAmountMicroUsdc) : ""} inputMode="decimal" /></label>
          <label>Discount valid through, UTC<input name="discountExpiry" type="date" defaultValue={order?.verifiedDiscount?.validThrough} /></label>
          <label>Discount verified at, ISO UTC<input name="discountVerifiedAt" defaultValue={order?.verifiedDiscount?.verifiedAt ?? ""} /></label>
          <label>Full-settlement agreement reference<input name="discountReference" defaultValue={order?.verifiedDiscount?.verificationReference} maxLength={500} /></label>
          <label>Purchase order change reason<input name="reason" required maxLength={2000} /></label><button disabled={busy}>Save purchase order</button>
        </form></ConfirmDialog>}
      </details>}
      {(!view || view === "policy") && <details open={view === "policy"}><summary>Financial policy</summary><form key={data.policy.version} onSubmit={savePolicy} className="ap-upload">
        <p>Policy version {data.policy.version}. All amounts are USDC. Approval cannot bypass hard limits.</p>
        {(Object.keys(policyLabels) as (keyof typeof policyLabels)[]).map((key) => <label key={key}>{policyLabels[key]}
          <input name={key} defaultValue={money(data.policy.policy[key])} required inputMode="decimal" /></label>)}
        <label>Annual cash-preservation cost, basis points<input name="cashCost" type="number" min="0" max="10000" step="1" defaultValue={data.policy.policy.annualCashPreservationCostBps ?? 0} required /></label>
        <label>Policy change reason<input name="reason" required maxLength={2000} /></label><button disabled={busy}>Save policy</button>
      </form></details>}
    </>}
  </section>;
}
