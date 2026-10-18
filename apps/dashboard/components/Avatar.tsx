"use client";

import { Component, type ReactNode } from "react";
import { BotAvatar, botAvatarTypes } from "bot-avatars";
import { usePrefersReducedMotion } from "./ThinkingOrb";
import { AVATARS, useAgentAvatar, type AvatarOption } from "../lib/avatars";
import type { Agent } from "../lib/types";
import { AVATAR_COLOURS, GENDERS, PRESENTATIONS } from "../lib/avatar-art";
import { avatarChoice, encodeAvatar } from "../lib/avatar-customization";
import { Select } from "./Select";

/** Shape and colour of the bot for an avatar choice; the same mapping serves static and animated spots. */
export function botFor(avatar: AvatarOption): { type: (typeof botAvatarTypes)[number]; colour: string } {
  const choice = avatarChoice(avatar.id);
  const index = Math.max(0, AVATARS.findIndex((a) => a.id === choice.avatarId));
  return { type: botAvatarTypes[index % botAvatarTypes.length]!, colour: choice.colour };
}

class AnimationBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function BotFace({ avatar, size, paused }: { avatar: AvatarOption; size: number; paused: boolean }) {
  const { type, colour } = botFor(avatar);
  return (
    <span className="working-avatar" data-bot={type} aria-hidden={paused ? true : undefined} style={{ width: size, height: size }}>
      <BotAvatar type={type} state={paused ? "default" : "working"} paused={paused} size={size} color={colour} />
    </span>
  );
}

/** Static avatar: the paused bot, so it matches the animated one; a flat image only if the canvas fails. */
export function AvatarImage({ avatar, size = 36 }: { avatar: AvatarOption; size?: number }) {
  const fallback = <img className="avatar" src={avatar.src} alt="" width={size} height={size} />;
  return (
    <AnimationBoundary fallback={fallback}>
      <BotFace avatar={avatar} size={size} paused />
    </AnimationBoundary>
  );
}

export function AgentAvatar({ agent, size = 36 }: { agent: Pick<Agent, "id" | "role">; size?: number }) {
  return <AvatarImage avatar={useAgentAvatar(agent.id, agent.role)} size={size} />;
}

/** Animated avatar for an agent that is working; static when motion is reduced or the animation fails. */
export function WorkingAvatar({ agent, size = 48 }: { agent: Pick<Agent, "id" | "role">; size?: number }) {
  const avatar = useAgentAvatar(agent.id, agent.role);
  const reduced = usePrefersReducedMotion();
  if (reduced) return <AvatarImage avatar={avatar} size={size} />;
  return (
    <AnimationBoundary fallback={<img className="avatar" src={avatar.src} alt="" width={size} height={size} />}>
      <span role="img" aria-label="Working">
        <BotFace avatar={avatar} size={size} paused={false} />
      </span>
    </AnimationBoundary>
  );
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
      <p className="hint">Woman adds a pink ribbon. Other choices have no ribbon. Choose any colour or presentation; these choices don’t change how the agent works.</p>
      <button type="button" className="link-btn" onClick={() => onChange(choice.avatarId)}>Reset appearance</button>
    </fieldset>
  );
}
