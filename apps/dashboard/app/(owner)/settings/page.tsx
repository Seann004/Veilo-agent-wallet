import { AiProviderSettings } from "../../../components/AiProviderSettings";
import { PrivacyPanel } from "../../../components/PrivacyPanel";

export default function Settings() {
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <AiProviderSettings />
      <PrivacyPanel />
    </>
  );
}
