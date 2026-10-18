import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Only web links are followed; anything else (javascript:, data:, relative) is dropped. */
function webUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const COMPONENTS: Components = {
  a({ href, children }) {
    const url = webUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <>
        <a href={url.href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
        <span className="md-host"> ({url.host})</span>
      </>
    );
  },
  // Remote images would let the author track the viewer, so they are shown as text.
  img({ src, alt }) {
    const url = webUrl(typeof src === "string" ? src : undefined);
    const label = alt?.trim() || "image";
    if (!url) return <span className="md-image">[{label}]</span>;
    return (
      <span className="md-image">
        [{label}]{" "}
        <a href={url.href} target="_blank" rel="noopener noreferrer nofollow">
          open image
        </a>
        <span className="md-host"> ({url.host})</span>
      </span>
    );
  },
  input({ checked }) {
    return <input type="checkbox" checked={Boolean(checked)} disabled readOnly />;
  },
};

/** Renders untrusted Markdown. Raw HTML is shown as text, never parsed into elements. */
export function Markdown({ children, className }: { children: string; className?: string }): ReactNode {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} urlTransform={(u) => (webUrl(u) ? u : "")}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Cuts at a paragraph, line or word boundary instead of mid-construct, and closes a
 * code fence the cut left open. Returns the text unchanged when it fits.
 */
export function truncateMarkdown(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const floor = Math.floor(max * 0.5);
  let cut = window.lastIndexOf("\n\n");
  if (cut < floor) cut = window.lastIndexOf("\n");
  if (cut < floor) cut = window.lastIndexOf(" ");
  if (cut < floor) cut = max;
  let out = window.slice(0, cut).trimEnd();
  const fences = out.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) out += "\n```";
  return `${out}\n\n…`;
}
