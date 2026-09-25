// 发票 Tab：搜索、筛选、汇总、列表。
// 依赖 invoice-store（进而 IndexedDB），验证靠模拟器实测。

import { el, mount } from './dom.js';
import { currentTab } from '../router.js';
import * as invoiceStore from '../invoice-store.js';
import { formatCents } from '../money.js';
import { typeLabel, invoiceTitle } from '../invoice-model.js';
import { openInvoiceEditor } from './invoice-editor.js';
import { openSheet } from './sheet.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待报销' },
  { id: 'stored', label: '仅存档' },
  { id: 'unlinked', label: '未挂账' }
];

// 筛选状态按 Tab 生命周期保存在模块级：切走再回来不该被重置，
// 与统计页存口径是同一种做法。
let filter = 'all';
let keyword = '';

// 当前列表渲染序号：每次 paint() 自增。paint 是分批 await 取缩略图的异步循环，
// 而切 Tab 会立刻发起新的一次渲染——main.js 的 renderSeq 只保证外壳（root）不被旧渲染盖，
// 管不到这个 listBox。少了这道检查，先发起、后完成的那次会把新列表盖回去，
// 用户切回来看到的是一份旧数据（点进去还会是已经被删掉的那张票）。
let paintSeq = 0;

// 当前视图渲染序号：每次 renderInvoices 自增。它与 paintSeq 管的是两件事——
// 这个管「哪一次渲染有权往 root 上写」，paintSeq 管「哪一份列表该留在 listBox 里」。
// 必须有这一道：await 之后本文件自己会 mount(root, …)，而 main.js 的 renderSeq 只保证
// 「最后一次发起者挂 tabbar」，拦不住视图在这个窗口里写 view。复现是——进发票页后立刻点「统计」，
// 统计先画完并挂上高亮，发票那一次随后 mount 覆盖掉内容，「统计」高亮着却显示发票列表，
// 且此后不会再有 hashchange 来自愈。写法照 vault-view.js 的 activeSeq。
let viewSeq = 0;

// 本次会话是否已经清过孤儿图。cleanupOrphanFiles 要扫两张表、可能删掉几十条 blob，
// 而它跑的时候首屏那批缩略图正在读同一个 IndexedDB——每次切回发票页都全表扫一遍就是白跟首屏抢时间，
// 而清理本身是「迟早会做」的事：一个会话做一次就够，这次之后新产生的孤儿留给下次会话。
let cleanedOnce = false;

function matches(inv, kw) {
  if (!kw) return true;
  const hay = [inv.seller, inv.number, inv.note, inv.buyerTitle].join(' ').toLowerCase();
  return hay.includes(kw);
}

function inFilter(inv) {
  switch (filter) {
    case 'pending': return !inv.archived && !inv.reimbursementId;
    case 'stored': return !!inv.archived;
    case 'unlinked': return !inv.txnId;
    default: return true;
  }
}

export async function renderInvoices(root) {
  const seq = ++viewSeq;

  // 顺手清一次孤儿图（拍完照又取消保存留下的那份）。**故意不 await**：它要扫两张表、
  // 可能要删掉几十条 blob，等它做完用户看到的就是一段白屏；而清理是「迟早会做」的事，
  // 晚几百毫秒和立刻做完对用户没有区别。清理失败也不该让发票页打不开，所以整段 catch 掉。
  // 整个会话只发起一次（见 cleanedOnce）：置位放在发起之前，renderInvoices 并发两次时也只跑一遍。
  if (!cleanedOnce) {
    cleanedOnce = true;
    invoiceStore.cleanupOrphanFiles().catch(() => {});
  }

  // 列表与汇总一起取：两者是同一次渲染的两半，串行 await 只是白白多等一个事务。
  const [invoices, sum] = await Promise.all([invoiceStore.listInvoices(), invoiceStore.summary()]);
  // 等数据这段时间用户完全来得及切走（前面那次全表清理还在抢 IO）。两个条件都要过：
  // ① 已经切到别的 Tab 就直接走人——main.js 用同一个 view 元素渲染所有 Tab，此时写进去
  //    就是「统计」高亮着却显示发票列表，而且此后不会再有 hashchange 来自愈。
  //    这一条是序号拦不住的：切走不会让 viewSeq 变化（本视图根本没被再次调用）。
  //    与 vault-view.js 里那句「切走之后不去动别人的视图」是同一道检查。
  // ② 还是本 Tab、但已经又发起过一次发票渲染（切走再切回），交给新的那次去画。
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const all = invoices;

  const searchInput = el('input', {
    type: 'search',
    placeholder: '搜索销售方、号码、备注',
    value: keyword,
    oninput: (e) => { keyword = e.target.value; paint(); }
  });

  const listBox = el('div', {});
  const filterBox = el('div', { class: 'inv-filters' });
  // 汇总区要能单独重画（保存完发票后金额和张数都变了），所以留一个容器节点，
  // 与 listBox 同样的做法：整页只 mount 一次，之后局部替换内容。
  const summaryBox = el('div', { class: 'inv-summary' });

  // 展示金额一律带 ¥（formatCents 的 symbol 选项）：记账页与编辑器都带，
  // 同一个屏幕上两个口径（列表带符号、汇总不带）会让人以为它们不是同一种数。
  function paintSummary(s) {
    mount(summaryBox,
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: '本月发票' }),
        el('div', { class: 'v', text: formatCents(s.monthCents, { symbol: true }) })
      ]),
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: `待报销（${s.pendingCount} 张）` }),
        el('div', { class: 'v', text: formatCents(s.pendingCents, { symbol: true }) })
      ])
    );
  }

  function paintFilters() {
    mount(filterBox, FILTERS.map(f => el('button', {
      type: 'button',
      'aria-selected': String(f.id === filter),
      onclick: () => { filter = f.id; paint(); }
    }, [f.label])));
  }

  async function paint() {
    const seq = ++paintSeq;
    paintFilters();
    const kw = keyword.trim().toLowerCase();
    const rows = all.filter(inv => inFilter(inv) && matches(inv, kw));
    if (rows.length === 0) {
      if (seq !== paintSeq) return;
      mount(listBox, el('div', { class: 'empty' }, [
        all.length === 0 ? '还没有发票，点右下角拍一张' : '没有符合条件的发票'
      ]));
      // 这一屏一张缩略图都不需要，缓存里的全部作废（listBox 刚被整块换掉，旧节点上的 URL
      // 已经没人看）。空集就是「一个都不留」。
      invoiceStore.pruneUrlCache(new Set());
      return;
    }

    // 本批真的取到 URL 的 fileId，paint 结束时按它做差集回收。
    // 不能再像原来那样开头一律清空：搜索框每敲一个字都跑一次 paint，
    // 全量清空等于每按一个键都把可见缩略图重新读一遍 IndexedDB、重新建一遍 blob URL，
    // 而其中绝大多数上一批刚取过。
    const keep = new Set();
    // 有图可取的行的占位节点：等 URL 回来逐个替换成 <img>。
    const pending = [];

    // ① 骨架先行：整页**同步**搭出来、一次 mount。原来是边 await 边拼节点、全部取完才 mount，
    // 几十张票的时候 listBox 会在几百毫秒内完全是空的——而用户只是切回来看一眼列表。
    // 缩略图位置先放占位节点，真实图片随后填进去。
    const items = rows.map(inv => {
      const thumb = el('div', { class: 'inv-thumb', text: inv.fileId ? '📄' : '🧾' });
      if (inv.fileId) pending.push({ fileId: inv.fileId, thumb });
      return el('button', {
        class: 'inv-item',
        type: 'button',
        onclick: () => openInvoiceEditor({ id: inv.id, onSaved: refresh })
      }, [
        thumb,
        el('div', {}, [
          el('div', { class: 'inv-title', text: invoiceTitle(inv) }),
          el('div', { class: 'inv-meta', text: [typeLabel(inv.type), inv.number].filter(Boolean).join(' · ') }),
          el('div', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: inv.archived ? '仅存档' : (inv.reimbursementId ? '已报销' : '待报销') })
        ]),
        el('div', { class: 'inv-amount', text: formatCents(inv.amountCents, { symbol: true }) })
      ]);
    });
    mount(listBox, items);

    // ② 分批并发取图。原来是一行一行串行 await：一张 200ms、三十张就是好几秒的空白；
    // 而全部并发又会一次性往 IndexedDB 排几十个读 + 同时解码几十张图（手机最先在内存上撑不住）。
    // 每批 6 个：首屏压到一个批次的时间，同时解码的图也不会太多。
    const BATCH = 6;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const urls = await Promise.all(
        batch.map(p => invoiceStore.thumbUrlFor(p.fileId).catch(() => null))
      );
      // 每批之后都要重新对一次序号：一次列表可能有几十张票，用户完全来得及切走再切回来。
      // 这里停手而不是继续填图，省掉后面几批无用的 IO（新的那次 paint 会自己再取一遍）。
      if (seq !== paintSeq) return;
      batch.forEach((p, j) => {
        const url = urls[j];
        // 取不到不算异常：PDF 本来就没有缩略图，占位节点留着就是它应有的形态。
        if (!url) return;
        keep.add(p.fileId);
        // 只替换这一个占位节点，不整块重挂列表：整块重挂会让列表闪一下，
        // 也会把用户正按住的那一行从手指底下抽走。
        p.thumb.replaceWith(el('img', { class: 'inv-thumb', src: url, alt: '' }));
      });
    }
    if (seq !== paintSeq) return;
    // ③ 差集回收：只 revoke 这一批不再需要的缩略图 URL，用户接着敲下一个字时
    // 还在画面上的那些留在缓存里，命中就是零成本。full: 前缀不归这里管（见 image-store）。
    invoiceStore.pruneUrlCache(keep);
  }

  async function refresh() {
    // refresh 由编辑器的 onSaved 回调触发，跑在 renderInvoices 之外，所以这里取当前的 viewSeq
    // 当作「我属于这一次渲染」的凭据：保存后用户可能已经切走，那时不该再往一个别人的 root 里写。
    const seq = viewSeq;
    // 汇总必须跟列表一起重取：保存成功后列表多了一行，而顶部「本月发票 / 待报销（N 张）」
    // 若还是旧值，金额和张数都对不上——用户最容易在这里犯疑「我刚存的那张算进去了没」。
    const [fresh, freshSum] = await Promise.all([invoiceStore.listInvoices(), invoiceStore.summary()]);
    if (seq !== viewSeq) return;
    all.length = 0;
    all.push(...fresh);
    paintSummary(freshSum);
    await paint();
  }

  paintSummary(sum);

  mount(root, el('div', { class: 'stack' }, [
    summaryBox,
    searchInput,
    filterBox,
    listBox
  ]),
  // 右下角新建入口：类名、位置、观感都跟记账页的 FAB 保持一致。
  // 少了它就等于没有入口——空态那句「点右下角拍一张」会指向一片空气。
  el('button', {
    class: 'fab', type: 'button', text: '+',
    'aria-label': '新建发票',
    onclick: () => openNewInvoice(refresh)
  }));

  await paint();
}

export function openNewInvoice(onSaved) {
  return openInvoiceEditor({ onSaved });
}

// 从记账页点「🧾N」进来的小面板：看这笔账挂了哪些票，也能当场补挂一张。
// 与编辑器的分工：这里只管「挂靠」这一件事，看大图/改字段交给编辑器。
// txn 由调用方直接传整条对象（ledger-home 手里就有），不再查一次库；
// categoryName 同理已由调用方查好，这里不重复查分类表。
export function openInvoiceLinkSheet({ txn, categoryName = '', onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '这笔账的发票', body });

  async function refresh() {
    const list = await invoiceStore.listByTxn(txn.id);

    const rows = list.map(inv => el('button', {
      class: 'inv-row', type: 'button',
      onclick: () => {
        sheet.close();
        openInvoiceEditor({ id: inv.id, onSaved: onChanged });
      }
    }, [
      el('span', { class: 'inv-row-main' }, [
        el('span', { text: inv.seller || inv.number || '未命名发票' }),
        el('span', { class: 'muted tiny', text: `${inv.number || '无号码'} · ${formatCents(inv.amountCents ?? 0, { symbol: true })}` })
      ]),
      inv.archived
        ? el('span', { class: 'inv-tag stored', text: '仅存档' })
        : el('span', { class: 'inv-tag pending', text: inv.reimbursementId ? '已报销' : '待报销' })
    ]));

    mount(body,
      el('div', { class: 'muted tiny', text: `${categoryName || '这笔账'} ${formatCents(txn.amountCents ?? 0, { symbol: true })}　已挂 ${list.length} 张` }),
      // el(tag, props, children) 的 children 收数组（不能像 mount 那样变参展开）
      list.length === 0
        ? el('div', { class: 'empty', text: '这笔账还没有发票' })
        : el('div', { class: 'stack' }, rows),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '＋ 新建发票并挂到这笔账',
        // txnId 直接交给编辑器：saveInvoice 会把它写进发票，不必再调 linkToTxn。
        onclick: () => {
          sheet.close();
          openInvoiceEditor({ txnId: txn.id, onSaved: onChanged });
        }
      })
    );
  }

  refresh().catch(err => {
    mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
  });
}
