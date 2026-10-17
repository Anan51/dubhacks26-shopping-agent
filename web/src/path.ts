import { useEffect, useState } from "react";

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function navigate(pathname: string): void {
  window.history.pushState(null, "", pathname);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function cartCode(path: string): string | null {
  const match = path.match(/^\/c\/([A-HJ-NP-Z2-9]{6})\/?(?:\?|$)/i);
  return match?.[1]?.toUpperCase() ?? null;
}
