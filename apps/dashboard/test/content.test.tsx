// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentCalendar, ContentEditor } from "../components/Content";
import type { CalendarEntry, ContentItem } from "../lib/types";
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
    render(<ContentEditor item={draft()} onSaved={onSaved} />);
    expect(screen.getByText(/No charge: editing, review changes and calendar edits run no inference/)).toBeTruthy();

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
    render(<ContentCalendar item={cal} drafts={[]} onSaved={vi.fn()} />);
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
