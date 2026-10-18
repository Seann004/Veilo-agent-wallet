import type { ReactNode } from "react";
import { ControllerAutoLink } from "../../../components/market/ControllerAutoLink";
import { MarketAccountBar } from "../../../components/market/MarketAccountBar";
import { MarketProvider } from "../../../components/market/MarketContext";

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return (
    <MarketProvider>
      <MarketAccountBar />
      <ControllerAutoLink />
      {children}
    </MarketProvider>
  );
}
