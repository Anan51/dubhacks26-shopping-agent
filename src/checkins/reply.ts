const THUMBS_UP = /^\u{1F44D}(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?$/u;
const THUMBS_DOWN = /^\u{1F44E}(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?$/u;

/** Yes, no, or a thumbs emoji. Anything longer stays on the cart path. */
export function parseWorthReply(text: string): "yes" | "no" | null {
  const compact = text.trim();
  if (THUMBS_UP.test(compact)) {
    return "yes";
  }
  if (THUMBS_DOWN.test(compact)) {
    return "no";
  }
  const word = compact.toLowerCase().replace(/[.!?]+$/g, "").trim();
  if (word === "y" || word === "yes") {
    return "yes";
  }
  if (word === "n" || word === "no") {
    return "no";
  }
  return null;
}

export function checkInText(item: string): string {
  const name = item.trim() || "purchase";
  return `Quick check: was your ${name} worth it? Reply yes or no.`;
}
