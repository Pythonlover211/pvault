// 记账首页（设计规格 5.1）。
//
// 结构自上而下：月份 + 隐藏金额开关 → 本月支出大数字（带收入与结余）→ 预算进度条
// （未设预算则整块不渲染）→ 应收小字（没有应收则不渲染）→ 今天的流水（空态兜底）→ 右下角 FAB。
//
// 语义约定（重要）：
// - 月度汇总用 effectiveExpense() 扣掉他人分摊：规格 5.3 的「借出去的和垫付的钱都不算消费」。
// - 单笔今日流水**不**扣分摊：用户核对的是「我刚记的那笔是多少」。
import { el, mount } from './dom.js';
import { formatCents } from '../money.js';
import { monthRange, dayRange, daysLeftInMonth, formatMonthLabel, formatDayLabel } from '../dates.js';
import { monthlyTotals } from '../summary.js';
import { effectiveExpense, receivableSummary } from '../receivable.js';
import { budgetProgress, budgetLevel, dailyAllowance } from '../budget.js';
import * as store from '../store.js';
import { openEntryPanel } from './entry-panel.js';

export async function renderLedgerHome(root) {
  const now = Date.now();
  const { start, end } = monthRange(now);
  const day = dayRange(now);
  const [monthTxns, todayTxns, accounts, categories, receivables, budgetTotal, hideAmounts] =
    await Promise.all([
      store.listTransactionsInRange(start, end),
      store.listTransactionsInRange(day.start, day.end),
      store.listAccounts(),
      store.listAllCategories(),
      store.listReceivables(),
      store.getSetting('budgetTotalCents', 0),
      store.getSetting('hideAmounts', false)
    ]);

  // 只有支出需要扣分摊；收入与转账原样透传（effectiveExpense 内部也判了 kind，这里显式写着更清楚）。
  const effective = monthTxns.map(t =>
    t.kind === 'expense' ? { ...t, amountCents: effectiveExpense(t) } : t);
  const totals = monthlyTotals(effective);
  const ratio = budgetProgress(totals.expense, budgetTotal);
  const level = budgetLevel(ratio);
  const remaining = budgetTotal ? budgetTotal - totals.expense : null;
  const allowance = dailyAllowance(remaining, daysLeftInMonth(now));
  const recv = receivableSummary(receivables);
  const catOf = new Map(categories.map(c => [c.id, c]));
  const accOf = new Map(accounts.map(a => [a.id, a]));
  const amountClass = hideAmounts ? 'num hide-amount' : 'num';

  function signed(cents) {
    return `${cents >= 0 ? '+' : ''}${formatCents(cents, { symbol: true })}`;
  }

  mount(root,
    el('div', { class: 'stack' }, [
      el('div', { class: 'row ledger-head' }, [
        el('span', { class: 'muted', text: formatMonthLabel(now) }),
        el('button', {
          class: 'btn', type: 'button', text: hideAmounts ? '👁 显示' : '👁 隐藏',
          onclick: async () => {
            await store.setSetting('hideAmounts', !hideAmounts);
            await renderLedgerHome(root);
          }
        })
      ]),
      el('div', {}, [
        el('div', { class: 'muted tiny', text: '本月支出' }),
        el('div', { class: 'ledger-amount ledger-total ' + amountClass }, [formatCents(totals.expense, { symbol: true })]),
        el('div', { class: 'muted tiny ledger-sub' }, [
          `收入 ${formatCents(totals.income, { symbol: true })}　结余 ${signed(totals.net)}`
        ])
      ]),
      budgetTotal ? el('div', { class: 'card' }, [
        el('div', { class: 'row tiny' }, [
          el('span', { class: 'muted', text: `本月预算 ${formatCents(budgetTotal, { symbol: true })}` }),
          el('span', { text: `已用 ${Math.round((ratio || 0) * 100)}%` })
        ]),
        el('div', { class: 'bar', dataset: { level }, style: 'margin:6px 0' }, [
          el('i', { style: `width:${Math.min(100, (ratio || 0) * 100)}%` })
        ]),
        el('div', { class: 'muted tiny', text: `还剩 ${formatCents(Math.max(0, remaining), { symbol: true })} · 日均可用 ${formatCents(allowance || 0, { symbol: true })}` })
      ]) : null,
      recv.owedToMe > 0 ? el('div', { class: 'muted tiny ledger-receivable', text: `应收 ${formatCents(recv.owedToMe, { symbol: true })}` }) : null,
      el('div', { class: 'muted tiny ledger-day', text: `今天 · ${formatDayLabel(now, now)}` }),
      todayTxns.length === 0
        ? el('div', { class: 'empty', text: '今天还没有记账' })
        : el('div', { class: 'stack' }, todayTxns
            // 在副本上排序：不就地改动 store 返回的数组（当前它每次都是新建的，但不依赖这个前提）。
            .slice()
            .sort((a, b) => b.occurredAt - a.occurredAt)
            .map(t => el('div', { class: 'row ledger-txn-row' }, [
              // 分类名单独包一层 span：只有元素节点才能被 .ledger-txn-name 的省略号规则命中
              // （裸文本节点没有 :first-child 可选中），间距交给 CSS 的 gap。
              el('span', { class: 'ledger-txn-name' }, [
                el('span', { text: `${catOf.get(t.categoryId)?.icon || '📦'} ${catOf.get(t.categoryId)?.name || (t.kind === 'transfer' ? '转账' : '未分类')}` }),
                el('span', { class: 'muted tiny', text: accOf.get(t.accountId)?.name || '' })
              ]),
              // 单笔显示交易原始金额（不扣分摊），分摊只体现在上面的月度汇总里。
              el('span', { class: amountClass, text: `${t.kind === 'income' ? '+' : '-'}${formatCents(t.amountCents)}` })
            ])))
    ]),
    el('button', {
      class: 'fab', type: 'button', text: '+',
      'aria-label': '记一笔',
      onclick: () => openEntryPanel({ onSaved: () => renderLedgerHome(root) })
    })
  );
}
