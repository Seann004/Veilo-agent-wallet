import type { ReactNode } from "react";
import { MarketAccountBar } from "../../../components/market/MarketAccountBar";
import { MarketProvider } from "../../../components/market/MarketContext";

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return (
    <MarketProvider>
      <MarketAccountBar />
      {children}
    </MarketProvider>
  );
}
