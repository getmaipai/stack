const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return shortDate(then, now);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMs / 3_600_000);
  if (diffH < 24) return `${diffH}h`;
  const dayDiff = calendarDayDiff(now, new Date(then));
  if (dayDiff === 1) return "Yesterday";
  const diffD = Math.floor(diffMs / 86_400_000);
  if (diffD < 7) return `${diffD}d`;
  return shortDate(then, now);
}

function calendarDayDiff(later: Date, earlier: Date): number {
  const local = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((local(later) - local(earlier)) / 86_400_000);
}

function shortDate(ms: number, now: Date): string {
  const date = new Date(ms);
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}`;
}
