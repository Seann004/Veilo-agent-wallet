// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orb = vi.hoisted(() => vi.fn());
vi.mock("thinking-orbs", () => ({
  ThinkingOrb: (props: Record<string, unknown>) => {
    orb(props);
    return <canvas data-testid="orb" />;
  },
}));

import { AgentThinking } from "../components/ThinkingOrb";

function stubMedia(matches: Record<string, boolean>) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: matches[q] ?? false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  cleanup();
  orb.mockClear();
  vi.unstubAllGlobals();
});

describe("AgentThinking", () => {
  it("maps app situations to orb states and labels the status", () => {
    stubMedia({});
    const cases = [
      ["working", "working"],
      ["searching", "searching"],
      ["planning", "solving"],
      ["connecting", "connecting"],
      ["composing", "composing"],
      ["waiting", "breathing"],
    ] as const;
    for (const [kind, state] of cases) {
      orb.mockClear();
      render(<AgentThinking state={kind} label={`Doing ${kind}`} />);
      expect(screen.getByRole("status").textContent).toContain(`Doing ${kind}`);
      expect(orb.mock.calls.at(-1)![0]).toMatchObject({ state, paused: false });
      cleanup();
    }
  });

  it("pauses when the user prefers reduced motion", () => {
    stubMedia({ "(prefers-reduced-motion: reduce)": true });
    render(<AgentThinking label="Working" />);
    expect(orb.mock.calls.at(-1)![0]).toMatchObject({ paused: true });
  });

  it("follows the dark theme", () => {
    stubMedia({ "(prefers-color-scheme: dark)": true });
    render(<AgentThinking label="Working" />);
    expect(orb.mock.calls.at(-1)![0]).toMatchObject({ theme: "dark" });
  });

  it("can be decorative when nearby text already announces the wait", () => {
    stubMedia({});
    render(<AgentThinking label="Working" decorative />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
