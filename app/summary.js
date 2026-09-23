// 转账在统计口径里计入支出（用户 2026-09-23 的要求）：它没有真实分类（录入时不选分类），
// 所以在分类聚合里统一归到这个内置的「转账」伪分类。它不在数据库的 categories 里，
// 只在统计时存在——这样分类各项之和仍然等于支出总额，环形图不会和总额对不上。
export const TRANSFER_CATEGORY_ID = '__transfer__';
const TRANSFER_META = { id: TRANSFER_CATEGORY_ID, name: '转账', icon: '⇄' };

export function monthlyTotals(txns) {
  let expense = 0;
  let income = 0;
  for (const t of txns) {
    // 转账也计入支出：信用卡还款是「银行卡 → 信用卡」的转账，按新口径它算一笔消费。
    if (t.kind === 'expense' || t.kind === 'transfer') expense += t.amountCents;
    else if (t.kind === 'income') income += t.amountCents;
  }
  return { expense, income, net: income - expense };
}

export function byCategory(txns, categories, kind = 'expense') {
  // 内置伪分类要先进映射表，否则下面查不到它的名字。
  const nameOf = new Map(categories.map(c => [c.id, c]));
  nameOf.set(TRANSFER_CATEGORY_ID, TRANSFER_META);
  const sums = new Map();
  for (const t of txns) {
    let categoryId;
    if (t.kind === 'transfer') {
      // 转账只归入支出口径；收入口径下它不是收入，直接跳过（byCategory 不做收入统计）。
      if (kind !== 'expense') continue;
      categoryId = TRANSFER_CATEGORY_ID;
    } else {
      if (t.kind !== kind) continue;
      categoryId = t.categoryId;
    }
    if (!nameOf.has(categoryId)) continue;
    sums.set(categoryId, (sums.get(categoryId) || 0) + t.amountCents);
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
