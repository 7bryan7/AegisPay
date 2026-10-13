'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { getWalletAccountId, subscribeWalletAccount } from '../lib/wallet-store';

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

export default function Navbar() {
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [connectedAccountId, setConnectedAccountId] = useState<string | null>(null);
  const pairingInFlight = useRef(false);

  useEffect(() => {
    let lastY = 0;
    const onScroll = () => {
      const y = window.scrollY;
      document.body.classList.toggle('scroll-min', y > 100);
      document.body.classList.toggle('scroll-down', y > lastY && y > 300);
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setConnectedAccountId(getWalletAccountId());
    const unsubscribe = subscribeWalletAccount(setConnectedAccountId);
    void import('../lib/hashpack-wallet')
      .then(({ restoreWalletConnection }) => restoreWalletConnection({ projectId: walletConnectProjectId, origin: window.location.origin }))
      .catch(() => { /* keep current state */ });
    return unsubscribe;
  }, []);

  function connectWallet(): void {
    if (pairingInFlight.current) {
      setModalOpen(true);
      return;
    }
    pairingInFlight.current = true;
    setBusy(true);
    setWalletError(null);
    setPairingUri(null);
    setModalOpen(true);
    void (async () => {
      try {
        if (!window.agentPayWallet) {
          const { installHashPackWallet } = await import('../lib/hashpack-wallet');
          installHashPackWallet({ projectId: walletConnectProjectId, origin: window.location.origin });
        }
        const wallet = window.agentPayWallet;
        if (!wallet) throw new Error('HashPack wallet adapter is unavailable.');
        await wallet.connect({ onPairingUri: setPairingUri });
        setModalOpen(false);
      } catch (error) {
        setWalletError(error instanceof Error ? error.message : 'Wallet connection failed.');
      } finally {
        pairingInFlight.current = false;
        setBusy(false);
        setPairingUri(null);
      }
    })();
  }

  function disconnectWallet(): void {
    void window.agentPayWallet?.disconnect?.();
  }

  return (
    <nav className="navbar">
      <div className="nav-inner">
      <a href="#" className="brand">
        <svg viewBox="0 0 48 48" fill="none">
          <path fillRule="evenodd" clipRule="evenodd" d="M23.8588 4.80005L40.8 14.4V33.8824L23.8588 43.2001L7.20001 33.8824V14.4L23.8588 4.80005ZM12.847 17.7883L23.8587 11.2942L34.8705 17.7883L29.7882 20.8942L23.8587 17.2236L18.494 20.8942V33.8825L12.847 30.4942V17.7883Z" fill="currentColor"/>
        </svg>
        <span className="brand-text">AgentPay</span>
      </a>

      <div className="nav-actions">
        <div className="open-contact">
          <Link href="/dashboard" style={{ marginRight: '1.25rem', color: '#ceff45', textDecoration: 'none', fontWeight: 600, fontSize: '0.95rem' }}>Dashboard</Link>
          <a href="https://github.com/hackerjose25/AgentPay.git" target="_blank" rel="noopener noreferrer">GitHub</a>
        </div>

        {connectedAccountId ? (
          <button className="nav-wallet-btn connected" onClick={disconnectWallet} title="Disconnect HashPack">
            <span className="wallet-dot"></span>
            <span className="wallet-pill-addr">{connectedAccountId}</span>
          </button>
        ) : (
          <button className="nav-wallet-btn" onClick={connectWallet} disabled={busy}>
            <span className="wallet-dot"></span>
            <span className="wallet-text-full">{busy ? 'Connecting…' : 'Connect Wallet'}</span>
            <span className="wallet-text-short">Connect</span>
          </button>
        )}
      </div>

      <button className="toggler" id="toggler"></button>
      </div>

      {modalOpen && (
        <div className="wallet-modal-overlay" role="dialog" aria-modal="true" aria-label="Connect HashPack">
          <div className="wallet-modal-container">
            <div className="wallet-modal-card">
              <div className="wallet-modal-header">
                <div>
                  <span className="wallet-modal-sub">Hedera Testnet</span>
                  <h3 className="wallet-modal-title">Connect HashPack</h3>
                </div>
                <button className="wallet-modal-close" onClick={() => setModalOpen(false)} aria-label="Close">×</button>
              </div>
              {walletError ? (
                <>
                  <p className="wallet-modal-desc">{walletError}</p>
                  <button className="nav-wallet-btn" onClick={connectWallet} disabled={busy}>Try again</button>
                </>
              ) : pairingUri ? (
                <>
                  <div className="wallet-qr-box">
                    <QRCodeSVG value={pairingUri} size={200} marginSize={2} title="HashPack WalletConnect pairing code" />
                  </div>
                  <p className="wallet-modal-desc">Open HashPack, choose WalletConnect, and scan this code. Approve Hedera Testnet only.</p>
                </>
              ) : (
                <p className="wallet-modal-desc">Generating the pairing QR code…</p>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}