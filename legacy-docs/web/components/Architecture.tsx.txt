'use client';

import { useState, useEffect, useRef } from 'react';

interface PipelineStage {
  id: string;
  stepNum: string;
  name: string;
  sub: string;
  icon: React.ReactNode;
  status: string;
  statusType: 'ready' | 'active' | 'success';
  headline: string;
  description: string;
  specs: { label: string; value: string }[];
  payload: string;
  fileLabel: string;
  badge: string;
}

const pipelineStages: PipelineStage[] = [
  {
    id: 'discover',
    stepNum: '01',
    name: 'DISCOVER',
    sub: 'ENSv2 Registry',
    badge: 'ENSv2 · Machine Directory',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    status: 'ENS RESOLVED',
    statusType: 'success',
    headline: 'Machine-Readable Service Discovery',
    description:
      'The agent queries ENSv2 for candidates providing required capabilities without central gatekeepers or hardcoded provider endpoints.',
    specs: [
      { label: 'Query', value: 'ocr.*.agentpayapp.eth' },
      { label: 'Network', value: 'ENSv2 (Sepolia 11155111)' },
      { label: 'Candidates Found', value: '2 Enrolled Providers' },
      { label: 'Endpoint Protocol', value: 'x402-v1 / HTTPS' },
    ],
    fileLabel: 'ens_discovery_lookup.json',
    payload: `// 1. ENSv2 machine discovery query
QUERY ens_records("ocr.*.agentpayapp.eth", { capability: "invoice-extraction" })

--> RESOLVED CANDIDATES (live agentpay.* text records):
[
  {
    "name": "alpha.ocr.agentpayapp.eth",
    "agentpay.capability": "invoice-extraction",
    "agentpay.endpoint": "https://alpha.ocr.agentpayapp.eth/extract",
    "agentpay.payment.network": "hedera:testnet",
    "agentpay.payment.asset": "0.0.0",
    "agentpay.payment.recipient": "0.0.ALPHA_RECIPIENT",
    "agentpay.active": "true"
  },
  {
    "name": "beta.ocr.agentpayapp.eth",
    "agentpay.capability": "invoice-extraction",
    "agentpay.endpoint": "https://beta.ocr.agentpayapp.eth/extract",
    "agentpay.payment.network": "hedera:testnet",
    "agentpay.payment.asset": "0.0.0",
    "agentpay.payment.recipient": "0.0.BETA_RECIPIENT",
    "agentpay.active": "true"
  }
]`,
  },
  {
    id: 'evaluate',
    stepNum: '02',
    name: 'EVALUATE',
    sub: 'Readiness & Offer Verification',
    badge: 'Live Records · Readiness Probes',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    status: 'READINESS VERIFIED',
    statusType: 'success',
    headline: 'Live Records & Endpoint Readiness',
    description:
      'Each candidate re-resolves its ENS records at runtime and answers a readiness probe. A record or RPC failure makes the candidate unavailable — no silent fallback to hard-coded metadata.',
    specs: [
      { label: 'Record Schema', value: 'agentpay.* text records' },
      { label: 'Readiness Probe', value: 'HTTP wake + offer check' },
      { label: 'Asset / Network', value: 'HBAR 0.0.0 · hedera:testnet' },
      { label: 'Recipient', value: 'Per-record 0.0.x account' },
    ],
    fileLabel: 'provider_readiness_report.json',
    payload: `// 2. Live record re-resolution + readiness probes
--> RESOLVE agentpay.* records for each candidate
--> PROBE https://alpha.ocr.agentpayapp.eth/extract (wake + offer)

--> READINESS VERDICT:
alpha.ocr.agentpayapp.eth: records OK · probe 200 · offer 1,000,000 tinybars (READY)
beta.ocr.agentpayapp.eth:  records OK · probe 200 · offer 2,000,000 tinybars (READY)

--> ELIGIBILITY FILTERS APPLIED:
capability ✓  active ✓  endpoint allowlisted ✓
network hedera:testnet ✓  asset 0.0.0 ✓  recipient valid ✓  budget ✓`,
  },
  {
    id: 'decide',
    stepNum: '03',
    name: 'DECIDE',
    sub: 'AI Policy Engine',
    badge: 'LLM Scoring · Policy Bounds',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2a4 4 0 0 1 4 4c0 1.1-.45 2.1-1.17 2.83L16 10h-8l1.17-1.17A4 4 0 0 1 12 2z" />
        <path d="M4 22h16l-2-6H6l-2 6z" />
      </svg>
    ),
    status: 'ROUTE DECISION LOCKED',
    statusType: 'success',
    headline: 'Policy-Bound Route Selection',
    description:
      'The decision engine applies hard eligibility filters, then picks the cheapest eligible current offer. Ties break by normalized ENS name. The LLM can invoke typed tools but never choose arbitrary recipients or bypass policy.',
    specs: [
      { label: 'Winner Selected', value: 'alpha.ocr.agentpayapp.eth' },
      { label: 'Selection Rule', value: 'Cheapest eligible offer' },
      { label: 'Request Cap', value: '5,000,000 tinybars' },
      { label: 'Daily Cap', value: '100,000,000 tinybars' },
    ],
    fileLabel: 'agent_routing_verdict.json',
    payload: `// 3. AI Policy Engine scores candidates against constraints
{
  "task": "invoice-extraction",
  "policyBounds": {
    "maxSpendPerRequest": "5000000 tinybars",
    "maxSpendPerTask": "20000000 tinybars",
    "maxSpendPerDay": "100000000 tinybars",
    "network": "hedera:testnet",
    "asset": "0.0.0"
  },
  "eligibleCandidates": [
    { "name": "alpha.ocr.agentpayapp.eth", "offer": "1000000 tinybars" },
    { "name": "beta.ocr.agentpayapp.eth",  "offer": "2000000 tinybars" }
  ],
  "selectedProvider": "alpha.ocr.agentpayapp.eth",
  "selectionRule": "cheapest eligible offer; tie-break by normalized ENS name",
  "decisionStatus": "ROUTE_CONFIRMED"
}`,
  },
  {
    id: 'settle',
    stepNum: '04',
    name: 'SETTLE',
    sub: 'Hedera + x402',
    badge: 'HTTP 402 · HBAR Settlement',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    status: 'CONSENSUS FINALIZED',
    statusType: 'success',
    headline: 'Machine-to-Machine Micro-Settlement',
    description:
      'The service returns HTTP 402. The agent signs the exact x402 payload and the Blocky402 facilitator settles it on Hedera Testnet — native HBAR, integer tinybars, no floating-point money.',
    specs: [
      { label: 'Protocol Gate', value: 'HTTP 402 Payment Required' },
      { label: 'Facilitator', value: 'api.testnet.blocky402.com' },
      { label: 'Settlement Asset', value: 'HBAR 0.0.0 (native)' },
      { label: 'Hedera Network', value: 'hedera:testnet' },
    ],
    fileLabel: 'hedera_settlement_flow.http',
    payload: `// 4. x402 challenge issued & settled via Blocky402
--> POST https://alpha.ocr.agentpayapp.eth/extract
<-- HTTP/1.1 402 Payment Required
    X-402-PayTo: 0.0.ALPHA_RECIPIENT
    X-402-Amount: 1000000 tinybars
    X-402-Network: hedera:testnet
    X-402-Asset: 0.0.0

--> BLOCKY402 FACILITATOR SETTLES:
    Payer: 0.0.PAYER (agent wallet) → Recipient: 0.0.ALPHA_RECIPIENT
    Amount: 1,000,000 tinybars (0.01 HBAR)

<-- HEDERA CONSENSUS CONFIRMATION:
    Status: SUCCESS
    Receipt: https://hashscan.io/testnet/transaction/<txid>`,
  },
  {
    id: 'unlock',
    stepNum: '05',
    name: 'UNLOCK',
    sub: 'Protected Execution',
    badge: 'Execution · Zero Human Loop',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
    status: 'SERVICE DELIVERED',
    statusType: 'success',
    headline: 'Settlement Proof & Extraction Result',
    description:
      'Blocky402 validates the Hedera consensus receipt. The endpoint unlocks and returns the extraction result. Paid access is granted only after confirmed settlement — never on a signed-but-unsettled payload.',
    specs: [
      { label: 'Response Code', value: '200 OK after settlement' },
      { label: 'Validator', value: 'Blocky402 Consensus Gate' },
      { label: 'Extraction Model', value: 'gemini-3.6-flash' },
      { label: 'Result Retention', value: '24h, then removed' },
    ],
    fileLabel: 'ai_service_result.json',
    payload: `// 5. Proof verified → Service execution completed
--> POST https://alpha.ocr.agentpayapp.eth/extract
    Authorization: Bearer x402-<settled-txid>

<-- HTTP/1.1 200 OK
    Content-Type: application/json
    X-x402-Verified-By: Blocky402-Hedera-Validator

{
  "status": "completed",
  "task": "invoice-extraction",
  "result": {
    "vendor": "Acme Services LLC",
    "invoiceNumber": "INV-2026-894",
    "total": "450.00",
    "currency": "USD",
    "confidence": 0.994
  },
  "settled": "1000000 tinybars on hedera:testnet"
}`,
  },
];

export default function Architecture() {
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const simulationTimerRef = useRef<NodeJS.Timeout | null>(null);

  const currentStage = pipelineStages[activeStepIndex]!;

  // Auto-play simulation loop
  useEffect(() => {
    if (isSimulating) {
      simulationTimerRef.current = setInterval(() => {
        setActiveStepIndex((prev) => (prev + 1) % pipelineStages.length);
      }, 2600);
    } else {
      if (simulationTimerRef.current) {
        clearInterval(simulationTimerRef.current);
      }
    }
    return () => {
      if (simulationTimerRef.current) clearInterval(simulationTimerRef.current);
    };
  }, [isSimulating]);

  const handleCopy = () => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(currentStage.payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <section className="arch-section" id="architecture">
      <div className="inner">
        {/* Section Title */}
        <div className="section-title arch-title-row">
          <div>
            <h2 data-scroll>
              Autonomous routing,<br />
              from discovery to <span>instant settlement</span>.
            </h2>
            <p>
              ENSv2 discovers. Readiness verifies. AI decides. Hedera settles. x402 unlocks. Zero human intervention in the execution loop.
            </p>
          </div>

          <div className="pipeline-top-cta">
            <button
              className={`pipeline-sim-toggle ${isSimulating ? 'simulating' : ''}`}
              onClick={() => setIsSimulating(!isSimulating)}
              title="Simulate autonomous pipeline execution"
            >
              <span className="sim-pulse"></span>
              <span>{isSimulating ? 'Pause Flow Simulation' : 'Run Pipeline Simulation'}</span>
            </button>
          </div>
        </div>

        {/* Master Pipeline Showcase Container */}
        <div className="pipeline-showcase-card" data-scroll data-anim="fade-up">
          {/* Card Header with Status & Architecture Badges */}
          <div className="pipeline-card-header">
            <div className="pipeline-status-badge">
              <span className="pulsing-dot"></span>
              <span>AUTONOMOUS PIPELINE RUNTIME</span>
            </div>
            <div className="pipeline-meta-tags">
              <span className="pipeline-network-pill">HEDERA TESTNET</span>
              <span className="pipeline-network-pill">ENSv2 NATIVE</span>
              <span className="pipeline-network-pill">x402 STANDARD</span>
            </div>
          </div>

          {/* 5-Stage Interactive Pipeline Stepper Track */}
          <div className="pipeline-stepper-track">
            {pipelineStages.map((stage, idx) => {
              const isActive = idx === activeStepIndex;
              const isPast = idx < activeStepIndex;
              return (
                <div key={stage.id} className="pipeline-step-wrapper">
                  <button
                    className={`pipeline-step-node ${isActive ? 'active' : ''} ${isPast ? 'completed' : ''}`}
                    onClick={() => {
                      setIsSimulating(false);
                      setActiveStepIndex(idx);
                    }}
                    aria-label={`Step ${stage.stepNum}: ${stage.name}`}
                  >
                    <div className="step-node-header">
                      <span className="step-node-index">{stage.stepNum}</span>
                      <span className="step-node-indicator">
                        {isActive && <span className="active-ping" />}
                      </span>
                    </div>

                    <div className="step-node-icon">{stage.icon}</div>
                    <div className="step-node-name">{stage.name}</div>
                    <div className="step-node-sub">{stage.sub}</div>
                  </button>

                  {/* Connecting conduit arrow on desktop */}
                  {idx < pipelineStages.length - 1 && (
                    <div className={`pipeline-conduit ${idx < activeStepIndex ? 'conduit-active' : ''}`}>
                      <div className="conduit-line">
                        <div className="conduit-particle" />
                      </div>
                      <span className="conduit-arrow">&rarr;</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Dual-Pane Telemetry & Protocol Inspector */}
          <div className="pipeline-workspace-grid">
            {/* Left Column: Stage Deep Dive & Live Parameters */}
            <div className="pipeline-telemetry-pane">
              <div className="pane-header">
                <div className="pane-step-badge">
                  <span>STAGE {currentStage.stepNum} OF 05</span>
                  <span className="pane-stage-tag">{currentStage.badge}</span>
                </div>
                <div className="pane-status-indicator">
                  <span className="pulsing-dot" />
                  <span>{currentStage.status}</span>
                </div>
              </div>

              <div className="pane-body">
                <h3 className="pane-headline">{currentStage.headline}</h3>
                <p className="pane-description">{currentStage.description}</p>

                {/* Technical Specs Key-Value Grid */}
                <div className="pane-specs-grid">
                  {currentStage.specs.map((spec, i) => (
                    <div key={i} className="spec-item">
                      <div className="spec-label">{spec.label}</div>
                      <div className="spec-value">{spec.value}</div>
                    </div>
                  ))}
                </div>

                {/* Stage Navigation Stepper Controls */}
                <div className="pane-nav-controls">
                  <button
                    className="pane-nav-btn prev"
                    disabled={activeStepIndex === 0}
                    onClick={() => {
                      setIsSimulating(false);
                      setActiveStepIndex((prev) => Math.max(0, prev - 1));
                    }}
                  >
                    &larr; Prev Step
                  </button>

                  <div className="pane-nav-dots">
                    {pipelineStages.map((_, i) => (
                      <span
                        key={i}
                        className={`nav-dot ${i === activeStepIndex ? 'active' : ''}`}
                        onClick={() => {
                          setIsSimulating(false);
                          setActiveStepIndex(i);
                        }}
                      />
                    ))}
                  </div>

                  <button
                    className="pane-nav-btn next"
                    disabled={activeStepIndex === pipelineStages.length - 1}
                    onClick={() => {
                      setIsSimulating(false);
                      setActiveStepIndex((prev) => Math.min(pipelineStages.length - 1, prev + 1));
                    }}
                  >
                    Next Step &rarr;
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Protocol Terminal Inspector */}
            <div className="pipeline-terminal-pane">
              <div className="terminal-header">
                <div className="terminal-window-dots">
                  <span className="dot red" />
                  <span className="dot yellow" />
                  <span className="dot green" />
                </div>
                <div className="terminal-file-title">
                  <span className="terminal-file-icon">&#9639;</span>
                  <span>{currentStage.fileLabel}</span>
                </div>
                <button
                  className="terminal-copy-btn"
                  onClick={handleCopy}
                  title="Copy protocol payload"
                >
                  {copied ? 'Copied ✓' : 'Copy Payload'}
                </button>
              </div>

              <div className="terminal-body">
                <pre className="terminal-code">
                  <code>{currentStage.payload}</code>
                </pre>
              </div>

              <div className="terminal-footer">
                <div className="terminal-foot-item">
                  <span className="foot-label">Protocol:</span>
                  <span className="foot-val">HTTP/1.1 402 / ENSv2 / x402</span>
                </div>
                <div className="terminal-foot-item">
                  <span className="foot-label">Status:</span>
                  <span className="foot-val success">Consensus Verified</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Metrics Bar */}
          <div className="pipeline-metrics-bar">
            <div className="pipeline-metric">
              <div className="metric-val">hedera:testnet</div>
              <div className="metric-lbl">Settlement Network · Fail-Closed</div>
            </div>
            <div className="pipeline-metric">
              <div className="metric-val">0.0.0 HBAR</div>
              <div className="metric-lbl">Native Settlement Asset</div>
            </div>
            <div className="pipeline-metric">
              <div className="metric-val">5M tinybars</div>
              <div className="metric-lbl">Default Request Cap</div>
            </div>
            <div className="pipeline-metric">
              <div className="metric-val">2 Providers</div>
              <div className="metric-lbl">Enrolled via ENSv2</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}