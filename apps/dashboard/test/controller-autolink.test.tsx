// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerAutoLink } from "../components/market/ControllerAutoLink";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { clearResourceCache } from "../components/hooks";
import { recordingFetch } from "./fixtures";

afterEach(() => {
  cleanup();
  clearResourceCache();
  vi.unstubAllGlobals();
});

const LOCAL = { configured: true, marketplaceUrl: "http://127.0.0.1:4106", controllerKey: "CtrlKey111", keyId: "ctl_1", registration: null };
const REG = { controllerKey: "CtrlKey111", keyId: "ctl_1", proof: "proof" };

function market(controllerKeyId: string | null, call: ReturnType<typeof vi.fn>): MarketContextValue {
  return {
    me: { userId: "user-1", workspace: { id: "ws-1", controller_key_id: controllerKeyId, controller_key: controllerKeyId ? "OtherKey" : null } },
    canAct: true,
    call,
    reloadMe: async () => undefined,
  } as unknown as MarketContextValue;
}

async function mount(controllerKeyId: string | null, local: Record<string, unknown> = LOCAL) {
  const rec = recordingFetch((url) => (url.includes("/registration") ? REG : local));
  vi.stubGlobal("fetch", rec.impl);
  const call = vi.fn(async () => ({}));
  await act(async () => {
    render(
      <MarketContextProvider value={market(controllerKeyId, call)}>
        <ControllerAutoLink />
      </MarketContextProvider>,
    );
  });
  return { rec, call };
}

describe("controller auto-link", () => {
  it("links this computer's controller once when the marketplace workspace has none", async () => {
    const { rec, call } = await mount(null);
    expect(rec.calls.filter((c) => c.url.endsWith("/marketplace/controller/registration"))).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("/me/controller", { method: "POST", body: REG });
  });

  it("never replaces a controller that is already linked", async () => {
    const { rec, call } = await mount("ctl_other");
    expect(rec.calls.some((c) => c.url.includes("/registration"))).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("never moves this computer's controller away from another marketplace workspace", async () => {
    const { rec, call } = await mount(null, { ...LOCAL, registration: { cloudWorkspaceId: "ws-other", cloudUserId: "user-2" } });
    expect(rec.calls.some((c) => c.url.includes("/registration"))).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("re-links to the workspace it was already registered with", async () => {
    const { call } = await mount(null, { ...LOCAL, registration: { cloudWorkspaceId: "ws-1", cloudUserId: "user-1" } });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
