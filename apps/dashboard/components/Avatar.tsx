"use client";

import { Component, type ReactNode } from "react";
import { BotAvatar, botAvatarTypes } from "bot-avatars";
import { usePrefersReducedMotion } from "./ThinkingOrb";
import { AVATARS, useAgentAvatar, type AvatarOption } from "../lib/avatars";
import type { Agent } from "../lib/types";
import { AVATAR_COLOURS } from "../lib/avatar-art";
import { avatarChoice, encodeAvatar } from "../lib/avatar-customization";

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
      <BotAvatar type={type} state={paused ? "default" : "working"} paused={paused} size={size} color={colour} shading="plastic" ink="#000000" />
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
      <p className="hint">Shape and colour are only how the agent looks; they don’t change how it works.</p>
      <button type="button" className="link-btn" onClick={() => onChange(choice.avatarId)}>Reset appearance</button>
    </fieldset>
  );
}

export interface BotSpec {
  type: (typeof botAvatarTypes)[number];
  colour: string;
  label: string;
}

/** A decorative bot for marketing pages. Animates only when asked and motion is not reduced. */
export function BotMark({ bot, size = 64, animated = false }: { bot: BotSpec; size?: number; animated?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const paused = reduced || !animated;
  const fallback = <span className="working-avatar" style={{ width: size, height: size, borderRadius: "50%", background: bot.colour }} />;
  return (
    <AnimationBoundary fallback={fallback}>
      <span className="working-avatar" data-bot={bot.type} data-animated={String(!paused)} aria-hidden="true" style={{ width: size, height: size }}>
        <BotAvatar type={bot.type} state="default" paused={paused} size={size} color={bot.colour} shading="plastic" ink="#000000" />
      </span>
    </AnimationBoundary>
  );
}

/** A row of bots; only the first `animate` move, so the page never runs many loops at once. */
export function BotRow({ bots, size = 72, animate = 3 }: { bots: BotSpec[]; size?: number; animate?: number }) {
  return (
    <ul className="bot-row" aria-label="Example agents">
      {bots.map((bot, i) => (
        <li key={bot.type} title={bot.label}>
          <BotMark bot={bot} size={size} animated={i < Math.min(animate, 3)} />
        </li>
      ))}
    </ul>
  );
}
