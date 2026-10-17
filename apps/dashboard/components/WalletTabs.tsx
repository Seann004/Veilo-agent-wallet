"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<[string, string]> = [
  ["/wallet", "Funds"],
  ["/recovery", "Recovery"],
  ["/privacy", "Privacy"],
];

export function WalletTabs() {
  const pathname = usePathname();
  return (
    <>
      <div className="page-head">
        <h1>Wallet</h1>
      </div>
      <nav className="tabs" aria-label="Wallet sections">
        {TABS.map(([href, label]) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}
