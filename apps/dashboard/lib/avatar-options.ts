import type { AgentRole } from "./types";

export interface AvatarOption {
  id: string;
  src: string;
  label: string;
}

/** Image set offered in the avatar picker. Replace files in public/avatars (any web image format) and update `src`. */
export const AVATARS: AvatarOption[] = [
  { id: "avatar-01", src: "/avatars/avatar-01.svg", label: "Violet round" },
  { id: "avatar-02", src: "/avatars/avatar-02.svg", label: "Blue drop" },
  { id: "avatar-03", src: "/avatars/avatar-03.svg", label: "Green cloud" },
  { id: "avatar-04", src: "/avatars/avatar-04.svg", label: "Teal square" },
  { id: "avatar-05", src: "/avatars/avatar-05.svg", label: "Brown blob" },
  { id: "avatar-06", src: "/avatars/avatar-06.svg", label: "Orange round" },
  { id: "avatar-07", src: "/avatars/avatar-07.svg", label: "Red pill" },
  { id: "avatar-08", src: "/avatars/avatar-08.svg", label: "Pink triangle" },
  { id: "avatar-09", src: "/avatars/avatar-09.svg", label: "Indigo square" },
  { id: "avatar-10", src: "/avatars/avatar-10.svg", label: "Amber hexagon" },
];

export const ROLE_AVATAR: Record<AgentRole, string> = {
  credit_manager: "avatar-04",
  research: "avatar-09",
  content: "avatar-08",
};

export function avatarById(id: string | null | undefined): AvatarOption | undefined {
  return AVATARS.find((a) => a.id === id);
}
