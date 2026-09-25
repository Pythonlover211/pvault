// 发票 Tab：搜索、筛选、汇总、列表。
// 依赖 invoice-store（进而 IndexedDB），验证靠模拟器实测。

import { el, mount } from './dom.js';
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

// 当前列表渲染序号：每次 paint() 自增。paint 是逐行 await 取缩略图的异步循环，
// 而切 Tab 会立刻发起新的一次渲染——main.js 的 renderSeq 只保证外壳（root）不被旧渲染盖，
// 管不到这个 listBox。少了这道检查，先发起、后完成的那次会把新列表盖回去，
// 用户切回来看到的是一份旧数据（点进去还会是已经被删掉的那张票）。
let paintSeq = 0;

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
  // 顺手清一次孤儿图（拍完照又取消保存留下的那份）。**故意不 await**：它要扫两张表、
  // 可能要删掉几十条 blob，等它做完用户看到的就是一段白屏；而清理是「迟早会做」的事，
  // 晚几百毫秒和立刻做完对用户没有区别。清理失败也不该让发票页打不开，所以整段 catch 掉。
  invoiceStore.cleanupOrphanFiles().catch(() => {});

  const all = await invoiceStore.listInvoices();
  const sum = await invoiceStore.summary();

  const searchInput = el('input', {
    type: 'search',
    placeholder: '搜索销售方、号码、备注',
    value: keyword,
    oninput: (e) => { keyword = e.target.value; paint(); }
  });

  const listBox = el('div', {});
  const filterBox = el('div', { class: 'inv-filters' });

  function paintFilters() {
    mount(filterBox, FILTERS.map(f => el('button', {
      type: 'button',
      'aria-selected': String(f.id === filter),
      onclick: () => { filter = f.id; paint(); }
    }, [f.label])));
  }

  async function paint() {
    const seq = ++paintSeq;
    // 先回收上一批缩略图 URL，再取新的。paint 会被搜索框每敲一个字、每次切筛选触发一次，
    // 不回收就是每敲一个字攒下一整屏的 blob URL（每个还 pin 住对应的 Blob），全部活到页面卸载。
    // 此刻 revoke 是安全的：旧节点上的 <img> 早已解码完成，显示不受影响，
    // 而它们马上会被下面那次 mount 整批换掉——新的那一批用的是这次新取的 URL。
    invoiceStore.clearUrlCache();
    paintFilters();
    const kw = keyword.trim().toLowerCase();
    const rows = all.filter(inv => inFilter(inv) && matches(inv, kw));
    if (rows.length === 0) {
      if (seq !== paintSeq) return;
      mount(listBox, el('div', { class: 'empty' }, [
        all.length === 0 ? '还没有发票，点右下角拍一张' : '没有符合条件的发票'
      ]));
      return;
    }
    const nodes = [];
    for (const inv of rows) {
      const thumbUrl = inv.fileId ? await invoiceStore.thumbUrlFor(inv.fileId).catch(() => null) : null;
      // 每取一张缩略图都要重新对一次序号：一次列表可能有几十张票，等第一张的时候
      // 用户完全来得及切走再切回来。这里停手而不是继续拼节点，省掉整轮无用的 IO。
      if (seq !== paintSeq) return;
      nodes.push(el('button', {
        class: 'inv-item',
        type: 'button',
        onclick: () => openInvoiceEditor({ id: inv.id, onSaved: refresh })
      }, [
        thumbUrl
          ? el('img', { class: 'inv-thumb', src: thumbUrl, alt: '' })
          : el('div', { class: 'inv-thumb', text: inv.fileId ? '📄' : '🧾' }),
        el('div', {}, [
          el('div', { class: 'inv-title', text: invoiceTitle(inv) }),
          el('div', { class: 'inv-meta', text: [typeLabel(inv.type), inv.number].filter(Boolean).join(' · ') }),
          el('div', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: inv.archived ? '仅存档' : (inv.reimbursementId ? '已报销' : '待报销') })
        ]),
        el('div', { class: 'inv-amount', text: formatCents(inv.amountCents) })
      ]));
    }
    if (seq !== paintSeq) return;
    mount(listBox, nodes);
  }

  async function refresh() {
    const fresh = await invoiceStore.listInvoices();
    all.length = 0;
    all.push(...fresh);
    await paint();
  }

  mount(root, el('div', { class: 'stack' }, [
    el('div', { class: 'inv-summary' }, [
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: '本月发票' }),
        el('div', { class: 'v', text: formatCents(sum.monthCents) })
      ]),
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: `待报销（${sum.pendingCount} 张）` }),
        el('div', { class: 'v', text: formatCents(sum.pendingCents) })
      ])
    ]),
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
