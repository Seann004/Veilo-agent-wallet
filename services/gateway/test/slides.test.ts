import { describe, expect, it } from "vitest";
import { allowedImageUrl, ChromeSlideRenderer, escapeHtml, MAX_SLIDES, parseSlidePlan, slideHtml, type Slide } from "../src/seller-host/slides";

const NO_HOSTS = new Set<string>();
const slide = (over: Partial<Slide> = {}): Slide => ({ label: "hook", headline: "Five repos I use every day", accent: "every day", body: "Small tools.", card: null, score: "", imageUrl: null, ...over });

describe("slide plan", () => {
  it("accepts 2 to 7 slides, drops extras and refuses fewer or a missing headline", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ headline: `slide ${i}` }));
    const p = parseSlidePlan({ slides: many, caption: "c" }, NO_HOSTS);
    expect("slides" in p && p.slides.length).toBe(MAX_SLIDES);
    expect(parseSlidePlan({ slides: [{ headline: "one" }] }, NO_HOSTS)).toHaveProperty("problem");
    expect(parseSlidePlan({ slides: "x" }, NO_HOSTS)).toHaveProperty("problem");
    expect(parseSlidePlan(null, NO_HOSTS)).toHaveProperty("problem");
    expect(parseSlidePlan({ slides: [{ headline: "a" }, { body: "no headline" }] }, NO_HOSTS)).toEqual({ problem: "slide 2 has no headline" });
  });

  it("bounds and flattens every field, keeps a card only with a repo, and drops non-allowlisted images", () => {
    const p = parseSlidePlan(
      {
        slides: [
          { headline: `a\n‮b ${"x".repeat(200)}`, card: { owner: "o", description: "no repo" }, imageUrl: "https://cdn.higgsfield.ai/a.png" },
          { headline: "b", card: { owner: "BurntSushi", repo: "ripgrep", stars: 50000 }, imageUrl: "https://evil.example/a.png" },
        ],
      },
      new Set(["cdn.higgsfield.ai"]),
    );
    if (!("slides" in p)) throw new Error("expected slides");
    expect(p.slides[0]!.headline.length).toBe(90);
    expect(p.slides[0]!.headline).not.toMatch(/[\n‮]/);
    expect(p.slides[0]!.card).toBeNull();
    expect(p.slides[0]!.imageUrl).toBe("https://cdn.higgsfield.ai/a.png");
    expect(p.slides[1]!.card).toMatchObject({ repo: "ripgrep", stars: "50000" });
    expect(p.slides[1]!.imageUrl).toBeNull();
  });

  it("allows only https images on listed hosts with no credentials or port", () => {
    const hosts = new Set(["cdn.higgsfield.ai"]);
    expect(allowedImageUrl("https://cdn.higgsfield.ai/a.png", hosts)).toBe("https://cdn.higgsfield.ai/a.png");
    for (const u of ["http://cdn.higgsfield.ai/a.png", "https://u:p@cdn.higgsfield.ai/a.png", "https://cdn.higgsfield.ai:8443/a.png", "https://cdn.higgsfield.ai.evil.example/a.png", "javascript:alert(1)"]) {
      expect(allowedImageUrl(u, hosts)).toBeNull();
    }
    expect(allowedImageUrl("https://cdn.higgsfield.ai/a.png", NO_HOSTS)).toBeNull();
  });
});

describe("slide template", () => {
  it("escapes model text so it can never become markup", () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
    const html = slideHtml(slide({ headline: "<script>alert(1)</script> wins", accent: "<script>", body: `"><img src=x onerror=alert(1)>`, label: "</style><b>" }), 0, 5, NO_HOSTS);
    expect(html).not.toMatch(/<script|<img|<b>|<\/style><b/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("forbids scripts and every load except allowlisted images", () => {
    expect(slideHtml(slide(), 0, 5, NO_HOSTS)).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src 'none'");
    const html = slideHtml(slide({ imageUrl: "https://cdn.higgsfield.ai/a.png" }), 0, 5, new Set(["cdn.higgsfield.ai"]));
    expect(html).toContain("img-src https://cdn.higgsfield.ai");
    expect(html).toContain('<img alt="" src="https://cdn.higgsfield.ai/a.png">');
  });

  it("lays out the label, accent, repo card and score pill from the slide's values", () => {
    const html = slideHtml(
      slide({ label: "02 · repo", headline: "Fast Search for code", accent: "search", card: { owner: "BurntSushi", repo: "ripgrep", description: "Recursive search", language: "Rust", stars: "50k" }, score: "9" }),
      1,
      6,
      NO_HOSTS,
    );
    expect(html).toContain("<span>02 · repo</span><span>2/6</span>");
    expect(html).toContain('Fast <span class="accent">Search</span> for code');
    expect(html).toContain('<span class="owner">BurntSushi/</span>ripgrep');
    expect(html).toContain("Recursive search");
    expect(html).toContain("Rust");
    expect(html).toContain("★ 50k");
    expect(html).toContain("my score 9 / 10");
    expect(html).toContain("#1f1e1c");
    expect(html).toContain("#dcd9d4");
    expect(html).toContain("#c97b5a");
    expect(slideHtml(slide({ card: { owner: "", repo: "r", description: "", language: "", stars: "" } }), 0, 5, NO_HOSTS)).toContain("my score __ / 10");
    expect(slideHtml(slide(), 0, 5, NO_HOSTS)).not.toContain("my score");
  });
});

// Opt-in: needs installed Chrome. SLIDES_CHROME_TEST=1 pnpm --filter @veilo/gateway test slides
describe.runIf(process.env.SLIDES_CHROME_TEST === "1")("Chrome slide renderer", () => {
  it("renders a 1080x1920 PNG with no network access", async () => {
    const r = new ChromeSlideRenderer();
    try {
      const png = await r.render(slideHtml(slide({ imageUrl: null }), 0, 5, NO_HOSTS), NO_HOSTS);
      expect([...png.slice(0, 4)]).toEqual([137, 80, 78, 71]);
      const view = Buffer.from(png);
      expect(view.readUInt32BE(16)).toBe(1080);
      expect(view.readUInt32BE(20)).toBe(1920);
    } finally {
      await r.close();
    }
  }, 60_000);
});
