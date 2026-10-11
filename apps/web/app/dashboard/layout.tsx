import type { ReactNode } from "react";
import Link from "next/link";
import "./dashboard.css";
import "./payables.css";

const navItems = [
  { href: "/dashboard", label: "Treasury workspace", icon: "◈", exact: true },
];

export default function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="dash-shell">
      {/* Sidebar */}
      <aside className="dash-sidebar">
        <video
          className="dash-sidebar-video"
          src="/videos/sidebar-bg.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="dash-sidebar-overlay" aria-hidden="true" />
        <Link href="/" className="dash-brand">
          <svg viewBox="0 0 48 48" fill="none">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M23.8588 4.80005L40.8 14.4V33.8824L23.8588 43.2001L7.20001 33.8824V14.4L23.8588 4.80005ZM12.847 17.7883L23.8587 11.2942L34.8705 17.7883L29.7882 20.8942L23.8587 17.2236L18.494 20.8942V33.8825L12.847 30.4942V17.7883Z"
              fill="currentColor"
            />
          </svg>
          <span>AgentPay</span>
        </Link>

        <nav className="dash-nav">
          <p className="dash-nav-label">ACCOUNTS PAYABLE</p>
          {navItems.map((item) => {
            const active = item.exact ? true : false;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`dash-nav-link ${active ? 'active' : ''}`}
              >
                <span className="dash-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="dash-sidebar-foot">
          <div className="dash-flow-mini">
            <span>Invoice</span>→<span>Verify</span>→<span>Decide</span>
          </div>
          <a
            href="https://github.com/hackerjose25/AgentPay.git"
            target="_blank"
            rel="noopener noreferrer"
            className="dash-gh"
          >
            GitHub ↗
          </a>
        </div>
      </aside>

      {/* Main */}
      <div className="dash-main">
        <video
          className="dash-main-video"
          src="/videos/sidebar-bg.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          tabIndex={-1}
        />
        <div className="dash-main-overlay" aria-hidden="true" />
        <main className="dash-content">{children}</main>
      </div>
    </div>
  );
}
