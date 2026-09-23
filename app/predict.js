export function hourBucket(hour) {
  return Math.floor(hour / 3);
}

function firstAvailable(categories) {
  const c = categories.find(x => !x.archived);
  return c ? c.id : null;
}

export function predictCategory({ hour, txns, categories }) {
  const usable = categories.filter(c => !c.archived && c.kind === 'expense');
  if (usable.length === 0) return firstAvailable(categories);

  const usableIds = new Set(usable.map(c => c.id));
  const bucket = hourBucket(hour);

  const inBucket = txns.filter(t =>
    t.kind === 'expense' &&
    usableIds.has(t.categoryId) &&
    hourBucket(new Date(t.occurredAt).getHours()) === bucket
  );

  if (inBucket.length >= 3) return mostFrequent(inBucket, usable);

  const recent = [...txns]
    .filter(t => t.kind === 'expense' && usableIds.has(t.categoryId))
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 30);

  if (recent.length > 0) return mostFrequent(recent, usable);

  return usable[0].id;
}

function mostFrequent(list, usable) {
  const counts = new Map();
  for (const t of list) {
    counts.set(t.categoryId, (counts.get(t.categoryId) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const c of usable) {
    const n = counts.get(c.id) || 0;
    if (n > bestCount) { bestCount = n; best = c.id; }
  }
  return best;
}
