import type { Segment } from '../schedule';

/**
 * One day as a 24-hour track: allowed viewing hours are solid violet, quiet hours hatched,
 * "no restriction" is a pale full band, "no TV" an empty track. Optional marker for now.
 */
export function ScheduleTrack({
  viewing,
  quiet,
  nowMin,
  label,
}: {
  viewing: Segment[] | null;
  quiet: Segment[];
  nowMin?: number | null;
  label: string;
}) {
  const pct = (m: number): string => `${(m / 1440) * 100}%`;
  return (
    <div role="img" aria-label={label} className="relative h-5 overflow-hidden rounded-full bg-raised">
      {viewing === null ? (
        <div className="absolute inset-0 bg-accent-soft" />
      ) : (
        viewing.map((s, i) => (
          <div
            key={i}
            className="absolute inset-y-0 rounded-full bg-accent"
            style={{ left: pct(s.start), width: pct(s.end - s.start) }}
          />
        ))
      )}
      {quiet.map((s, i) => (
        <div
          key={`q${i}`}
          className="hatch absolute inset-y-0 text-faint opacity-70"
          style={{ left: pct(s.start), width: pct(s.end - s.start) }}
        />
      ))}
      {nowMin != null && (
        <div className="absolute inset-y-[-2px] w-0.5 bg-text" style={{ left: pct(nowMin) }} aria-hidden="true" />
      )}
    </div>
  );
}

export function TrackAxis() {
  return (
    <div aria-hidden="true" className="tabular mt-1 grid grid-cols-4 text-xs text-faint">
      <span>12 AM</span>
      <span>6 AM</span>
      <span>12 PM</span>
      <span className="flex justify-between">
        6 PM<span>12 AM</span>
      </span>
    </div>
  );
}
