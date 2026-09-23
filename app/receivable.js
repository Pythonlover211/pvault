export function effectiveExpense(txn) {
  if (txn.kind !== 'expense') return txn.amountCents;
  const shares = txn.shares || [];
  const shared = shares.reduce((sum, s) => sum + s.amountCents, 0);
  if (shared > txn.amountCents) {
    throw new RangeError('分摊合计不能超过交易金额');
  }
  return txn.amountCents - shared;
}

export function receivableSummary(list) {
  let owedToMe = 0;
  let iOwe = 0;
  for (const r of list) {
    if (r.settledAt) continue;
    if (r.direction === 'owedToMe') owedToMe += r.amountCents;
    else if (r.direction === 'iOwe') iOwe += r.amountCents;
  }
  return { owedToMe, iOwe };
}

export function outstandingList(list) {
  return list.filter(r => !r.settledAt).sort((a, b) => b.occurredAt - a.occurredAt);
}
