/** Present only when the extension is built with VITE_SIMMER_DEMO=1. */
export function demoReplyEnabled(): boolean {
  return import.meta.env.VITE_SIMMER_DEMO === "1";
}

export function demoReplyMarker(): string | null {
  if (import.meta.env.VITE_SIMMER_DEMO !== "1") {
    return null;
  }
  return "simmer-demo-reply";
}
