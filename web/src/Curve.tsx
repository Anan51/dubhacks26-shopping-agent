import { formatUsd } from "./format.js";

export function Curve({
  points,
  waitMonths,
}: {
  points: { month: number; cents: number }[];
  waitMonths: number;
}) {
  if (points.length < 2) {
    return null;
  }
  const width = 320;
  const height = 120;
  const pad = 8;
  const max = Math.max(...points.map((point) => point.cents));
  const min = Math.min(...points.map((point) => point.cents));
  const span = Math.max(1, max - min);
  const coords = points.map((point, index) => {
    const x = pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (point.cents - min) / span) * (height - pad * 2);
    return { x, y, month: point.month };
  });
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const today = coords[0];
  const later = coords.find((point) => point.month === waitMonths) ?? coords[coords.length - 1];
  if (!today || !later) {
    return null;
  }
  return (
    <figure className="curve">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Example trade-in value over the next year">
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx={today.x} cy={today.y} r="4" />
        <circle cx={later.x} cy={later.y} r="4" />
      </svg>
      <figcaption>
        Example data. Today {formatUsd(points[0]?.cents ?? 0)}
        {waitMonths > 0 ? `, suggested wait month ${waitMonths} ${formatUsd(points[waitMonths]?.cents ?? 0)}` : ""}.
      </figcaption>
    </figure>
  );
}
