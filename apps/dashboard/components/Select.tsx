"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Themed single-select listbox; replaces the browser's native dropdown. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  required,
}: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (v: T) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  /** Blocks form submission while the value is empty, as a native required select would. */
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLUListElement>(null);
  const autoId = useId();
  const listId = `${id ?? autoId}-list`;
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    listbox.current?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) listbox.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o.value);
    } else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div className="select" ref={root}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${label}: ${current?.label ?? ""}`}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span>{current?.label}</span>
        <Icon name="chevron" size={16} />
      </button>
      {required ? (
        <input className="select-required" tabIndex={-1} aria-hidden="true" required value={value} onChange={() => undefined} onFocus={() => trigger.current?.focus()} />
      ) : null}
      {open ? (
        <ul ref={listbox} tabIndex={-1} onKeyDown={onKey} className="select-menu" role="listbox" id={listId} aria-label={label} aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={i === active ? "select-option active" : "select-option"}
              onMouseMove={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.value)}
            >
              <span>
                {o.label}
                {o.hint ? <span className="select-hint">{o.hint}</span> : null}
              </span>
              {o.value === value ? <Icon name="check" size={16} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
