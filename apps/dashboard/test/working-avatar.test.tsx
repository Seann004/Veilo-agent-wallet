// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const bot = vi.hoisted(() => ({ fail: false }));
vi.mock("bot-avatars", () => ({
  botAvatarTypes: ["clover", "flower", "star"],
  BotAvatar: (props: { type: string; state: string; paused?: boolean; color?: string }) => {
    if (bot.fail) throw new Error("canvas unavailable");
    return <canvas data-testid="bot" data-type={props.type} data-state={props.state} data-paused={String(!!props.paused)} data-color={props.color} />;
  },
}));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <canvas /> }));

import { AgentAvatar, WorkingAvatar, botFor } from "../components/Avatar";

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
  it("shows the same bot paused when idle and animated while working", () => {
    media(false);
    render(<AgentAvatar agent={agent} size={36} />);
    const idle = screen.getByTestId("bot");
    expect(idle.getAttribute("data-paused")).toBe("true");
    const shape = idle.getAttribute("data-type");
    const colour = idle.getAttribute("data-color");
    cleanup();
    render(<WorkingAvatar agent={agent} />);
    const live = screen.getByTestId("bot");
    expect(live.getAttribute("data-state")).toBe("working");
    expect(live.getAttribute("data-paused")).toBe("false");
    expect(live.getAttribute("data-type")).toBe(shape);
    expect(live.getAttribute("data-color")).toBe(colour);
  });

  it("keeps the static avatar when reduced motion is preferred", () => {
    media(true);
    const { container } = render(<WorkingAvatar agent={agent} />);
    expect(screen.getByTestId("bot").getAttribute("data-paused")).toBe("true");
    expect(container.querySelector("img.avatar")).toBeNull();
  });

  it("falls back to the static avatar if the animation throws", () => {
    media(false);
    bot.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(<WorkingAvatar agent={agent} />);
    expect(container.querySelector("img.avatar")).toBeTruthy();
  });

  it("maps an avatar choice to a stable bot shape and its colour", () => {
    const a = { id: "avatar-02", src: "", label: "" };
    expect(botFor(a)).toEqual(botFor(a));
    expect(botFor(a).type).not.toBe(botFor({ id: "avatar-03", src: "", label: "" }).type);
  });
});
