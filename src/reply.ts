/** Swap this function for the real shopping agent. Both receivers call it. */
export function replyToText(text: string): string {
  return `hello from the shopping agent: ${text}`;
}
