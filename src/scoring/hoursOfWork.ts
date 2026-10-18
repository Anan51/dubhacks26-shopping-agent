/** Price and rate share one currency unit (dollars, not cents). */

export type HoursOfWork = {
  hours: number;
  hourlyRate: number;
};

/**
 * Whole hours of pay the price represents.
 * Hidden unless the rate is positive and the price is strictly more than 8 hours.
 */
export function hoursOfWork(price: number, hourlyRate: number): HoursOfWork | null {
  if (!Number.isFinite(price) || price < 0 || !(hourlyRate > 0) || !Number.isFinite(hourlyRate)) {
    return null;
  }
  const raw = price / hourlyRate;
  if (!(raw > 8)) {
    return null;
  }
  return { hours: Math.round(raw), hourlyRate };
}

/** Server copy shown next to `hoursOfWork`. N is the rounded hour count. */
export function hoursOfWorkText(worked: HoursOfWork): string {
  return `This is about ${worked.hours} hours of work at ${formatHourlyRate(worked.hourlyRate)}/hr.`;
}

function formatHourlyRate(rate: number): string {
  const rounded = Math.round(rate * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `$${rounded}`;
  }
  return `$${rounded.toFixed(2)}`;
}
