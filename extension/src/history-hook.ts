const HOOKED = Symbol.for("simmer.history");

/** Call `onChange` when a storefront navigates with pushState, replaceState, or the back button. */
export function watchLocation(win: Window, onChange: () => void): () => void {
  const marked = win as Window & { [HOOKED]?: () => void };
  if (marked[HOOKED]) {
    return marked[HOOKED];
  }
  const history = win.history;
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  const notify = () => {
    onChange();
  };
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    originalPush(...args);
    notify();
  }) as History["pushState"];
  history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    originalReplace(...args);
    notify();
  }) as History["replaceState"];
  win.addEventListener("popstate", notify);
  const unhook = () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    win.removeEventListener("popstate", notify);
    delete marked[HOOKED];
  };
  marked[HOOKED] = unhook;
  return unhook;
}
