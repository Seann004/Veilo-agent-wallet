import { AVATARS, avatarById, type AvatarOption } from "./avatar-options";
import { AVATAR_COLOURS, GENDERS, PRESENTATIONS, pebbleSvg, type AvatarStyle } from "./avatar-art";

export interface AvatarChoice extends AvatarStyle {
  avatarId: string;
}

export function avatarChoice(value: string | null | undefined): AvatarChoice {
  let parsed: Partial<AvatarChoice> = {};
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (data && typeof data === "object" && !Array.isArray(data)) parsed = data;
  } catch {
    // Existing avatar IDs are deliberately still supported.
  }
  const avatar = avatarById(parsed.avatarId) ?? avatarById(value) ?? AVATARS[0]!;
  const index = AVATARS.indexOf(avatar);
  return {
    avatarId: avatar.id,
    colour: AVATAR_COLOURS.find((c) => c.value === parsed.colour)?.value ?? AVATAR_COLOURS[index]!.value,
    presentation: PRESENTATIONS.find((p) => p.value === parsed.presentation)?.value ?? "smooth",
    gender: GENDERS.find((g) => g.value === parsed.gender)?.value ?? "unspecified",
  };
}

export function encodeAvatar(choice: AvatarChoice): string {
  return JSON.stringify(avatarChoice(JSON.stringify(choice)));
}

export function resolveAvatar(value: string): AvatarOption {
  const original = avatarById(value);
  if (original) return original;
  const choice = avatarChoice(value);
  const avatar = avatarById(choice.avatarId)!;
  return {
    id: encodeAvatar(choice),
    label: avatar.label,
    src: `data:image/svg+xml,${encodeURIComponent(pebbleSvg(AVATARS.indexOf(avatar), choice))}`,
  };
}
