import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="site-footer">
      <video id="footer-video" muted loop autoPlay playsInline preload="none">
        <source src="/videos/footer.mp4" type="video/mp4" />
      </video>

      <div className="content">
        <h2>
          API keys make agents<br />
          dependent on humans.<br />
          <span>x402 makes them independent.</span>
        </h2>
        <p>
          ENSv2 discovers. Readiness verifies. AI decides. Hedera settles. x402 unlocks.
        </p>
        <a
          className="btn solid mask-bt loop"
          href="https://github.com/hackerjose25/AgentPay.git"
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="container"><span>View Source on GitHub</span></div>
        </a>
      </div>

      <div className="end">
        <div className="copy">AgentPay</div>
        <ul className="links">
          <li><Link href="/dashboard">Console</Link></li>
          <li><a href="https://hashscan.io/testnet" target="_blank" rel="noopener noreferrer">HashScan</a></li>
          <li><a href="https://portal.hedera.com/faucet" target="_blank" rel="noopener noreferrer">Faucet</a></li>
          <li><a href="https://x402.org" target="_blank" rel="noopener noreferrer">x402</a></li>
        </ul>
      </div>
    </footer>
  );
}