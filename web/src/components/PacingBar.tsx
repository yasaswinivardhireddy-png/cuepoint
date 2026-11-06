import { capitalize, formatNumber, paceStatus } from '../format.ts';

/** Today's delivery against the daily goal, as a native progress bar plus text for everyone. */
export function PacingBar({ delivered, goal, now }: { delivered: number; goal: number; now?: Date }) {
  const status = paceStatus(delivered, goal, now);
  const percent = goal > 0 ? Math.min(100, Math.round((delivered / goal) * 100)) : 0;
  return (
    <div className="pacing">
      <progress max={goal} value={Math.min(delivered, goal)} aria-label={`${formatNumber(delivered)} of ${formatNumber(goal)} impressions today`} />
      <span className="pacing-text">
        {formatNumber(delivered)} / {formatNumber(goal)} ({percent}%)
        <span className={`pace pace-${status.replace(' ', '-')}`}>{capitalize(status)}</span>
      </span>
    </div>
  );
}

export function StatusBadge({ status }: { status: 'active' | 'paused' }) {
  return <span className={`badge badge-${status}`}>{capitalize(status)}</span>;
}
