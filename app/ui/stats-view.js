// 统计页（设计规格 5.3）：月份切换 + 支出/收入口径切换 + 环比 → 环形占比图 → 图例 →
// 分类明细 → 近 6 个月趋势 → 应收/应付。
//
// 口径约定（与首页一致，重要）：
// - 汇总金额一律走 effectiveExpense() 扣掉他人分摊：规格 5.3「借出去的和垫付的钱都不算消费」。
//   所以支出总额、分类占比、趋势柱高统计的都是「自己实际花掉的钱」。
//   收入不做分摊扣减（收入本来就不带分摊），effective() 只对 kind === 'expense' 动手。
// - 支出口径**含转账**（用户 2026-09-23 的要求），转账在分类聚合里归到内置的「转账」伪分类，
//   因此「分类各项之和 === 环形圆心总额」这条不变量对两个口径都成立。
// - 图例、环形图、分类明细共用同一份 slices 数组（每个分类带自己的颜色、角度、占比），
//   顺序天然一致；本任务不做「超支置顶」，也是为了不让三处顺序被打乱。
//
// 状态：anchorTs 与 scope 都是模块级状态，切 Tab 后回来仍停在上次看的那个月、那个口径。
import { el, mount } from './dom.js';
import { currentTab } from '../router.js';
import { donutSegments, donutPath } from '../chart.js';
import { byCategory, monthlyTotals, compareWithPrev, trendSeries } from '../summary.js';
import { lastNMonths, monthRange, formatMonthLabel, addMonths } from '../dates.js';
import { formatCents } from '../money.js';
import { effectiveExpense, receivableSummary } from '../receivable.js';
import { budgetProgress, budgetLevel } from '../budget.js';
import * as store from '../store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#0a6ef0', '#ff9f0a', '#34c759', '#ff3b30', '#af52de', '#5ac8fa', '#ffd60a', '#8e8e93'];

// 环形图几何：180×180，圆心正中，外半径 78 / 内半径 50。
const DONUT = { size: 180, cx: 90, cy: 90, rOuter: 78, rInner: 50 };
// 趋势图几何：viewBox 300×100，底部 14px 留给月份标签，顶部留 4px 空隙。
const TREND = { width: 300, height: 100, labelH: 14, topPad: 4, padX: 2, gap: 6 };

// el() 只支持 HTML，SVG 元素必须用 createElementNS 建。
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const round3 = v => Number(v.toFixed(3));

// 分类预算来自 settings（形如 { categoryId: cents }）。没设、值为 0 或不是数字时按「没有预算」处理，
// 不做超支判定——0 元预算不是「一花就超」的意思，而是「这个分类没设预算」。
function isOverBudget(cents, budgetCents) {
  const budget = typeof budgetCents === 'number' ? budgetCents : 0;
  return budgetLevel(budgetProgress(cents, budget)) === 'over';
}

let anchorTs = Date.now();
// 统计口径：'expense' | 'income'。两个口径走的是同一段计算与渲染代码，只是取数时换一个字段。
let scope = 'expense';
let drawSeq = 0;

export async function renderStats(root) {
  return draw(root);
}

// 视图自己发起的重渲染不在 main.js 的 try/catch 里，这里要自己兜住数据层异常，
// 否则切月份/切口径时数据层一出错就是「界面没反应 + 控制台未捕获 promise」。
function rerender(root) {
  return draw(root).catch(err => {
    console.error(err);
    // 出错时同样要先确认「还在统计 Tab 上」再写 root：main.js 用同一个 view 元素渲染所有
    // Tab，用户在这几个 await 期间切走的话，这一行会把别的页面换成一句统计页的报错。
    // 这里不比序号：新的那一次渲染自己会重画，用户切回来时该看到的是它的结果，不是这次的异常。
    if (currentTab() !== 'stats') return;
    mount(root, el('div', { class: 'empty' }, ['页面加载失败：' + (err?.message || err)]));
  });
}

function goMonth(root, delta) {
  anchorTs = addMonths(anchorTs, delta);
  return rerender(root);
}

function switchScope(root, next) {
  if (next === scope) return undefined;
  scope = next;
  return rerender(root);
}

async function draw(root) {
  const seq = ++drawSeq;
  const now = Date.now();
  const months = lastNMonths(anchorTs, 6);

  // 一次查询拿到的就是以 anchorTs 结尾的 6 个月并集：当前月（总额）、上月（环比）、
  // 近 6 个月（趋势）全在这批数据里。
  const [txns, categories, receivables, budgetSetting] = await Promise.all([
    store.listTransactionsInMonths(6, anchorTs),
    store.listAllCategories(),
    store.listReceivables(),
    store.getSetting('budgetByCategory', {})
  ]);

  // 本地切桶用半开区间 [start, end)：相邻两月共享的那一瞬间（下月 1 日 0 点）只落进下一个月，
  // 不会重复计入也不会漏计（listTransactionsInMonths 的 end 同样是开上界）。
  const buckets = months.map(m => txns.filter(t => t.occurredAt >= m.start && t.occurredAt < m.end));
  const effective = list => list.map(t => (t.kind === 'expense' ? { ...t, amountCents: effectiveExpense(t) } : t));

  // —— 口径唯一的两个分叉点 ——
  // 1) 金额取哪个字段：支出（含转账）/ 收入。
  // 2) 分类聚合按哪个 kind：byCategory 支出口径含转账、收入口径不含。
  // 环形图、图例、明细、趋势、环比全部读下面这几个值，不各自算一遍，避免口径漂移。
  const scopeLabel = scope === 'income' ? '收入' : '支出';
  const amountOf = list => {
    const totals = monthlyTotals(effective(list));
    return scope === 'income' ? totals.income : totals.expense;
  };
  const monthlyAmounts = buckets.map(amountOf);
  const currentTxns = effective(buckets[buckets.length - 1]);
  const scopeTotal = monthlyAmounts[monthlyAmounts.length - 1];
  const prevTotal = monthlyAmounts[monthlyAmounts.length - 2];

  // 传给 donutSegments 的 cents 必须是 number：字符串会让它内部的 reduce 变成字符串拼接
  // （"3000" + "7000" → "030007000"），占比静默算错且不报错。byCategory 给的就是 number，
  // 这里不做 `?? '0'` 之类的兜底，否则正好把这个隐患引进来。
  // 另外过滤掉有效金额为 0 的分类（整笔都被分摊掉时会出现）：0 元分类画不出扇区，只有噪声。
  const cats = byCategory(currentTxns, categories, scope).filter(c => c.cents > 0);
  const slices = donutSegments(cats.map(c => ({ key: c.categoryId, cents: c.cents })))
    .map((seg, i) => ({
      ...cats[i],
      color: PALETTE[i % PALETTE.length],
      ratio: seg.ratio,
      startAngle: seg.startAngle,
      endAngle: seg.endAngle
    }));

  const budgetMap = budgetSetting && typeof budgetSetting === 'object' ? budgetSetting : {};
  const atCurrentMonth = monthRange(anchorTs).start === monthRange(now).start;

  // —— 1. 月份切换 ——
  const monthRow = el('div', { class: 'stats-month' }, [
    el('button', {
      class: 'stats-nav', type: 'button', text: '‹', 'aria-label': '上一个月',
      onclick: () => goMonth(root, -1)
    }),
    el('span', { class: 'stats-month-label', text: formatMonthLabel(anchorTs) }),
    el('button', {
      class: 'stats-nav', type: 'button', text: '›', 'aria-label': '下一个月',
      // 不允许切到未来月份：当前月就把右箭头禁掉。disabled 传 '' 而不是 true，
      // 因为 el() 会跳过 false —— 传 null/undefined 时属性根本不会出现。
      disabled: atCurrentMonth ? '' : null,
      // 禁用的按钮点不动，这里再挡一次是为了不依赖 DOM 的 disabled 状态。
      onclick: () => (atCurrentMonth ? undefined : goMonth(root, 1))
    })
  ]);

  // —— 1b. 支出 / 收入口径切换（复用录入面板那套 .kind-switch 样式）——
  const scopeRow = el('div', { class: 'kind-switch' }, [
    { id: 'expense', label: '支出' }, { id: 'income', label: '收入' }
  ].map(s => el('button', {
    type: 'button',
    // 必须是字符串：CSS 只对 [aria-selected="true"] 生效，而 el() 会跳过 false 值。
    'aria-selected': String(s.id === scope),
    text: s.label,
    onclick: () => switchScope(root, s.id)
  })));

  // —— 2. 本月合计 + 环比 ——
  const cmp = compareWithPrev(scopeTotal, prevTotal);
  let cmpNode;
  if (cmp === null) {
    // 上月为 0（compareWithPrev 返回 null）时显示「—」，绝不显示 +∞%。
    cmpNode = el('span', { class: 'stats-cmp muted', text: '比上月 —' });
  } else if (cmp.deltaCents === 0) {
    cmpNode = el('span', { class: 'stats-cmp muted', text: '与上月持平' });
  } else {
    const pct = Math.round(Math.abs(cmp.ratio) * 100);
    // 花得更多用警示色（up），省下来用成功色（down）。
    cmpNode = el('span', {
      class: 'stats-cmp ' + (cmp.deltaCents > 0 ? 'up' : 'down'),
      text: `比上月 ${cmp.deltaCents > 0 ? '+' : '−'}${pct}%`
    });
  }

  // —— 3. 环形图 ——
  const ringR = (DONUT.rOuter + DONUT.rInner) / 2;
  const ringW = DONUT.rOuter - DONUT.rInner;
  const donutParts = [];
  if (slices.length === 0) {
    // 该口径下没有可展示的分类（没数据，或金额全被分摊掉）：画一个灰色整环兜底，否则这里是一块空白。
    donutParts.push(svgEl('circle', {
      class: 'donut-track', cx: DONUT.cx, cy: DONUT.cy, r: ringR, fill: 'none', 'stroke-width': ringW
    }));
  } else {
    for (const s of slices) {
      const d = donutPath(DONUT.cx, DONUT.cy, DONUT.rOuter, DONUT.rInner, s.startAngle, s.endAngle);
      // donutPath 对整圆（span >= 360）返回 null：单项占 100% 时必须换成「描边整圆」，
      // 圆环宽度 = 外径 − 内径，否则只有一个分类时环形图整块空白。
      donutParts.push(d === null
        ? svgEl('circle', {
            cx: DONUT.cx, cy: DONUT.cy, r: ringR, fill: 'none',
            stroke: s.color, 'stroke-width': ringW
          })
        : svgEl('path', { d, fill: s.color }));
    }
  }
  if (scopeTotal === 0) {
    donutParts.push(svgEl('text', {
      x: DONUT.cx, y: DONUT.cy + 4, 'text-anchor': 'middle', class: 'donut-note'
    }, [`本月还没有${scopeLabel}`]));
  } else {
    donutParts.push(svgEl('text', { x: DONUT.cx, y: DONUT.cy - 4, 'text-anchor': 'middle' }, [scopeLabel]));
    donutParts.push(svgEl('text', {
      x: DONUT.cx, y: DONUT.cy + 16, 'text-anchor': 'middle', class: 'donut-total'
    }, [formatCents(scopeTotal, { symbol: true })]));
  }
  const donutNode = el('div', { class: 'stats-donut' }, [
    svgEl('svg', {
      viewBox: `0 0 ${DONUT.size} ${DONUT.size}`,
      width: DONUT.size, height: DONUT.size,
      role: 'img', 'aria-label': `所选月份${scopeLabel}分类占比`
    }, donutParts)
  ]);

  // —— 4. 分类明细（先建，图例要靠它定位）——
  const catRowNodes = new Map();
  const catList = slices.length === 0
    // 「这个月真的没花钱」和「花了但一笔都没归到分类」是两回事，不要用同一句话。
    ? el('div', { class: 'empty', text: scopeTotal === 0 ? `本月还没有${scopeLabel}` : `本月的${scopeLabel}还没有分类` })
    : el('div', { class: 'stats-cats' }, slices.map(s => {
        const over = isOverBudget(s.cents, budgetMap[s.categoryId]);
        const row = el('div', { class: 'stats-cat-row' + (over ? ' over' : '') }, [
          el('div', { class: 'stats-cat-head' }, [
            el('span', { class: 'stats-cat-name', text: `${s.icon || '📦'} ${s.name}${over ? ' · 超支' : ''}` }),
            el('span', { class: 'num', text: `${formatCents(s.cents, { symbol: true })} · ${Math.round(s.ratio * 100)}%` })
          ]),
          el('div', { class: 'bar' }, [el('i', { style: `width:${s.ratio * 100}%` })])
        ]);
        catRowNodes.set(s.categoryId, row);
        return row;
      }));

  // —— 5. 图例（颜色取自 slices，与环形图同源同序）——
  function focusCategory(categoryId) {
    const target = catRowNodes.get(categoryId);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('flash');
    // 高亮是瞬时的：900ms 后摘掉，免得点下一个分类时还留着上一个的底色。
    setTimeout(() => target.classList.remove('flash'), 900);
  }

  const legendNode = slices.length === 0 ? null : el('div', { class: 'stats-legend' }, slices.map(s =>
    el('div', { class: 'legend-row', onclick: () => focusCategory(s.categoryId) }, [
      el('span', { class: 'legend-swatch', style: `background:${s.color}` }),
      el('span', { class: 'legend-name', text: `${s.icon || '📦'} ${s.name}` }),
      el('span', { class: 'legend-cents num', text: formatCents(s.cents, { symbol: true }) }),
      el('span', { class: 'legend-ratio num', text: `${Math.round(s.ratio * 100)}%` })
    ])));

  // —— 6. 近 6 个月趋势（SVG，viewBox 300×100，宽度撑满、高度按比例自适应）——
  const trend = trendSeries(months.map((m, i) => ({
    label: `${new Date(m.start).getMonth() + 1}月`,
    cents: monthlyAmounts[i]
  })));
  const barBase = TREND.height - TREND.labelH - TREND.topPad;
  const maxBarH = barBase - TREND.topPad;
  const slot = (TREND.width - TREND.padX * 2) / trend.bars.length;
  const barW = Math.max(1, slot - TREND.gap);
  const trendParts = [];
  trend.bars.forEach((b, i) => {
    // 全零的那个月给 2px 基线，否则柱子高度为 0 就完全看不见，看不出「这个月没数据」。
    const h = Math.max(2, b.heightRatio * maxBarH);
    const x = TREND.padX + i * slot + TREND.gap / 2;
    trendParts.push(svgEl('rect', {
      // 锚点所在的月份（最后一根）用强调色，其余用次要色；颜色在 CSS 里按类配，
      // 因为 SVG 呈现属性不吃 var()，写死色值又会丢掉暗色模式适配。
      class: 'trend-bar' + (i === trend.bars.length - 1 ? ' current' : ''),
      x: round3(x), y: round3(barBase - h), width: round3(barW), height: round3(h), rx: 3
    }));
    trendParts.push(svgEl('text', {
      class: 'trend-label', x: round3(x + barW / 2), y: TREND.height - 3, 'text-anchor': 'middle'
    }, [b.label]));
  });
  const trendNode = el('div', { class: 'stats-trend' }, [
    svgEl('svg', {
      class: 'stats-trend-svg',
      viewBox: `0 0 ${TREND.width} ${TREND.height}`,
      role: 'img', 'aria-label': `近 6 个月${scopeLabel}趋势`
    }, trendParts)
  ]);

  // —— 7. 应收 / 应付汇总 ——
  const recv = receivableSummary(receivables);
  const amountOrDash = cents => (cents > 0 ? formatCents(cents, { symbol: true }) : '—');

  const tree = el('div', { class: 'stack' }, [
    monthRow,
    scopeRow,
    el('section', { class: 'card stack' }, [
      el('div', {}, [
        el('div', { class: 'muted tiny', text: `本月${scopeLabel}` }),
        el('div', { class: 'ledger-total num', text: formatCents(scopeTotal, { symbol: true }) }),
        cmpNode
      ]),
      donutNode,
      legendNode
    ]),
    el('section', { class: 'card stack' }, [
      el('div', { class: 'muted tiny', text: '分类明细' }),
      catList
    ]),
    el('section', { class: 'card stack' }, [
      el('div', { class: 'muted tiny', text: '近 6 个月' }),
      trendNode
    ]),
    el('section', { class: 'card' }, [
      el('div', { class: 'row tiny stats-receivable' }, [
        el('span', {}, ['别人欠我 ', el('span', { class: 'num', text: amountOrDash(recv.owedToMe) })]),
        el('span', {}, ['我欠别人 ', el('span', { class: 'num', text: amountOrDash(recv.iOwe) })])
      ])
    ])
  ]);

  // 两次检查缺一不可，写法照 vault-view.js 的 activeSeq：
  // ① currentTab() !== 'stats' —— 拦住「切走」。main.js 用**同一个 view 元素**渲染所有 Tab，
  //    这次渲染在 await 之后无条件 mount(root, …) 就会盖掉别的页面（切到记账却显示统计图），
  //    而 main.js 的 renderSeq 只保证「最后一次发起者挂 tabbar」，拦不住视图在这个窗口里写 view；
  //    此后也不会再有 hashchange 来自愈。这一条是序号拦不住的——切走不会让 drawSeq 变化
  //    （本视图根本没被再次调用）。
  // ② seq !== drawSeq —— 拦住「切走再切回」。那时已经又发起过一次统计渲染（快速连点月份箭头
  //    也会起两次并发渲染），先发起的不一定先完成，交给新的那一次去画，界面才不会停在
  //    用户没选的那个月/那个口径上。
  if (currentTab() !== 'stats' || seq !== drawSeq) return;
  mount(root, tree);
}
