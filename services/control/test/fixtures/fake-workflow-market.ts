// TEST ONLY. A one-step workflow on fake marketplace ports; no step is ever advanced or paid.
import { DEMO_TOKEN_MINT, DEVNET_CAIP2 } from "@veilo/contracts";
import { WorkflowRunner, type ExternalPort, type HirePort, type WorkflowMarketPort, type WorkflowVersionFacts } from "../../src/workflows/runner";
import type { Ledger } from "../../src/context";

export const WF_V1 = "11111111-1111-4111-8111-111111111111";
export const WF_V2 = "66666666-6666-4666-8666-666666666666";
export const WF_OWNER = "OwnerPubkey1111111111111111111111111111111";
const STEP = "33333333-3333-4333-8333-333333333333";
const SELLER = "2LWbc9Mi6dRUrdEHBttoNS4udDtH1A4xwBdm1EKqcT57";

export class FakeWorkflowMarket implements WorkflowMarketPort {
  runs = 0;
  /** Changing it after an assignment changes the run terms, so the assignment no longer covers them. */
  recipient = SELLER;
  runInputs: Array<{ name: string; label: string; maxChars: number }> = [{ name: "topic", label: "Topic", maxChars: 500 }];
  version = async (versionId: string): Promise<WorkflowVersionFacts> => ({
    versionId,
    workflowId: `wf-${versionId.slice(0, 4)}`,
    live: true,
    network: DEVNET_CAIP2,
    mint: DEMO_TOKEN_MINT,
    totalMaxBaseUnits: "230000",
    runInputs: this.runInputs,
    steps: [{ toolKind: "listing", toolId: STEP, maxBaseUnits: "230000", inputs: { brief: { from: "run_input", name: "topic" } } }],
    tools: [
      {
        toolKind: "listing",
        toolId: STEP,
        current: true,
        priceBaseUnits: "230000",
        recipient: this.recipient,
        effect: "read_only",
        io: { inputs: [{ name: "brief", kind: "text", required: true, maxChars: 8000 }], output: { kind: "markdown" } },
        listingId: "listing-carousel",
        external: null,
      },
    ],
  });
  async catalogEntry(versionId: string) {
    return versionId === WF_V1 ? { title: "Carousel from a topic", summary: "Researches a topic and drafts a carousel." } : null;
  }
  async createRun() {
    this.runs += 1;
    return { runId: `cloud-${this.runs}` };
  }
  async report() {}
  async deliverable() {
    return { state: "running", artifacts: [] };
  }
  async bindPayer() {}
}

const unused = (): never => {
  throw new Error("no workflow step is advanced in these tests");
};
const hires: HirePort = { hire: unused, approve: unused, status: unused, reject: unused };
const external: ExternalPort = { authorize: unused, drive: unused, signPayer: unused, status: unused };

export function fakeWorkflowRunner(ledger: Ledger, market: FakeWorkflowMarket): WorkflowRunner {
  return new WorkflowRunner({ ledger, market, hires, external, maxRunUsdc: 1_000_000n });
}
