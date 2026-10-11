"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { microUsdcToUsdc, type ApSession, type AuditView, type InvoiceDetail, type InvoiceList, type TreasuryView } from "@agentpay/core";
import { PayablesApi, PayablesApiError } from "../../lib/payables";

function money(amount: string | null | undefined) { return amount == null ? "Unavailable" : `${microUsdcToUsdc(BigInt(amount))} USDC`; }
function readable(value: string) { return value.replaceAll("_", " ").toLowerCase(); }
function paymentMessage(state: string | null | undefined) {
  if (!state) return "No transfer initiated.";
  if (state === "SETTLED") return "Settled with independently verified Arc receipt.";
  if (state === "UNKNOWN") return "Provider outcome unresolved. Funds remain held; do not retry.";
  if (state === "PENDING" || state === "SUBMITTING") return "Provider processing. Settlement is not confirmed yet.";
  if (state === "FAILED" || state === "CANCELLED") return `Payment ${readable(state)}. No settlement is claimed.`;
  return readable(state);
}

export default function DashboardPage() {
  const api = useMemo(() => new PayablesApi(process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"), []);
  const [session, setSession] = useState<ApSession>({ authenticated: false, loginAvailable: false });
  const [code, setCode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [hint, setHint] = useState("");
  const [list, setList] = useState<InvoiceList | null>(null);
  const [treasury, setTreasury] = useState<TreasuryView | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Checking your session…");
  const [approvalReason, setApprovalReason] = useState("Operator approved within policy threshold");
  const uploadKey = useRef<string | null>(null);
  const selection = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void api.session().then(async (next) => {
      if (!active) return;
      setSession(next);
      if (!next.authenticated) {
        setMessage(next.loginAvailable ? "Sign in with your operator or reviewer access code." : "Setup required: add session and access credentials to the server’s local environment file.");
        return;
      }
      const [invoices, funds] = await Promise.all([api.list(), api.treasury()]);
      if (active) { setList(invoices); setTreasury(funds); setMessage("Workspace loaded. Payments are unavailable."); }
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof PayablesApiError ? error.message : "Backend unavailable. Start the API and check its configuration.");
    });
    return () => { active = false; };
  }, [api]);

  async function refresh(pageOffset = offset) {
    try {
      const [invoices, funds] = await Promise.all([api.list(pageOffset), api.treasury()]);
      setList(invoices); setTreasury(funds); setOffset(pageOffset);
    } catch (error) { setList(null); setTreasury(null); setDetail(null); setAudit(null); throw error; }
  }
  async function action(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); }
    catch (error) {
      if (error instanceof PayablesApiError && error.status === 401) {
        setSession({ authenticated: false, loginAvailable: true }); setList(null); setDetail(null); setAudit(null); setTreasury(null);
      }
      setMessage(error instanceof Error ? error.message : "Request failed. Try again.");
    } finally { setBusy(false); }
  }
  function login(event: FormEvent) {
    event.preventDefault();
    void action(async () => { const next = await api.login(code); setSession(next); setCode(""); await refresh(0); setMessage("Signed in. Payments are unavailable."); });
  }
  function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return;
    const selected = file;
    if (!uploadKey.current) uploadKey.current = crypto.randomUUID();
    const key = uploadKey.current;
    void action(async () => {
      const saved = await api.upload(selected, key, hint);
      setMessage(saved.reused ? "Existing upload recovered. No duplicate was created." : "Invoice saved. Extraction is awaiting worker setup; no payment was initiated.");
      setFile(null); setHint(""); uploadKey.current = null; if (selection.current) selection.current.value = "";
      await refresh(0); await openInvoice(saved.obligationId);
    });
  }
  async function openInvoice(id: string) {
    setDetail(null); setAudit(null);
    const [record, events] = await Promise.all([api.detail(id), api.audit(id)]);
    setDetail(record); setAudit(events);
  }
  function exportAudit() {
    if (!audit || !detail) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `invoice-${detail.invoice.id}-activity.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function approveInvoice(event: FormEvent) {
    event.preventDefault();
    if (!detail?.decision || !operator) return;
    const invoiceId = detail.invoice.id;
    const decisionId = detail.decision.id;
    void action(async () => {
      const result = await api.approve(invoiceId, decisionId, approvalReason);
      setMessage(`Approval granted (${result.approvalId.slice(0, 8)}…). Payment intent will be scheduled by the worker.`);
      await refresh();
      await openInvoice(invoiceId);
    });
  }
  const operator = session.authenticated && session.role === "OPERATOR";
  return <div className="ap-workspace">
    <header className="ap-heading"><div><p className="ap-eyebrow">ACCOUNTS PAYABLE</p><h1>Treasury workspace</h1><p>Verified obligations. Clear decisions. Traceable payments.</p></div><span className="ap-badge">Arc Testnet</span></header>
    <div className="ap-notice"><strong>Settlement evidence is explicit</strong><span>Pending and unknown provider states are not settlements. Local registry checks are not sanctions clearance.</span></div>
    <p className="ap-message" role="status" aria-live="polite">{message}</p>
    {!session.authenticated ? <section className="ap-panel ap-login"><h2>Workspace access</h2><p>Use your assigned access code. Reviewers cannot view private invoices or move funds.</p>
      <form onSubmit={login}><label htmlFor="access-code">Access code</label><input id="access-code" type="password" autoComplete="current-password" value={code} onChange={(event) => setCode(event.target.value)} required />
        <button disabled={busy || !session.loginAvailable}>Sign in</button></form></section> : <>
      <div className="ap-toolbar"><span>{readable(session.role)} access</span><div><button disabled={busy} onClick={() => void action(async () => { await refresh(); if (detail) await openInvoice(detail.invoice.id); setMessage("Workspace refreshed."); })}>Refresh</button>
        <button disabled={busy} onClick={() => void action(async () => { await api.logout(); setSession({ authenticated: false, loginAvailable: true }); setList(null); setTreasury(null); setDetail(null); setAudit(null); setMessage("Signed out."); })}>Sign out</button></div></div>
      {treasury?.configuredMode === "fixture" && <p className="ap-notice">Fixture mode — synthetic test data. No real settlement.</p>}
      {!operator && <p className="ap-notice">Reviewer access is isolated from private data. Sanitized examples have not been added yet.</p>}
      <section className="ap-panel" id="treasury"><h2>Treasury</h2><div className="ap-metrics"><div><span>USDC balance</span><strong>{money(treasury?.cashMicroUsdc)}</strong></div><div><span>Payment holds + fee allowances</span><strong>{money(treasury?.holdsMicroUsdc)}</strong></div><div><span>Minimum reserve</span><strong>{money(treasury?.minimumReserveMicroUsdc)}</strong></div></div>
        <p className="ap-wrap">{treasury?.walletAddress ? `Treasury wallet: ${treasury.walletAddress}` : "Treasury wallet unavailable"}</p><p>{treasury?.message ?? "Treasury storage has not loaded. No balance is assumed."}</p>
        {treasury && <p>Configured mode: {treasury.configuredMode} · New submissions: disabled</p>}</section>
      {operator && <section className="ap-panel"><h2>Upload invoice</h2><p>One PNG or JPEG, up to 5 MB. The vendor and amount must be independently verified before payment.</p><form onSubmit={upload} className="ap-upload">
        <label htmlFor="invoice-file">Invoice image<input ref={selection} id="invoice-file" type="file" accept="image/png,image/jpeg" disabled={busy} required onChange={(event) => { setFile(event.target.files?.[0] ?? null); uploadKey.current = null; }} /></label>
        <label htmlFor="po-hint">Purchase order reference (optional)<input id="po-hint" value={hint} maxLength={500} disabled={busy} onChange={(event) => { setHint(event.target.value); uploadKey.current = null; }} /></label>
        <button disabled={busy || !file}>Save invoice</button></form></section>}
      <section className="ap-panel" id="inbox"><h2>Invoice inbox</h2>{!list ? <p>Invoice storage unavailable. Refresh after database setup.</p> : !list.invoices.length ? <p>No invoices to display.</p> : <div className="ap-table-wrap"><table><thead><tr><th>Invoice / vendor</th><th>Amount</th><th>Due</th><th>Decision / payment</th><th>Details</th></tr></thead><tbody>{list.invoices.map((invoice) => <tr key={invoice.id}>
        <td>{invoice.invoiceNumber ?? "Awaiting extraction"}<small>{invoice.vendorName ?? "Vendor not verified"}</small></td><td>{money(invoice.amountMicroUsdc)}</td><td>{invoice.dueDate ?? "Unverified"}</td><td>{readable(invoice.decision ?? invoice.status)}<small>{invoice.paymentState ? readable(invoice.paymentState) : "No payment"}</small></td>
        <td><button disabled={busy} onClick={() => void action(() => openInvoice(invoice.id))}>View invoice</button></td></tr>)}</tbody></table></div>}
        <div className="ap-pagination"><button disabled={busy || offset === 0} onClick={() => void action(() => refresh(Math.max(0, offset - 25)))}>Previous</button><button disabled={busy || list?.nextOffset == null} onClick={() => void action(() => refresh(list?.nextOffset ?? 0))}>Next</button></div></section>
      {detail && <section className="ap-panel" id="invoice-detail"><h2>Invoice detail</h2><p className="ap-wrap">{detail.invoice.id} · version {detail.invoice.version}</p><p>{detail.processingMessage}</p>
        <a className="ap-source-link" href={api.imageUrl(detail.invoice.id)} target="_blank" rel="noopener noreferrer">Open private source image ↗</a>
        {detail.facts && <dl className="ap-facts"><dt>Vendor</dt><dd>{detail.facts.vendorName}</dd><dt>Invoice</dt><dd>{detail.facts.invoiceNumber}</dd><dt>PO</dt><dd>{detail.facts.purchaseOrderId}</dd><dt>Total</dt><dd>{money(detail.facts.amountMicroUsdc)}</dd><dt>Due date</dt><dd>{detail.facts.dueDate}</dd></dl>}
        <h3>Decision</h3><p>{detail.decision ? `${readable(detail.decision.action)}: ${detail.decision.reason}` : "No verified decision yet."}</p>
        {detail.decision && <p>Evidence: {detail.decision.evidenceIds.join(", ") || "No citations recorded"}</p>}
        {operator && detail.decision?.action === "REQUIRE_APPROVAL" && (
          <form onSubmit={approveInvoice} className="ap-approval-form">
            <label htmlFor="approval-reason">Operator approval rationale
              <input id="approval-reason" value={approvalReason} maxLength={500} disabled={busy} onChange={(e) => setApprovalReason(e.target.value)} required />
            </label>
            <button disabled={busy} type="submit">Approve invoice</button>
          </form>
        )}
        <h3>Payment</h3><p>{paymentMessage(detail.payment?.state)}</p>{detail.payment?.providerId && <p className="ap-wrap">Circle ID: {detail.payment.providerId}{detail.payment.providerState ? ` · ${readable(detail.payment.providerState)}` : ""}</p>}
        {detail.payment?.transactionHash && <p className="ap-wrap">Transaction reference (not proof of settlement): {detail.payment.transactionHash}</p>}
        {detail.payment?.settledAt && <p>Settled at: {new Date(detail.payment.settledAt).toLocaleString()}</p>}
        {detail.payment?.actualFeeMicroUsdc && <p>Verified network fee: {money(detail.payment.actualFeeMicroUsdc)}</p>}
        {detail.payment?.verificationReference && <p className="ap-wrap">Arc verification: {detail.payment.verificationReference}</p>}
        <h3>Activity</h3><p>Recent events (up to 500). Export contains event metadata only.</p><ol className="ap-activity">{audit?.events.map((event) => <li key={event.key}><strong>{readable(event.type)}</strong><time>{new Date(event.createdAt).toLocaleString()}</time></li>)}</ol>
        <button onClick={exportAudit} disabled={!audit}>Export activity</button></section>}
    </>}
  </div>;
}
