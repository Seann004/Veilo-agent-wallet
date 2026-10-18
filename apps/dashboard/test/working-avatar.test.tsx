// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bot = vi.hoisted(() => ({ fail: false }));
vi.mock("bot-avatars", () => ({
  botAvatarTypes: ["clover", "flower", "star"],
  BotAvatar: (props: { type: string; state: string }) => {
    if (bot.fail) throw new Error("canvas unavailable");
    return <canvas data-testid="bot" data-type={props.type} data-state={props.state} />;
  },
}));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <canvas /> }));

import { AgentAvatar, WorkingAvatar, botTypeFor } from "../components/Avatar";

const agent = { id: "agent-1", role: "research" } as const;

function media(reduced: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

afterEach(() => {
  cleanup();
  bot.fail = false;
  vi.unstubAllGlobals();
});

describe("WorkingAvatar", () => {
  it("shows the static avatar when idle and the animated bot while working", () => {
    media(false);
    const idle = render(<AgentAvatar agent={agent} size={36} />);
    expect(idle.container.querySelector("img.avatar")).toBeTruthy();
    expect(screen.queryByTestId("bot")).toBeNull();
    cleanup();
    render(<WorkingAvatar agent={agent} />);
    expect(screen.getByTestId("bot").getAttribute("data-state")).toBe("working");
  });

  it("keeps the static avatar when reduced motion is preferred", () => {
    media(true);
    const { container } = render(<WorkingAvatar agent={agent} />);
    expect(screen.queryByTestId("bot")).toBeNull();
    expect(container.querySelector("img.avatar")).toBeTruthy();
  });

  it("falls back to the static avatar if the animation throws", () => {
    media(false);
    bot.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<WorkingAvatar agent={agent} />);
    expect(container.querySelector("img.avatar")).toBeTruthy();
  });

  it("maps an agent to the same bot shape every time", () => {
    expect(botTypeFor("agent-1")).toBe(botTypeFor("agent-1"));
  });
});
