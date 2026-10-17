/** Pebble geometry shared by the shipped SVGs and the browser's custom avatars. */
export const PEBBLES = [
  "M89 53C91 76 72 91 49 90C25 89 9 74 10 52C11 29 26 10 48 10C70 10 87 30 89 53Z",
  "M48 10C58 8 64 21 73 33C84 47 94 66 85 79C76 93 50 92 31 85C11 78 8 63 17 45C25 29 36 13 48 10Z",
  "M28 32C25 17 39 8 51 14C65 5 80 17 77 33C93 35 94 53 85 62C93 80 74 92 60 85C44 95 29 87 28 77C7 79 5 59 16 49C9 39 17 29 28 32Z",
  "M32 12L70 15Q88 17 89 36L87 69Q86 89 65 89L30 86Q10 85 12 65L14 31Q15 11 32 12Z",
  "M38 13C55 6 59 27 74 28C94 30 92 49 83 61C92 79 75 92 58 86C42 96 32 80 20 77C5 72 10 53 19 44C9 29 23 14 38 13Z",
  "M88 49C96 68 80 87 59 90C37 94 12 81 10 60C8 41 24 17 43 12C64 6 80 27 88 49Z",
  "M34 21C15 23 7 36 11 52C15 69 39 83 61 81C81 79 93 67 89 51C85 35 55 18 34 21Z",
  "M41 15Q51 5 60 19L89 69Q97 87 76 88L24 86Q5 85 14 66Z",
  "M28 15Q12 14 12 33L14 72Q15 90 34 88L72 85Q90 84 88 65L84 28Q83 10 64 12Z",
  "M42 11Q50 8 58 13L81 29Q87 33 88 42L90 65Q90 74 82 79L59 89Q51 93 43 89L19 76Q12 72 12 63L14 39Q14 31 22 26Z",
] as const;

export const AVATAR_COLOURS = [
  { label: "Violet", value: "#8b5cf6" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Green", value: "#22a565" },
  { label: "Teal", value: "#14a38b" },
  { label: "Brown", value: "#8a5a3c" },
  { label: "Orange", value: "#f97316" },
  { label: "Red", value: "#e5484d" },
  { label: "Pink", value: "#e8457f" },
  { label: "Indigo", value: "#5b5bd6" },
  { label: "Amber", value: "#f5a524" },
] as const;

export const PRESENTATIONS = [
  { value: "smooth", label: "Smooth" },
  { value: "tuft", label: "Tuft" },
  { value: "sweep", label: "Side sweep" },
  { value: "crest", label: "Crest" },
] as const;

export const GENDERS = [
  { value: "unspecified", label: "Not specified" },
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "nonbinary", label: "Non-binary" },
] as const;

export interface AvatarStyle {
  colour: string;
  presentation: typeof PRESENTATIONS[number]["value"];
  gender: typeof GENDERS[number]["value"];
}

/** Only allowlisted values reach SVG markup, including preferences read from storage. */
export function pebbleSvg(index: number, style?: Partial<AvatarStyle>): string {
  const safeIndex = Number.isInteger(index) && index >= 0 && index < PEBBLES.length ? index : 0;
  const colour = AVATAR_COLOURS.find((c) => c.value === style?.colour)?.value ?? AVATAR_COLOURS[safeIndex]!.value;
  const top = style?.presentation === "tuft" ? "M40 23Q28 6 41 8Q49 7 53 23Z"
    : style?.presentation === "sweep" ? "M26 31Q20 10 36 9Q49 8 61 23Z"
    : style?.presentation === "crest" ? "M41 25Q40 6 48 8Q54 3 59 10Q70 8 64 26Z" : "";
  // Attach the bow to each silhouette's upper edge, including the low pill and triangle.
  const ribbonAnchor = [[70, 24], [62, 30], [70, 26], [70, 19], [71, 32], [66, 25], [63, 29], [65, 32], [70, 19], [69, 27]][safeIndex]!;
  const ribbon = style?.gender === "woman"
    ? `<g data-accessory="ribbon" transform="translate(${ribbonAnchor[0]} ${ribbonAnchor[1]}) rotate(16)"><path fill="#f7a8ca" d="M-2-3Q-16-16-15-4L-15 3Q-15 12-2 3L-6 13L0 10L6 13L2 3Q15 12 15 3L15-4Q16-16 2-3Z"/><rect x="-3" y="-5" width="6" height="10" rx="2.5" fill="#db2777"/></g>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100"><path fill="${colour}" d="${PEBBLES[safeIndex]}"/>${top ? `<path fill="${colour}" d="${top}"/>` : ""}<g fill="#fff"><rect x="37" y="51" width="7" height="12" rx="3.5"/><rect x="54" y="51" width="7" height="12" rx="3.5"/></g>${ribbon}</svg>`;
}
