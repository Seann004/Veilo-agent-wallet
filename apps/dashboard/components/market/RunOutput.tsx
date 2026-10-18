"use client";

import { useState } from "react";
import { api } from "../../lib/api";
import { describeArtifact, postSentence } from "../../lib/market/artifacts";
import { useResource } from "../hooks";
import { ErrorNotice, Loading } from "../ui";
import { Markdown } from "../Markdown";
import { FullValue, PlainText } from "./parts";

function Collapsible({ children }: { children: React.ReactNode }) {
  const [all, setAll] = useState(false);
  return (
    <>
      <div className={all ? undefined : "output-clamp"}>{children}</div>
      <button type="button" className="btn btn-small" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? "Show less" : "Show all"}
      </button>
    </>
  );
}

/** Thumbnails load only after the owner asks; remote hosts see nothing before that. */
export function ImageGallery({ images }: { images: string[] }) {
  const [loaded, setLoaded] = useState(false);
  if (images.length === 0) return null;
  return (
    <div className="output-gallery">
      {loaded ? (
        <ul className="gallery-grid" aria-label="Generated images">
          {images.map((src, i) => (
            <li key={src}>
              <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${i + 1} full size`}>
                <img src={src} alt={`Generated image ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" width={96} height={96} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" className="btn btn-small" onClick={() => setLoaded(true)}>
          Load images ({images.length})
        </button>
      )}
    </div>
  );
}

function Technical({ kind, sha256, extra }: { kind: string | null; sha256: string; extra?: React.ReactNode }) {
  return (
    <details className="tech-details">
      <summary>Technical details</summary>
      <p className="small">
        Untrusted output ({kind ?? "text"}), sha256 <FullValue value={sha256} />. Links are not opened or loaded.
      </p>
      {extra}
    </details>
  );
}

/** A step's stored output in plain words, loaded on request. */
export function StepOutput({ runId, index }: { runId: string; index: number }) {
  const [open, setOpen] = useState(false);
  const out = useResource(
    () => (open ? api<{ kind: string | null; text: string; sha256: string }>("control", `/workflows/runs/${runId}/steps/${index}/artifact`) : Promise.resolve(null)),
    `run-artifact:${runId}:${index}:${open}`,
  );
  if (!open) {
    return (
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
        Show output
      </button>
    );
  }
  if (out.loading && !out.data) return <Loading label="output" />;
  if (out.error || !out.data) return <ErrorNotice error={out.error} what="the stored output could not be loaded" />;
  const { kind, text, sha256 } = out.data;
  const view = describeArtifact(kind, text);
  const clipped = text.slice(0, 20_000);
  return (
    <div className="artifact step-output">
      {view.type === "markdown" ? (
        <Collapsible>
          <Markdown>{clipped}</Markdown>
        </Collapsible>
      ) : view.type === "gallery" ? (
        <>
          {view.caption ? <PlainText text={view.caption.slice(0, 2000)} /> : null}
          <ImageGallery images={view.images} />
        </>
      ) : view.type === "post" ? (
        <p className="flush">{postSentence(view)}</p>
      ) : (
        <pre className="plain-text">
          <PlainText text={clipped} />
        </pre>
      )}
      <Technical
        kind={kind}
        sha256={sha256}
        extra={view.type === "post" && view.postId ? <p className="small">Post id <span className="mono">{view.postId}</span></p> : null}
      />
    </div>
  );
}
