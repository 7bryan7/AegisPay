"use client";
import { ConfirmDialog } from "./WorkspaceUI";

import { useRef, useState, type FormEvent } from "react";
import { reviewableInvoiceFields, type InvoiceDetail } from "@agentpay/core";
import type { PayablesApi } from "../../lib/payables";

type Props = { api: PayablesApi; detail: InvoiceDetail; busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>; updated: (message: string) => Promise<void> };
export function InvoiceReviewControls({ api, detail, busy, action, updated }: Props) {
  const [field, setField] = useState<(typeof reviewableInvoiceFields.options)[number]>("total");
  const [value, setValue] = useState(detail.review?.corrections.total?.value ?? detail.review?.latestExtraction?.total.value ?? "");
  const [missing, setMissing] = useState(false), [reference, setReference] = useState(""), [reason, setReason] = useState("");
  const [rejecting,setRejecting]=useState(false);
  const commandIds = useRef(new Map<string, string>());
  const locked = ["SUBMITTING", "PENDING", "UNKNOWN", "SETTLED"].includes(detail.payment?.state ?? "");
  function command(kind: string, payload: unknown = null) {
    const fingerprint = JSON.stringify({ kind, payload, reason, version: detail.invoice.version });
    if (!commandIds.current.has(fingerprint)) commandIds.current.set(fingerprint, crypto.randomUUID());
    return { commandId: commandIds.current.get(fingerprint)!, expectedVersion: detail.invoice.version, reason };
  }
  function correct(event: FormEvent) {
    event.preventDefault();
    const fields = { [field]: { value: missing ? null : value, evidenceReference: reference } };
    void action(async () => {
      await api.correct(detail.invoice.id, { ...command("correct", fields), fields });
      await updated("Correction recorded with owner evidence. Previous authorization was invalidated; the worker will verify the new version.");
    });
  }
  function evaluate(reextract: boolean) {
    void action(async () => {
      await api.evaluate(detail.invoice.id, { ...command("evaluate", reextract), reextract });
      await updated(reextract ? "Re-extraction queued. Owner corrections and source history are retained." : "Re-evaluation queued for the current evidence.");
    });
  }
  return <section className="ap-review" aria-label="Owner invoice review">
    <h3>Owner review</h3>
    <p>Corrections need an independent evidence reference. They trigger verification and do not override vendor, budget or duplicate checks.</p>
    {locked && <p>Submitted, unresolved and settled payments cannot be edited or rejected.</p>}
    <label htmlFor="review-reason">Review reason<input id="review-reason" value={reason} maxLength={2000} disabled={busy}
      onChange={(event) => setReason(event.target.value)} /></label>
    {!locked && <>
      <form onSubmit={correct} className="ap-upload">
        <label htmlFor="review-field">Field to correct<select id="review-field" value={field} disabled={busy} onChange={(event) => {
          const selected = reviewableInvoiceFields.parse(event.target.value); setField(selected);
          setValue(detail.review?.corrections[selected]?.value ?? detail.review?.latestExtraction?.[selected].value ?? "");
        }}>{reviewableInvoiceFields.options.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label htmlFor="review-value">Corrected value<input id="review-value" value={value} maxLength={4000} required={!missing} disabled={busy || missing}
          onChange={(event) => setValue(event.target.value)} /></label>
        <label htmlFor="review-missing"><input id="review-missing" type="checkbox" checked={missing} disabled={busy}
          onChange={(event) => setMissing(event.target.checked)} /> Mark field missing</label>
        <label htmlFor="review-reference">Independent evidence reference<input id="review-reference" value={reference} maxLength={1000} required disabled={busy}
          onChange={(event) => setReference(event.target.value)} /></label>
        <button disabled={busy || !reason.trim()}>Save correction</button>
      </form>
      <div className="ap-toolbar">
        <button disabled={busy || !reason.trim() || detail.invoice.status === "REJECTED"} onClick={() => evaluate(false)}>Re-evaluate invoice</button>
        <button disabled={busy || !reason.trim() || detail.invoice.status === "REJECTED"} onClick={() => evaluate(true)}>Re-extract image</button>
        <button disabled={busy || !reason.trim() || detail.invoice.status === "REJECTED"} onClick={()=>setRejecting(true)}>Reject invoice</button>
      </div>
    </>}
    {rejecting&&<ConfirmDialog title="Reject invoice" onClose={()=>setRejecting(false)}><p>This rejects the unsubmitted invoice and releases any safe unsubmitted reservation. It cannot reverse a submitted payment.</p><p>Reason: {reason}</p><button disabled={busy||!reason.trim()} onClick={()=>void action(async()=>{await api.reject(detail.invoice.id,command("reject"));setRejecting(false);await updated("Invoice rejected. Any unsubmitted reservation was released.");})}>Confirm rejection</button></ConfirmDialog>}
    {detail.payment?.id && ["PENDING", "UNKNOWN"].includes(detail.payment.state) && <button disabled={busy || !reason.trim()}
      onClick={() => void action(async () => {
        const result = await api.reconcile(detail.payment!.id!, reason);
        await updated(`Reconciliation: ${result.status.toLowerCase()}. This action never creates a transfer.`);
      })}>Reconcile existing payment</button>}
    {!!detail.review?.revisions.length && <details><summary>Owner review history</summary><ol>{detail.review.revisions.map((revision) =>
      <li key={revision.version}>Version {revision.version} · {revision.action.toLowerCase()} · {revision.reason} · {revision.actorId}</li>)}</ol></details>}
    {detail.review?.originalExtraction && <details><summary>Original extraction evidence</summary><dl className="ap-facts">
      {reviewableInvoiceFields.options.map((name) => <div key={name}><dt>{name}</dt><dd>{detail.review!.originalExtraction![name].status} · {detail.review!.originalExtraction![name].sourceText ?? "No visible source text"}</dd></div>)}
    </dl></details>}
  </section>;
}
