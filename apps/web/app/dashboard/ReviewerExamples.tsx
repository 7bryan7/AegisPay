"use client";

import { useState } from "react";
import { microUsdcToUsdc } from "@agentpay/core";
import type { PayablesApi } from "../../lib/payables";

type Props = { api: PayablesApi; busy: boolean; action: (work: () => Promise<void>) => Promise<void> };
export function ReviewerExamples({ api, busy, action }: Props) {
  const [examples, setExamples] = useState<Awaited<ReturnType<PayablesApi["reviewerExamples"]>> | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<PayablesApi["evaluateExample"]>> | null>(null);
  const money = (amount: string) => `${microUsdcToUsdc(BigInt(amount))} USDC`;
  return <section className="ap-panel"><h2>Sanitized reviewer examples</h2>
    <p>These synthetic examples use the policy engine with a fixed clock. They have no access to private invoices, treasury records or payment services.</p>
    <button disabled={busy} onClick={() => void action(async () => { setExamples(await api.reviewerExamples()); })}>Load reviewer examples</button>
    {examples && <ul>{examples.examples.map((example) => <li key={example.id}><h3>{example.title}</h3><p>{example.description}</p>
      <button disabled={busy} onClick={() => void action(async () => { setResult(await api.evaluateExample(example.id)); })}>Evaluate {example.title.toLowerCase()}</button>
    </li>)}</ul>}
    {result && <div role="region" aria-label="Synthetic evaluation"><h3>{result.example.title}: {result.action.replaceAll("_", " ").toLowerCase()}</h3>
      <p>{result.disclosure}</p><dl className="ap-facts"><dt>Scenario clock</dt><dd>{result.evaluatedAt}</dd><dt>Nominal invoice</dt><dd>{money(result.nominalAmountMicroUsdc)}</dd>
        <dt>Synthetic cash</dt><dd>{money(result.cashMicroUsdc)}</dd><dt>Due date</dt><dd>{result.dueDate}</dd><dt>Reasons</dt><dd>{result.reasons.join(", ")}</dd></dl>
      <ul>{result.candidates.map((candidate) => <li key={candidate.id}>{candidate.action.replaceAll("_", " ").toLowerCase()} · {money(candidate.amountMicroUsdc)}{candidate.executeAt ? ` at ${candidate.executeAt}` : ""}</li>)}</ul>
    </div>}
  </section>;
}
