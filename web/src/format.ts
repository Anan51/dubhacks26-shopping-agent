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
