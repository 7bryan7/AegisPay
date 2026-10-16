import type { Metadata } from "next";
import Link from "next/link";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "AgentPay Treasury | Invoice to verified payment",
  description: "Verify invoices, review treasury decisions and manage USDC payments on Arc Testnet with AgentPay Treasury.",
};

const steps = [
  { title: "Bring the invoice", text: "Upload a PNG or JPEG. AI extracts the visible facts and preserves their source evidence." },
  { title: "Verify the obligation", text: "Match the approved vendor and accepted purchase order. Flag missing facts and duplicates." },
  { title: "Make a bounded decision", text: "Check cash, reserves, budgets and due dates. Review exact terms when approval is required." },
  { title: "Follow the payment", text: "Circle submits the eligible USDC transfer. Independent Arc receipt checks establish settlement." },
];

function Brand() {
  return <span className={styles.brand}><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M24 4 41 14v20L24 44 7 34V14L24 4Z" stroke="currentColor" strokeWidth="2" /><path d="m16 29 8-14 8 14M19 25h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>AgentPay<span className={styles.brandSuffix}>Treasury</span></span>;
}

export default function Home() {
  return (
    <div className={styles.landing}>
      <a className={styles.skip} href="#main">Skip to content</a>
      <header className={styles.header}>
        <Link href="/" aria-label="AgentPay Treasury home"><Brand /></Link>
        <nav aria-label="Main navigation" className={styles.navigation}>
          <a className={styles.sectionLink} href="#workflow">How it works</a>
          <a className={styles.sectionLink} href="#controls">Your controls</a>
          <Link className={styles.navAction} href="/dashboard">Open workspace <span aria-hidden="true">↗</span></Link>
        </nav>
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><span className={styles.dot} /> ACCOUNTS PAYABLE · ARC TESTNET</p>
            <h1 id="hero-title">Every invoice.<br />A clear <span>decision.</span></h1>
            <p className={styles.intro}>Know what you owe, when to pay, and why. Turn invoice evidence into treasury decisions and verified USDC payments, with your rules in control.</p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/dashboard">Open treasury workspace <span aria-hidden="true">↗</span></Link>
              <a className={styles.secondary} href="#workflow">Explore the workflow <span aria-hidden="true">↓</span></a>
            </div>
            <p className={styles.heroNote}>Operator access code required. Payments use testnet USDC.</p>
          </div>

          <div className={styles.preview} aria-label="Illustrative invoice review example">
            <div className={styles.previewHeading}><span className={styles.eyebrow}>INVOICE TO DECISION</span><span className={styles.example}>Illustrative example</span></div>
            <div className={styles.invoice}>
              <div className={styles.invoiceTop}><span className={styles.documentIcon} aria-hidden="true">≡</span><span>Invoice review<small>Synthetic test vendor</small></span><span className={styles.currency}>USDC</span></div>
              <div className={styles.amount}>0.10 <span>USDC</span></div>
              <div className={styles.invoiceMeta}><span>PO matched</span><span>Due on receipt</span></div>
              <div className={styles.check}><span aria-hidden="true">✓</span> Approved vendor and recipient</div>
              <div className={styles.check}><span aria-hidden="true">✓</span> Accepted purchase order</div>
              <div className={styles.check}><span aria-hidden="true">✓</span> Treasury limits checked</div>
              <div className={styles.decision}><span className={styles.decisionSymbol} aria-hidden="true">↗</span><div><small>NEXT ACTION</small><strong>Review exact payment terms</strong><p>Owner approval required in this example.</p></div></div>
            </div>
            <div className={styles.previewFoot}><span aria-hidden="true">↳</span> Evidence stays with every decision.</div>
          </div>
        </section>

        <div className={styles.stack} aria-label="Application integrations"><span>ONE CONNECTED WORKFLOW</span><p>Gemini <span>Extraction</span></p><p>Circle <span>Wallets</span></p><p>Arc Testnet <span>Settlement</span></p></div>

        <section id="workflow" className={styles.workflow} aria-labelledby="workflow-title">
          <div className={styles.sectionHeading}><p className={styles.eyebrow}>HOW IT WORKS</p><h2 id="workflow-title">From invoice to receipt.<br />Every step accounted for.</h2><p>The workspace brings evidence, financial checks and payment activity together, so you can review the whole story.</p></div>
          <ol className={styles.steps}>{steps.map((step, index) => <li key={step.title}><span className={styles.stepNumber}>0{index + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
        </section>

        <section id="controls" className={styles.controls} aria-labelledby="controls-title">
          <div><p className={styles.eyebrow}>YOUR TREASURY. YOUR RULES.</p><h2 id="controls-title">Delegate the work.<br />Keep the authority.</h2><p>Maintain approved vendors and purchase orders, set financial limits, and pause new submissions from the workspace.</p><Link className={styles.textLink} href="/dashboard">Go to your treasury <span aria-hidden="true">↗</span></Link></div>
          <div className={styles.controlList}>
            <article><span aria-hidden="true">01</span><div><h3>Evidence before payment</h3><p>Missing facts and conflicting records hold an invoice for review. The invoice cannot change your vendor registry.</p></div></article>
            <article><span aria-hidden="true">02</span><div><h3>Limits that approvals respect</h3><p>Exact approvals resolve the automatic payment threshold. Cash reserves, hard caps and duplicate checks still apply.</p></div></article>
            <article><span aria-hidden="true">03</span><div><h3>A record you can follow</h3><p>Inspect decisions, corrections and payment states. Export activity and see settlement only after receipt verification.</p></div></article>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title"><p className={styles.eyebrow}>READY TO REVIEW YOUR PAYABLES?</p><h2 id="closing-title">Give every payment a reason.</h2><Link className={styles.primary} href="/dashboard">Open treasury workspace <span aria-hidden="true">↗</span></Link><p>Arc Testnet environment · Owner maintained registry screening</p></section>
      </main>
      <footer className={styles.footer}><Brand /><p>Invoice evidence. Treasury decisions. Verified settlement.</p><Link href="/dashboard">Workspace <span aria-hidden="true">↗</span></Link></footer>
    </div>
  );
}
