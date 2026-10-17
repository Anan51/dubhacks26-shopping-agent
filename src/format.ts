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

export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}
