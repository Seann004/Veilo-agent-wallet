"use client";

import { AVATARS, useAgentAvatar, type AvatarOption } from "../lib/avatars";
import type { Agent } from "../lib/types";
import { AVATAR_COLOURS, GENDERS, PRESENTATIONS } from "../lib/avatar-art";
import { avatarChoice, encodeAvatar } from "../lib/avatar-customization";
import { Select } from "./Select";

export function AvatarImage({ avatar, size = 36 }: { avatar: AvatarOption; size?: number }) {
  return <img className="avatar" src={avatar.src} alt="" width={size} height={size} />;
}

export function AgentAvatar({ agent, size = 36 }: { agent: Pick<Agent, "id" | "role">; size?: number }) {
  return <AvatarImage avatar={useAgentAvatar(agent.id, agent.role)} size={size} />;
}

export function AvatarPicker({ value, onChange, label = "Avatar" }: { value: string; onChange: (id: string) => void; label?: string }) {
  const choice = avatarChoice(value);
  const update = (patch: Partial<typeof choice>) => onChange(encodeAvatar({ ...choice, ...patch }));
  return (
    <fieldset className="avatar-picker">
      <legend>{label}</legend>
      <p className="hint">Shape</p>
      <div className="avatar-grid" role="group" aria-label={`${label} shape`}>
        {AVATARS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={a.id === choice.avatarId}
            aria-label={a.label}
            className={a.id === choice.avatarId ? "avatar-option selected" : "avatar-option"}
            onClick={() => update({ avatarId: a.id })}
          >
            <AvatarImage avatar={a} size={32} />
          </button>
        ))}
      </div>
      <p className="hint">Colour</p>
      <div className="avatar-grid" role="group" aria-label={`${label} colour`}>
        {AVATAR_COLOURS.map((colour) => (
          <button key={colour.value} type="button" className={`avatar-option${choice.colour === colour.value ? " selected" : ""}`}
            aria-label={colour.label} aria-pressed={choice.colour === colour.value} onClick={() => update({ colour: colour.value })}>
            <span className="avatar-swatch" style={{ backgroundColor: colour.value }} />
          </button>
        ))}
      </div>
      <div className="avatar-custom-fields">
        <div className="field">
          <span className="small">Presentation</span>
          <Select label="Presentation" value={choice.presentation} options={[...PRESENTATIONS]} onChange={(presentation) => update({ presentation })} />
        </div>
        <div className="field">
          <span className="small">Gender (optional)</span>
          <Select label="Gender (optional)" value={choice.gender} options={[...GENDERS]} onChange={(gender) => update({ gender })} />
        </div>
      </div>
      <p className="hint">Gender is a display preference. Choose any colour or presentation; these choices don’t change how the agent works.</p>
      <button type="button" className="link-btn" onClick={() => onChange(choice.avatarId)}>Reset appearance</button>
    </fieldset>
  );
}
