import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Veilo",
  description: "Budgeted agents that pay from a private pool on Solana devnet",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
