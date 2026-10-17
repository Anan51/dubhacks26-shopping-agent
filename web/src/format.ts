export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = dollars.toLocaleString("en-US");
  if (remainder === 0) {
    return `${sign}$${grouped}`;
  }
  return `${sign}$${grouped}.${remainder.toString().padStart(2, "0")}`;
}

/** Adjective form, such as "10-minute", from a lock length in milliseconds. */
export function formatCooling(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms % 60_000 === 0 && minutes >= 1) {
    return `${minutes}-minute`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds}-second`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}
