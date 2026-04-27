'use client';

interface Props {
  activity: Record<string, number>;
  streak: number;
  totalDays: number;
}

export default function ActivityHeatmap({ activity, totalDays }: Props) {
  // Build a grid of the last 52 weeks (columns) × 7 days (rows).
  // Align so the rightmost column ends on today.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find the Sunday at or before today to end the last column on today's day
  const todayDay = today.getDay(); // 0 = Sun
  const endSunday = new Date(today);
  endSunday.setDate(today.getDate() + (6 - todayDay)); // end of current week (Saturday)

  // Start date: 24 weeks back from the Sunday that starts this week
  const startDate = new Date(endSunday);
  startDate.setDate(endSunday.getDate() - 24 * 7 + 1);

  // Build columns (weeks)
  const weeks: (string | null)[][] = [];
  for (let w = 0; w < 24; w++) {
    const week: (string | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(startDate);
      cell.setDate(startDate.getDate() + w * 7 + d);
      if (cell > today) {
        week.push(null);
      } else {
        week.push(cell.toISOString().split('T')[0]);
      }
    }
    weeks.push(week);
  }

  function getCellStyle(date: string | null): React.CSSProperties {
    if (!date) return { backgroundColor: 'transparent' };
    const count = activity[date] || 0;
    if (count === 0) return { backgroundColor: 'var(--border-color)' };
    const opacity = count <= 2 ? 0.3 : count <= 5 ? 0.55 : count <= 9 ? 0.8 : 1;
    return { backgroundColor: 'var(--text-primary)', opacity };
  }

  // Build month labels: for each week column, figure out if the first day of a new month starts here
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabels: (string | null)[] = weeks.map((week) => {
    const first = week.find(d => d !== null);
    if (!first) return null;
    const d = new Date(first);
    // Show month label only on the week where the 1st of that month falls
    const dayOfMonth = d.getDate();
    if (dayOfMonth <= 7) return MONTHS[d.getMonth()];
    return null;
  });

  // Day labels: index 1=Mon, 3=Wed, 5=Fri (0=Sun in JS)
  const DAY_LABELS: Record<number, string> = { 1: 'Mon', 3: 'Wed', 5: 'Fri' };

  return (
    <div className="mt-8">
      {/* Month labels */}
      <div className="flex gap-[3px] mb-1 ml-6">
        {weeks.map((_, wi) => (
          <div key={wi} className="w-[10px] text-[8px] text-[var(--text-muted)] leading-none">
            {monthLabels[wi] ?? ''}
          </div>
        ))}
      </div>

      <div className="flex gap-[3px]">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] mr-1">
          {[0,1,2,3,4,5,6].map(d => (
            <div key={d} className="w-5 h-[10px] text-[8px] text-[var(--text-muted)] leading-[10px] text-right pr-1">
              {DAY_LABELS[d] ?? ''}
            </div>
          ))}
        </div>

        {/* Grid */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((date, di) => (
              <div
                key={di}
                title={date ? `${date}: ${activity[date] || 0} words` : ''}
                className="w-[10px] h-[10px] rounded-[2px]"
                style={getCellStyle(date)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-5 text-xs text-[var(--text-muted)]">
        <span>{totalDays} active days</span>
      </div>
    </div>
  );
}
