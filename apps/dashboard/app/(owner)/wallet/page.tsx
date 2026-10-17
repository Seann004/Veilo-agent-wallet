import { ActivityPage } from "../../../components/ActivityPage";
import { RecoveryCenter } from "../../../components/RecoveryCenter";
import { WalletView } from "../../../components/WalletView";
import { WalletTabs } from "../../../components/WalletTabs";

export default function WalletPage() {
  return (
    <>
      <WalletTabs />
      <WalletView />
      <ActivityPage />
      <RecoveryCenter />
    </>
  );
}
