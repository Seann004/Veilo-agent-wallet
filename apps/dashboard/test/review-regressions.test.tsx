// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchForm, CampaignForm } from "../components/AgentDetail";
import { CreateAgent } from "../components/CreateAgent";
import { Select } from "../components/Select";
import { PolicyReview, ROLE_TEMPLATES } from "../components/Policy";
import { withRole } from "./access-fixtures";
import { useAction } from "../components/hooks";
import { agent, MIRA, PRINCE, recordingFetch, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/agents/new", useParams: () => ({}) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.localStorage.clear(); });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("adversarial dashboard regression checks", () => {
  it("shows top-up rules only for a complete credit-manager configuration", () => {
    const policy = workspace().policies[0]!;
    render(<PolicyReview policy={{ ...policy, roleConfig: {} }} title="Researcher" workspacePolicy={undefined} />);
    expect(screen.queryByText("Top-up rule")).toBeNull();
    expect(document.body.textContent).not.toContain("undefined");
    cleanup();
    render(<PolicyReview policy={ROLE_TEMPLATES.credit_manager.policy} title="Credit manager" workspacePolicy={undefined} />);
    expect(screen.getByText("Top-up rule")).toBeTruthy();
    expect(screen.getByText(/checks every 60 s/)).toBeTruthy();
  });
  it("preserves reviewed limits and approval requirements after Back and later edits", async () => {
    // Without a marketplace origin the connector step makes no catalog requests, so the create POST is the only call.
    vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", "");
    const user = userEvent.setup();
    const rec = recordingFetch(() => ({ agent: agent(PRINCE, "Review companion", "research", "draft") }));
    vi.stubGlobal("fetch", rec.impl);
    render(withRole(<CreateAgent />));
    await user.type(screen.getByLabelText("Name"), "Review companion");
    await user.clear(screen.getByLabelText("Total budget"));
    await user.type(screen.getByLabelText("Total budget"), "1.5");
    await user.click(screen.getByRole("button", { name: "How it spends: Automatically, within limits" }));
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Private pool (USDC)" }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Total budget") as HTMLInputElement).value).toBe("1.50");
    expect(screen.getByRole("button", { name: "How it spends: Needs approval" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Private pool (USDC)" }).getAttribute("aria-pressed")).toBe("false");
    await user.clear(screen.getByLabelText("Per task"));
    await user.type(screen.getByLabelText("Per task"), "0.3");
    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.body).toMatchObject({ policy: { tier: "approval_required", lifetimeTestUsdc: "1500000", taskLimitTestUsdc: "300000", allowedPaymentPaths: ["prepaid_credits"] } });
  });

  it("allows only one in-flight action even before React renders busy, and unlocks after failure", async () => {
    const pending = deferred<void>();
    const first = vi.fn(() => pending.promise);
    const second = vi.fn(async () => "second");
    const { result } = renderHook(() => useAction());
    let run!: Promise<void | undefined>;
    await act(async () => {
      run = result.current.run(first);
      await result.current.run(second);
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("not ready")); await run; });
    expect(result.current.busy).toBe(false);
    expect(result.current.error?.message).toBe("not ready");
    await act(async () => { await result.current.run(second); });
    expect(second).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeUndefined();
  });

  it.each(["research", "campaign"] as const)("does not queue another %s task during a pending request", async (role) => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    const a = agent(role === "research" ? PRINCE : MIRA, "Companion", role === "research" ? "research" : "content");
    if (role === "research") render(withRole(<ResearchForm agent={a} disabled={false} onQueued={() => undefined} />));
    else render(withRole(<CampaignForm agent={a} disabled={false} handoffs={[]} onQueued={() => undefined} />));
    const topic = screen.getByLabelText(role === "research" ? "Research question" : "Campaign topic");
    await user.type(topic, "Review the brief");
    if (role === "campaign") {
      await user.click(screen.getByText("Audience, channels, voice and dates"));
      for (const label of ["Audience", "Channel 1", "Channel 2", "Channel 3", "Voice"]) await user.type(screen.getByRole("textbox", { name: new RegExp(`^${label}`) }), "Owner request");
    }
    await user.click(screen.getByRole("button", { name: role === "research" ? "Start research task" : "Start campaign task" }));
    expect((topic as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.submit(topic.closest("form")!);
    fireEvent.submit(topic.closest("form")!);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(Response.json({ taskId: "queued-once", executor: "queued" })); });
    await waitFor(() => expect((topic as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("focuses the select listbox, announces its keyboard option, and restores the trigger", async () => {
    const user = userEvent.setup();
    function Choice() {
      const [value, setValue] = useState("one");
      return <><Select label="Choice" value={value} onChange={setValue} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} /><button>Next</button></>;
    }
    render(<Choice />);
    const trigger = screen.getByRole("button", { name: "Choice: One" });
    await user.click(trigger);
    const list = screen.getByRole("listbox", { name: "Choice" });
    expect(document.activeElement).toBe(list);
    // A popup appearing under a stationary pointer must not move keyboard selection.
    fireEvent.mouseEnter(screen.getByRole("option", { name: "Two" }));
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent).toBe("One");
    await user.keyboard("{End}");
    expect(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent).toBe("Two");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toBe("Two");
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
