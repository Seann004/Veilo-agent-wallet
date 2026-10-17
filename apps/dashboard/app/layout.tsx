import type { ReactNode } from "react";
import { Shell } from "../components/Shell";
import "./globals.css";

export const metadata = {
  title: "Veilo",
  description: "Owner workspace for budgeted agents on Solana devnet",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
