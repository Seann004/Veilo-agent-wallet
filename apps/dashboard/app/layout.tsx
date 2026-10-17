import Script from "next/script";
import type { ReactNode } from "react";
import { upstreamConfig } from "../lib/server/upstream";
import "./globals.css";

export const metadata = {
  metadataBase: new URL(upstreamConfig().dashboardOrigin),
  title: "Veilo",
  description: "Budgeted agents that pay from a private pool on Solana devnet",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Applies a saved light/dark choice before hydration; without one the system setting applies. Served as a file so no source renders raw HTML. */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
