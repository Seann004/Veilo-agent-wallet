"use client";

import { AVATARS, useAgentAvatar, type AvatarOption } from "../lib/avatars";
import type { Agent } from "../lib/types";

export function AvatarImage({ avatar, size = 36 }: { avatar: AvatarOption; size?: number }) {
  return <img className="avatar" src={avatar.src} alt="" width={size} height={size} />;
}

export function AgentAvatar({ agent, size = 36 }: { agent: Pick<Agent, "id" | "role">; size?: number }) {
  return <AvatarImage avatar={useAgentAvatar(agent.id, agent.role)} size={size} />;
}

export function AvatarPicker({ value, onChange, label = "Avatar" }: { value: string; onChange: (id: string) => void; label?: string }) {
  return (
    <fieldset className="avatar-picker">
      <legend className="sr-only">{label}</legend>
      <div className="avatar-grid" role="radiogroup" aria-label={label}>
        {AVATARS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={a.id === value}
            aria-label={a.label}
            className={a.id === value ? "avatar-option selected" : "avatar-option"}
            onClick={() => onChange(a.id)}
          >
            <AvatarImage avatar={a} size={32} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}
