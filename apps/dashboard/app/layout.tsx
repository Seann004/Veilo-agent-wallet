import type { ReactNode } from "react";

export const metadata = {
  title: "Veilo",
  description: "Owner workspace for budgeted agents on Solana devnet",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
