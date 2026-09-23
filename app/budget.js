export function budgetProgress(spentCents, totalCents) {
  if (!totalCents || totalCents <= 0) return null;
  return spentCents / totalCents;
}

export function budgetLevel(ratio) {
  if (ratio === null || ratio === undefined) return 'none';
  if (ratio > 1) return 'over';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}

export function dailyAllowance(remainingCents, daysLeft) {
  if (remainingCents === null || remainingCents === undefined) return null;
  if (!daysLeft || daysLeft <= 0) return 0;
  if (remainingCents <= 0) return 0;
  return Math.floor(remainingCents / daysLeft);
}
