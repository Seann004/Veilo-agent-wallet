// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarPicker, AgentAvatar } from "../components/Avatar";
import { AVATAR_COLOURS } from "../lib/avatar-art";
import { avatarChoice, encodeAvatar, resolveAvatar } from "../lib/avatar-customization";
import { setAgentAvatar } from "../lib/avatars";

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("avatar display preferences", () => {
  it("keeps existing IDs and role defaults usable", () => {
    expect(resolveAvatar("avatar-04").src).toBe("/avatars/avatar-04.svg");
    render(<AgentAvatar agent={{ id: "saved", role: "content" }} />);
    expect(document.querySelector("img")!.getAttribute("src")).toBe("/avatars/avatar-08.svg");
    setAgentAvatar("saved", "avatar-03");
    cleanup();
    render(<AgentAvatar agent={{ id: "saved", role: "content" }} />);
    expect(document.querySelector("img")!.getAttribute("src")).toBe("/avatars/avatar-03.svg");
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
    for (const image of document.querySelectorAll("img")) {
      const source = decodeURIComponent(image.getAttribute("src")!);
      expect(source).toContain('fill="#14a38b"');
      expect(source).toContain("M40 23Q28 6 41 8Q49 7 53 23Z");
      expect(source).toContain('data-accessory="ribbon"');
    }
    cleanup();
    render(<AgentAvatar agent={agent} />);
    expect(document.querySelector("img")!.getAttribute("src")).toBe(resolveAvatar(value).src);
  });

  it("leaves man, non-binary and unspecified choices without a ribbon", () => {
    for (const gender of ["man", "nonbinary", "unspecified"] as const) {
      const value = encodeAvatar({ avatarId: "avatar-08", colour: "#e8457f", presentation: "smooth", gender });
      expect(decodeURIComponent(resolveAvatar(value).src)).not.toContain('data-accessory="ribbon"');
    }
  });

  it("keeps shape, colour, presentation and gender independent, and restores them after remount", async () => {
    const user = userEvent.setup();
    function Editor() {
      const [value, setValue] = useState(window.localStorage.getItem("veilo.avatar.saved") ?? "avatar-09");
      return <AvatarPicker value={value} onChange={(v) => { setValue(v); setAgentAvatar("saved", v); }} />;
    }
    render(<Editor />);
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Blue drop" }));
    await user.click(screen.getByRole("button", { name: "Presentation: Smooth" }));
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Gender (optional): Not specified" }));
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    const saved = window.localStorage.getItem("veilo.avatar.saved")!;
    expect(avatarChoice(saved)).toEqual({ avatarId: "avatar-02", colour: "#14a38b", presentation: "tuft", gender: "nonbinary" });
    expect(encodeAvatar(avatarChoice(saved))).toBe(saved);
    cleanup();
    render(<Editor />);
    expect(screen.getByRole("button", { name: "Presentation: Tuft" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Gender (optional): Non-binary" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(window.localStorage.getItem("veilo.avatar.saved")).toBe("avatar-02");
  });
});
