import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentPay Treasury — Accounts Payable",
  description: "Invoice verification and treasury decisions for an Arc Testnet accounts-payable workflow under development.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="home" data-anim-duration="500" data-anim-delay="500">
        {children}
      </body>
    </html>
  );
}
