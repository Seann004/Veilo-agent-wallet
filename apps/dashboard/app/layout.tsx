import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Veilo",
  description: "Budgeted agents that pay from a private pool on Solana devnet",
};

export const viewport = { width: "device-width", initialScale: 1 };

// Applies a saved light/dark choice before first paint; without one the system setting applies.
const THEME_SCRIPT = `try{var t=localStorage.getItem("veilo.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
