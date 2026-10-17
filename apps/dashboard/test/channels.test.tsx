// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SendResultsTo, YourChannels, type Channel } from "../components/Channels";
import { matchRoute } from "../lib/server/proxy";
import { withRole } from "./access-fixtures";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
type Call = { url: string; method: string; body: unknown };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(c);
    if (c.url.endsWith("/channels/telegram/chats")) return Response.json({ chats: [{ chatId: "4242", title: "Owner" }] });
    return Response.json({ channel: { id: "c1" } }, { status: 201 });
  });
  return calls;
}

describe("result destinations", () => {
  it("sets up Telegram by finding the chat from the bot, and sends the token only to control", async () => {
    const user = userEvent.setup();
    const calls = serve();
    const onChanged = vi.fn(async () => undefined);
    render(withRole(<SendResultsTo channels={[]} canEdit onChanged={onChanged} />, "owner"));
    await user.click(screen.getByRole("button", { name: "Add Telegram" }));
    await user.type(screen.getByLabelText("Bot token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Find my chat" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/channels/telegram/chats"))).toBe(true));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const save = calls.find((c) => c.url.endsWith("/channels") && c.method === "POST")!;
    expect(save.body).toEqual({ kind: "telegram", label: "My Telegram", botToken: TOKEN, chatId: "4242" });
    expect(calls.every((c) => c.url.startsWith("/api/control/"))).toBe(true);
  });

  it("lists saved destinations by name and hint only, with the agents using them", () => {
    const ch: Channel = { id: "c1", kind: "slack", label: "Team", hint: "webhook …abcd", createdAt: "2026-10-18T00:00:00Z", agentIds: ["a1"] };
    render(withRole(<YourChannels channels={[ch]} agents={[{ id: "a1", name: "Trader" } as never]} canEdit onChanged={async () => undefined} />, "owner"));
    const row = screen.getByText("Team").closest("li")!;
    expect(within(row).getByText(/Slack · webhook …abcd · Used by Trader/)).toBeTruthy();
  });

  it("lets the proxy forward only the destination routes", () => {
    for (const [m, p] of [["GET", "/channels"], ["POST", "/channels"], ["DELETE", "/channels/00000000-0000-4000-8000-000000000001"], ["POST", "/channels/telegram/chats"], ["PUT", "/agents/00000000-0000-4000-8000-000000000001/delivery"]] as const) {
      expect(matchRoute("control", m, p), `${m} ${p}`).toBeTruthy();
    }
    expect(matchRoute("control", "PUT", "/channels/00000000-0000-4000-8000-000000000001")).toBeFalsy();
  });
});
