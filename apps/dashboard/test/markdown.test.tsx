// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, truncateMarkdown } from "../components/Markdown";

afterEach(cleanup);

describe("Markdown", () => {
  it("renders headings, bold, lists, quotes and rules as elements", () => {
    const { container } = render(<Markdown>{"# Title\n\n**bold** text\n\n- one\n- two\n\n> quoted\n\n---\n"}</Markdown>);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(container.querySelector("hr")).toBeTruthy();
    expect(container.textContent).not.toContain("**");
  });

  it("shows raw HTML as text instead of creating elements", () => {
    const { container } = render(<Markdown>{'hi <script>alert(1)</script> <img src="https://t.example/p.png" onerror="x()">'}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("does not link javascript: or data: URLs", () => {
    const { container } = render(<Markdown>{"[a](javascript:alert(1)) [b](data:text/html,x) [c](/relative)"}</Markdown>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("a");
  });

  it("opens web links safely and shows the host", () => {
    const { container } = render(<Markdown>{"[docs](https://docs.example.com/x)"}</Markdown>);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://docs.example.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(container.textContent).toContain("(docs.example.com)");
  });

  it("never loads remote images", () => {
    const { container } = render(<Markdown>{"![tracker](https://t.example/p.png) ![x](javascript:alert(1))"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[tracker]");
    expect(container.textContent).toContain("(t.example)");
  });
});

describe("truncateMarkdown", () => {
  it("leaves short text alone and cuts at a paragraph boundary", () => {
    expect(truncateMarkdown("short", 900)).toBe("short");
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
    expect(truncateMarkdown(text, 150)).toBe(`${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n…`);
  });

  it("closes a code fence left open by the cut", () => {
    const out = truncateMarkdown(`intro\n\n\`\`\`\n${"x ".repeat(100)}`, 80);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });
});
