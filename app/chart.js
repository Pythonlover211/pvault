export function polarPoint(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function donutSegments(items) {
  const total = items.reduce((s, x) => s + x.cents, 0);
  if (total <= 0) return [];
  let cursor = 0;
  return items.map(item => {
    const ratio = item.cents / total;
    const startAngle = cursor;
    const endAngle = cursor + ratio * 360;
    cursor = endAngle;
    return { ...item, ratio, startAngle, endAngle };
  });
}

export function donutPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  if (endAngle - startAngle >= 360) return null; // 整圆交给 <circle> 画
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const o1 = polarPoint(cx, cy, rOuter, startAngle);
  const o2 = polarPoint(cx, cy, rOuter, endAngle);
  const i2 = polarPoint(cx, cy, rInner, endAngle);
  const i1 = polarPoint(cx, cy, rInner, startAngle);
  const n = v => Number(v.toFixed(3));
  return [
    `M ${n(o1.x)} ${n(o1.y)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${n(o2.x)} ${n(o2.y)}`,
    `L ${n(i2.x)} ${n(i2.y)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${n(i1.x)} ${n(i1.y)}`,
    'Z'
  ].join(' ');
}
