// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentCalendar, ContentEditor, shortTitle, splitOutput } from "../components/Content";
import type { CalendarEntry, ContentItem } from "../lib/types";
import { withRole } from "./access-fixtures";
import { draft, recordingFetch } from "./fixtures";

let rec: ReturnType<typeof recordingFetch>;
beforeEach(() => {
  document.cookie = "veilo_csrf=csrf-test-token";
  rec = recordingFetch((url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith("/review")) return { item: draft({ reviewState: body.state as ContentItem["reviewState"] }) };
    return { item: draft({ revision: 2, lastAuthor: "owner", content: (body.content as string) ?? "Original draft text" }) };
  });
  vi.stubGlobal("fetch", rec.impl);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NON_INFERENCE = [/^\/api\/control\/content\/[0-9a-f-]{36}$/, /^\/api\/control\/content\/[0-9a-f-]{36}\/review$/];

describe("CNT-02 content edits and approval cause no charge", () => {
  it("editing and approving a draft call only the content edit and review endpoints", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(withRole(<ContentEditor item={draft()} onSaved={onSaved} />));
    expect(screen.getByText(/Editing is free: it uses no AI, buys nothing and publishes nothing/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const text = screen.getByLabelText("Draft text");
    await user.clear(text);
    await user.type(text, "Owner revision");
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    await user.click(screen.getByRole("button", { name: "Mark approved for export" }));

    expect(rec.calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    for (const c of rec.calls) {
      expect(NON_INFERENCE.some((re) => re.test(c.url)), c.url).toBe(true);
      expect(c.url).not.toMatch(/run|purchase|usage|gateway|planning|quotes|wallet/);
      expect(c.headers["x-csrf-token"]).toBe("csrf-test-token");
    }
    expect(rec.calls[0]!.body).toEqual({ content: "Owner revision" });
    expect(rec.calls[1]!.body).toEqual({ state: "approved_for_export" });
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("calendar edits patch the calendar only", async () => {
    const user = userEvent.setup();
    const entries: CalendarEntry[] = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, date: `2026-10-${String(16 + i)}`, channel: "LinkedIn", draftArtifactId: null, action: `Plan ${i + 1}` }));
    const cal = draft({ id: "99999999-9999-4999-8999-999999999999", kind: "content_calendar", title: "Calendar", calendar: entries, content: JSON.stringify(entries) });
    render(withRole(<ContentCalendar item={cal} drafts={[]} onSaved={vi.fn()} />));
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    const day3 = screen.getByLabelText("Day 3 planned action");
    await user.clear(day3);
    await user.type(day3, "Repost brief");
    await user.click(screen.getByRole("button", { name: "Save calendar" }));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.method).toBe("PATCH");
    expect(rec.calls[0]!.url).toBe(`/api/control/content/${cal.id}`);
    const sent = (rec.calls[0]!.body as { calendar: CalendarEntry[] }).calendar;
    expect(sent.find((e) => e.day === 3)!.action).toBe("Repost brief");
  });
});

describe("Outputs cards lead with the formatted answer", () => {
  const QUESTION = "explain thetanuts and find out whats the current price of tnuts, in 3 sentences, and also list where you found it please";
  const answer = (extra = "") => `**Thetanuts** is an options protocol.${extra}\n\n— Details —\nTask: ${QUESTION}\nMade with: Your model provider (m), no USDC spent.`;

  it("shows the formatted answer and a short title, with editing and details on request", async () => {
    const user = userEvent.setup();
    render(withRole(<ContentEditor item={draft({ kind: "research_brief", title: QUESTION, content: answer() })} onSaved={vi.fn()} kindLabel="Report" />));
    expect(screen.getByText("Thetanuts").tagName).toBe("STRONG");
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent!.length).toBeLessThanOrEqual(81);
    expect(heading.textContent).toMatch(/…$/);
    expect(screen.queryByLabelText("Draft text")).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    const how = screen.getByText("How it was made").closest("details")!;
    expect(how.open).toBe(false);
    expect(how.textContent).toContain("Made with: Your model provider");
    expect(screen.getByText("Report")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(QUESTION);
    expect((screen.getByLabelText("Draft text") as HTMLTextAreaElement).value).toContain("— Details —");
    expect(screen.getByRole("button", { name: "Mark approved for export" })).toBeTruthy();
    expect(rec.calls).toHaveLength(0);
  });

  it("collapses a long answer behind Show more and copies only the answer", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const long = answer(`\n\n${"More detail about the protocol and its vaults. ".repeat(60)}\n\nFINAL LINE`);
    render(withRole(<ContentEditor item={draft({ kind: "research_brief", content: long })} onSaved={vi.fn()} />));
    expect(screen.queryByText(/FINAL LINE/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText(/FINAL LINE/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toContain("FINAL LINE");
    expect(writeText.mock.calls[0]![0]).not.toContain("— Details —");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("prefers the answer's first heading as the title", () => {
    expect(shortTitle(QUESTION, "## Thetanuts in brief\n\nText")).toBe("Thetanuts in brief");
    expect(shortTitle("Short title", "No heading")).toBe("Short title");
    expect(splitOutput("Only an answer")).toEqual({ answer: "Only an answer", details: [] });
  });
});
