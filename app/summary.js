export function monthlyTotals(txns) {
  let expense = 0;
  let income = 0;
  for (const t of txns) {
    if (t.kind === 'expense') expense += t.amountCents;
    else if (t.kind === 'income') income += t.amountCents;
  }
  return { expense, income, net: income - expense };
}

export function byCategory(txns, categories, kind = 'expense') {
  const nameOf = new Map(categories.map(c => [c.id, c]));
  const sums = new Map();
  for (const t of txns) {
    if (t.kind !== kind) continue;
    if (!nameOf.has(t.categoryId)) continue;
    sums.set(t.categoryId, (sums.get(t.categoryId) || 0) + t.amountCents);
  }
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...sums.entries()]
    .map(([categoryId, cents]) => {
      const c = nameOf.get(categoryId);
      return { categoryId, name: c.name, icon: c.icon, cents, ratio: cents / total };
    })
    .sort((a, b) => b.cents - a.cents);
}

export function compareWithPrev(currentCents, prevCents) {
  if (!prevCents) return null;
  return {
    deltaCents: currentCents - prevCents,
    ratio: (currentCents - prevCents) / prevCents
  };
}

export function trendSeries(months) {
  const max = months.reduce((m, x) => Math.max(m, x.cents), 0);
  return {
    max,
    bars: months.map(m => ({ ...m, heightRatio: max === 0 ? 0 : m.cents / max }))
  };
}
