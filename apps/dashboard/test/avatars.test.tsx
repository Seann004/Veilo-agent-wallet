// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bot-avatars", () => ({
  botAvatarTypes: ["clover", "flower", "star"],
  BotAvatar: (props: { type: string; color?: string }) => <canvas data-testid="bot" data-type={props.type} data-color={props.color} />,
}));
import { AvatarPicker, AgentAvatar } from "../components/Avatar";
import { AVATAR_COLOURS } from "../lib/avatar-art";
import { avatarChoice, encodeAvatar, resolveAvatar } from "../lib/avatar-customization";
import { setAgentAvatar } from "../lib/avatars";

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("avatar display preferences", () => {
  it("keeps existing IDs and role defaults usable", () => {
    expect(resolveAvatar("avatar-04").src).toBe("/avatars/avatar-04.svg");
    render(<AgentAvatar agent={{ id: "saved", role: "content" }} />);
    expect(screen.getByTestId("bot").getAttribute("data-type")).toBe("flower");
    expect(screen.getByTestId("bot").getAttribute("data-color")).toBe(avatarChoice("avatar-08").colour);
    setAgentAvatar("saved", "avatar-03");
    cleanup();
    render(<AgentAvatar agent={{ id: "saved", role: "content" }} />);
    expect(screen.getByTestId("bot").getAttribute("data-type")).toBe("star");
    expect(screen.getByTestId("bot").getAttribute("data-color")).toBe(avatarChoice("avatar-03").colour);
  });

  it("rejects corrupt storage values and SVG injection", () => {
    const choice = avatarChoice(JSON.stringify({ avatarId: "missing", colour: '"><script>alert(1)</script>', presentation: "evil", gender: "evil" }));
    expect(choice).toEqual({ avatarId: "avatar-01", colour: AVATAR_COLOURS[0]!.value, presentation: "smooth", gender: "unspecified" });
    expect(decodeURIComponent(resolveAvatar(JSON.stringify(choice)).src)).not.toContain("<script");
    expect(avatarChoice("null")).toEqual(choice);
    expect(avatarChoice("[]")).toEqual(choice);
  });

  it("updates every mounted avatar and restores customized artwork after remount", () => {
    const agent = { id: "saved", role: "research" as const };
    const value = encodeAvatar({ avatarId: "avatar-02", colour: "#14a38b", presentation: "tuft", gender: "woman" });
    render(<><AgentAvatar agent={agent} /><AgentAvatar agent={agent} /></>);
    act(() => setAgentAvatar(agent.id, value));
    for (const bot of screen.getAllByTestId("bot")) {
      expect(bot.getAttribute("data-color")).toBe("#14a38b");
      expect(bot.getAttribute("data-type")).toBe("flower");
    }
    cleanup();
    render(<AgentAvatar agent={agent} />);
    expect(screen.getByTestId("bot").getAttribute("data-color")).toBe("#14a38b");
  });

  it("leaves man, non-binary and unspecified choices without a ribbon", () => {
    for (const gender of ["man", "nonbinary", "unspecified"] as const) {
      const value = encodeAvatar({ avatarId: "avatar-08", colour: "#e8457f", presentation: "smooth", gender });
      expect(decodeURIComponent(resolveAvatar(value).src)).not.toContain('data-accessory="ribbon"');
    }
  });

  it("keeps shape and colour independent, offers no gender or presentation, and restores them after remount", async () => {
    const user = userEvent.setup();
    function Editor() {
      const [value, setValue] = useState(window.localStorage.getItem("veilo.avatar.saved") ?? "avatar-09");
      return <AvatarPicker value={value} onChange={(v) => { setValue(v); setAgentAvatar("saved", v); }} />;
    }
    render(<Editor />);
    expect(screen.queryByRole("button", { name: /Presentation/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gender/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Blue drop" }));
    const saved = window.localStorage.getItem("veilo.avatar.saved")!;
    expect(avatarChoice(saved)).toMatchObject({ avatarId: "avatar-02", colour: "#14a38b" });
    expect(encodeAvatar(avatarChoice(saved))).toBe(saved);
    cleanup();
    render(<Editor />);
    expect(screen.getByRole("button", { name: "Teal" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(window.localStorage.getItem("veilo.avatar.saved")).toBe("avatar-02");
  });
});
