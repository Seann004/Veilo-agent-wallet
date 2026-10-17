"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/**
 * Modal dialog or side drawer. Focus moves inside on open, Tab stays inside, Escape closes, and
 * focus returns to whatever was focused before it opened.
 */
export function Modal({
  title,
  onClose,
  children,
  variant = "dialog",
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  variant?: "dialog" | "drawer";
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    // Listens on the document so Escape and Tab still work after the focused control unmounts.
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (!box) return;
      if (e.key === "Escape") {
        // An open menu, listbox or confirm step inside handles its own Escape first.
        if (e.defaultPrevented) return;
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.closest("details:not([open]) > :not(summary), [hidden]"));
      const firstItem = items[0];
      const lastItem = items.at(-1);
      if (!firstItem || !lastItem) return;
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === firstItem)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === lastItem)) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <div className={variant === "drawer" ? "drawer-backdrop" : "modal-backdrop"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={variant === "drawer" ? "drawer modal-drawer" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
