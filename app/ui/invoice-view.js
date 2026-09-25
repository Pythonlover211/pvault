// 发票 Tab：搜索、筛选、汇总、列表。
// 依赖 invoice-store（进而 IndexedDB），验证靠模拟器实测。

import { el, mount } from './dom.js';
import * as invoiceStore from '../invoice-store.js';
import { formatCents } from '../money.js';
import { typeLabel, invoiceTitle } from '../invoice-model.js';
import { openInvoiceEditor } from './invoice-editor.js';

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
    paintFilters();
    const kw = keyword.trim().toLowerCase();
    const rows = all.filter(inv => inFilter(inv) && matches(inv, kw));
    if (rows.length === 0) {
      mount(listBox, el('div', { class: 'empty' }, [
        all.length === 0 ? '还没有发票，点右下角拍一张' : '没有符合条件的发票'
      ]));
      return;
    }
    const nodes = [];
    for (const inv of rows) {
      const thumbUrl = inv.fileId ? await invoiceStore.thumbUrlFor(inv.fileId).catch(() => null) : null;
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
  ]));

  await paint();
}

export function openNewInvoice(onSaved) {
  return openInvoiceEditor({ onSaved });
}
