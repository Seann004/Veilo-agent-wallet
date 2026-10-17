import Link from "next/link";
import type { ReactNode } from "react";

export function SiteNav({ current }: { current?: "marketplace" | undefined }) {
  return (
    <header className="site-nav">
      <Link href="/" className="brand">
        <span className="logo" aria-hidden="true">
          ◆
        </span>
        Veilo
      </Link>
      <nav aria-label="Site">
        <ul className="site-links">
          <li>
            <Link href="/#product">Product</Link>
          </li>
          <li>
            <Link href="/marketplace" aria-current={current === "marketplace" ? "page" : undefined}>
              Marketplace
            </Link>
          </li>
          <li>
            <Link href="/#faq">FAQ</Link>
          </li>
        </ul>
      </nav>
      <div className="site-cta">
        <Link href="/workspace" className="btn btn-ghost-sm">
          Sign in
        </Link>
        <Link href="/workspace" className="btn btn-primary">
          Open workspace
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>
        <span className="logo" aria-hidden="true">
          ◆
        </span>{" "}
        Veilo · Solana devnet only · test-USDC, no real funds
      </span>
      <span>
        <Link href="/marketplace">Marketplace</Link> · <Link href="/workspace">Workspace</Link> · <Link href="/#faq">FAQ</Link>
      </span>
    </footer>
  );
}

export function SitePage({ children, current }: { children: ReactNode; current?: "marketplace" | undefined }) {
  return (
    <div className="site">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteNav current={current} />
      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
