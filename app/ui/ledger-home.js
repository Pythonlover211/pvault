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
import { openSettingsSheet } from './settings-sheet.js';
import { openReceivableSheet } from './receivable-view.js';
import { openBackupSheet, backupAge } from './backup-view.js';
import { getLastBackupAt } from '../backup-store.js';

// 超过这个天数没备份就把提醒染成警示色。默认 14 天：一次备份的「保鲜期」大约两周——
// 更久不备份，一旦清掉浏览器数据，丢的就是半个月的账。
const DEFAULT_BACKUP_REMINDER_DAYS = 14;

export async function renderLedgerHome(root) {
  const now = Date.now();
  const { start, end } = monthRange(now);
  const day = dayRange(now);
  const [monthTxns, todayTxns, accounts, categories, receivables, budgetTotal, hideAmounts, lastBackupAt, reminderDays] =
    await Promise.all([
      store.listTransactionsInRange(start, end),
      store.listTransactionsInRange(day.start, day.end),
      // 必须用 listAllAccounts 而不是 listAccounts：归档账户仍要能查到名字，供历史流水显示
      // （用过滤归档的 listAccounts，归档后那些历史交易的账户名会变成空白）。
      store.listAllAccounts(),
      store.listAllCategories(),
      store.listReceivables(),
      store.getSetting('budgetTotalCents', 0),
      store.getSetting('hideAmounts', false),
      // 首页底部那行备份提醒要的三个值。全部走 getSetting 的兜底：备份时间可能刚从没有过（null），
      // 提醒天数在老板本的数据里根本不存在（schema 的种子只在新库里写）。
      getLastBackupAt(),
      store.getSetting('backupReminderDays', DEFAULT_BACKUP_REMINDER_DAYS)
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

  // 底部备份提醒。文案与配色都从 backupAge() 走：同一个时间点在这行小字和备份面板里
  // 必须显示成同一个天数，否则用户会开始怀疑到底哪个是真的。
  // 「从未备份」时永远警示——这是最需要行动的状态，不该等满 14 天。
  // Number(reminderDays) 兜住字符串/空值：设置项是从存储里读出来的，不假设它是数字。
  const backup = backupAge(lastBackupAt, now);
  const backupOverdue = backup.days === null || backup.days >= Number(reminderDays ?? DEFAULT_BACKUP_REMINDER_DAYS);
  const backupText = backup.days === null ? '还没备份过，点这里导出' : `上次备份 ${backup.text}`;

  function signed(cents) {
    return `${cents >= 0 ? '+' : ''}${formatCents(cents, { symbol: true })}`;
  }

  mount(root,
    el('div', { class: 'stack' }, [
      el('div', { class: 'row ledger-head' }, [
        el('span', { class: 'muted', text: formatMonthLabel(now) }),
        el('div', { class: 'row head-actions' }, [
          el('button', {
            class: 'btn', type: 'button', text: hideAmounts ? '👁 显示' : '👁 隐藏',
            onclick: async () => {
              await store.setSetting('hideAmounts', !hideAmounts);
              await renderLedgerHome(root);
            }
          }),
          // 管理入口（账户/分类/预算设置）放在这里，而不是统计页底部：
          // 它们都是「记账配置」，用户不会去统计页找；统计页只回答「钱花哪了」。
          el('button', {
            class: 'btn', type: 'button', text: '⚙',
            'aria-label': '设置',
            onclick: () => openSettingsSheet({ onChanged: () => renderLedgerHome(root) })
          })
        ])
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
      // 这行仍是「一行小字」：外层 div 保留原来的 muted tiny ledger-receivable（字号/颜色/间距
      // 全从它来），里面那个按钮只加 .link-like（透明背景、无边框、font: inherit）——
      // 不能把 muted/tiny 挪到按钮上，.link-like 的 font: inherit 会盖掉 .tiny 的字号（同类特异性，后者在后）。
      // 只显示别人欠我的：我欠别人的在应收面板里看（见 docs/手动验证清单.md）。
      recv.owedToMe > 0 ? el('div', { class: 'muted tiny ledger-receivable' }, [
        el('button', {
          class: 'link-like', type: 'button',
          text: `应收 ${formatCents(recv.owedToMe, { symbol: true })}`,
          onclick: () => openReceivableSheet({ onChanged: () => renderLedgerHome(root) })
        })
      ]) : null,
      el('div', { class: 'muted tiny ledger-day', text: `${formatDayLabel(now, now)} · ${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日` }),
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
              // 转账既不是收入也不是支出，用 ⇄ 标记，不加正负号。
              el('span', { class: amountClass, text: `${t.kind === 'income' ? '+' : t.kind === 'transfer' ? '⇄ ' : '-'}${formatCents(t.amountCents)}` })
            ]))),
      // 每次备份面板有改动都整页重渲染：导入会换掉全部数据，让这一行可能过期的提醒
      // 是最省事也最不容易出错的做法（与上面应收入口同一套回调约定）。
      el('div', { class: 'ledger-backup' + (backupOverdue ? ' overdue' : '') }, [
        el('button', {
          class: 'link-like', type: 'button', text: backupText,
          dataset: { role: 'backup-reminder' },
          onclick: () => openBackupSheet({ onChanged: () => renderLedgerHome(root) })
        })
      ])
    ]),
    el('button', {
      class: 'fab', type: 'button', text: '+',
      'aria-label': '记一笔',
      onclick: () => openEntryPanel({ onSaved: () => renderLedgerHome(root) })
    })
  );
}
