import { formatNumber } from '../format.ts';

/** Impressions per hour as an SVG bar chart, with the same numbers in a table. */
export function HourlyChart({ hourly }: { hourly: { hour: string; impressions: number }[] }) {
  const max = Math.max(1, ...hourly.map((h) => h.impressions));
  const total = hourly.reduce((n, h) => n + h.impressions, 0);
  const peak = hourly.reduce((best, h) => (h.impressions > best.impressions ? h : best), hourly[0] ?? { hour: '00', impressions: 0 });
  const step = 40;
  const width = 24 * step;
  const height = 160;
  const summary = total === 0 ? 'No impressions yet today.' : `${formatNumber(total)} impressions today, peaking at ${formatNumber(peak.impressions)} in the ${peak.hour}:00 UTC hour.`;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height + 22}`} role="img" aria-label={`Impressions per hour. ${summary}`}>
        {hourly.map((h, i) => {
          const barHeight = Math.round((h.impressions / max) * height);
          return (
            <g key={h.hour}>
              <rect x={i * step + 6} y={height - barHeight} width={step - 12} height={Math.max(barHeight, h.impressions ? 1 : 0)} rx={3}>
                <title>{`${h.hour}:00 UTC: ${formatNumber(h.impressions)} impressions`}</title>
              </rect>
              {i % 3 === 0 && (
                <text x={i * step + step / 2} y={height + 18} textAnchor="middle">
                  {h.hour}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption>{summary}</figcaption>
      <details>
        <summary>Show as a table</summary>
        <table>
          <caption className="visually-hidden">Impressions per hour today (UTC)</caption>
          <thead>
            <tr>
              <th scope="col">Hour (UTC)</th>
              <th scope="col">Impressions</th>
            </tr>
          </thead>
          <tbody>
            {hourly.map((h) => (
              <tr key={h.hour}>
                <td>{h.hour}:00</td>
                <td>{formatNumber(h.impressions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
