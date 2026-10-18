// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomRunForm } from "../components/CustomAgentFields";
import { fitWithin, referenceFileProblem } from "../lib/reference-image";
import { withRole } from "./access-fixtures";
import { agent } from "./fixtures";

const SCALED = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const downscale = vi.fn(async (_f: Blob) => SCALED);
vi.mock("../lib/reference-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/reference-image")>()),
  downscaleReferenceImage: (f: Blob) => downscale(f),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/agents/x", useParams: () => ({}) }));

const ID = "66666666-6666-4666-8666-666666666666";
let bodies: unknown[];

beforeEach(() => {
  document.cookie = "veilo_csrf=csrf-ref";
  bodies = [];
  downscale.mockClear();
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify({ taskId: "t1", executor: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const scout = () => ({ ...agent(ID, "Scout", "custom"), template: "researcher" as const, instructions: "Make carousels." });
const file = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type });

describe("reference image limits", () => {
  it("accepts only PNG, JPEG and WebP up to 2 MB", () => {
    expect(referenceFileProblem({ type: "image/png", size: 2 * 1024 * 1024 })).toBeNull();
    expect(referenceFileProblem({ type: "image/webp", size: 10 })).toBeNull();
    expect(referenceFileProblem({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(referenceFileProblem({ type: "image/gif", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(referenceFileProblem({ type: "image/jpeg", size: 2 * 1024 * 1024 + 1 })).toMatch(/larger than 2 MB/);
  });

  it("scales the longest side down to 1280 px and never enlarges", () => {
    expect(fitWithin(4000, 2000)).toEqual({ width: 1280, height: 640 });
    expect(fitWithin(900, 3000)).toEqual({ width: 384, height: 1280 });
    expect(fitWithin(64, 64)).toEqual({ width: 64, height: 64 });
  });
});

describe("reference image field", () => {
  it("refuses an SVG or oversized file without reading it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<CustomRunForm agent={scout()} disabled={false} onQueued={vi.fn()} />);
    const input = screen.getByLabelText("Reference image (optional)") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/webp");
    await user.upload(input, file("logo.svg", "image/svg+xml", 100));
    expect(screen.getByRole("alert").textContent).toMatch(/PNG, JPEG or WebP/);
    await user.upload(input, file("big.png", "image/png", 2 * 1024 * 1024 + 1));
    expect(screen.getByRole("alert").textContent).toMatch(/larger than 2 MB/);
    expect(downscale).not.toHaveBeenCalled();
  });

  it("shows a removable thumbnail and sends the resized image with the job", async () => {
    const user = userEvent.setup();
    const onQueued = vi.fn();
    render(<CustomRunForm agent={scout()} disabled={false} onQueued={onQueued} />);
    expect(screen.getByText(/Your AI model reads it to match the style; only your model provider sees it\./)).toBeTruthy();
    const input = screen.getByLabelText("Reference image (optional)") as HTMLInputElement;
    await user.upload(input, file("ref.png", "image/png", 500));
    const thumb = (await screen.findByAltText("Reference image preview")) as HTMLImageElement;
    expect(thumb.getAttribute("src")).toBe(SCALED);
    await user.click(screen.getByRole("button", { name: "Remove reference image" }));
    expect(screen.queryByAltText("Reference image preview")).toBeNull();

    await user.upload(input, file("ref.webp", "image/webp", 500));
    await screen.findByAltText("Reference image preview");
    await user.type(screen.getByLabelText("Message Scout"), "Make a carousel");
    await user.click(screen.getByRole("button", { name: "Send job" }));
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(bodies[0]).toEqual({ objective: "Make a carousel", input: { referenceImage: SCALED } });
    expect(screen.queryByAltText("Reference image preview")).toBeNull();
  });

  it("is not offered to guests", () => {
    render(withRole(<CustomRunForm agent={scout()} disabled={false} onQueued={vi.fn()} />, "guest"));
    expect(screen.queryByLabelText("Reference image (optional)")).toBeNull();
  });
});
