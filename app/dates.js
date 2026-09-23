export function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dayRange(ts) {
  const start = startOfDay(ts);
  const d = new Date(start);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { start, end };
}

export function monthRange(ts) {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return { start, end };
}

export function daysLeftInMonth(ts) {
  const { end } = monthRange(ts);
  const lastDay = new Date(end - 1);
  return lastDay.getDate() - new Date(ts).getDate() + 1;
}

export function addMonths(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate()).getTime();
}

export function formatDayLabel(ts, now) {
  const { start } = dayRange(now);
  const day = startOfDay(ts);
  if (day === start) return '今天';
  if (day === start - 86400000) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatMonthLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

export function lastNMonths(ts, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const anchor = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth() - i, 1).getTime();
    out.push({ label: formatMonthLabel(anchor), ...monthRange(anchor) });
  }
  return out;
}
