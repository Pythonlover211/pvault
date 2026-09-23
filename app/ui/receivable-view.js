// 应收与应付（任务 19）。入口：首页「应收 ¥xx」那行小字 → 本面板。
//
// 口径（设计规格 5.3）：借出去的和垫付的钱都不算消费，记成「应收」；对方还回来时也不算收入。
// 所以这里的金额一律不参与月度收支，本面板只回答「谁还欠我、我还欠谁」。
// 已结清的那组只作为历史痕迹留在下面（多了折叠），不参与顶部汇总。
//
// 与 accounts-view / budget-view 同一套结构：**一个 sheet 里切换「列表 / 新增」两块内容**，
// 不嵌套第二层 sheet（两层共用 document.body.style.overflow，关掉任一层都会把它清空，见 sheet.js）。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { formatCents, parseAmountToCents } from '../money.js';
import { startOfDay } from '../dates.js';
import { receivableSummary } from '../receivable.js';
import * as store from '../store.js';

// 已结清最多显示 20 条：它是历史记录，不是待办事项。整段铺开会把「还没结清的那几条」
// 挤出视野，所以超出部分折叠成一行「还有 N 条更早的」。
const SETTLED_LIMIT = 20;

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 时间戳 → 「M月D日」。非法时间戳返回空串：外部改过的数据不该让整个列表渲染崩掉。
function monthDayLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 本地「今天」的 YYYY-MM-DD。不能用 toISOString()：那给的是 UTC 日期，
// 东八区晚上 8 点之后会算出第二天，用户一打开表单就看到明天的日期。
function todayValue(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// YYYY-MM-DD → 当天 0 点的时间戳（本地时区）。
// 绝不能走 new Date('2026-09-03')：这种「只有日期」的字符串按 UTC 解析，东八区会变成
// 9 月 3 日 08:00、西半球会退成 9 月 2 日，日期整体差一天。
// 用年月日构造后再回读一遍，拒掉 2026-02-31 这种被 Date 自动进位的输入（返回 null）。
function dateValueToTs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const ts = new Date(y, mo - 1, day).getTime();
  const back = new Date(ts);
  if (back.getFullYear() !== y || back.getMonth() !== mo - 1 || back.getDate() !== day) return null;
  return ts;
}

// 0 分显示「—」而不是「¥0.00」：这一行是「看有没有」，一笔都没有时 ¥0.00 反而像有数据。
function moneyOrDash(cents) {
  return cents > 0 ? formatCents(cents, { symbol: true }) : '—';
}

export function openReceivableSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  // openSheet 的标题是自己渲染的 span，无法回填新标题，这里换成可写节点，
  // 让「应收与应付 / 新增一笔」两个视图共用同一个面板头。
  const titleNode = el('span', { text: '应收与应付' });
  const sheet = openSheet({ title: '应收与应付', body });
  const headTitle = sheet.panel.querySelector('.sheet-head span');
  if (headTitle) headTitle.replaceWith(titleNode);

  let view = 'list';    // 'list' | 'new'
  let list = [];        // 全部应收条目（含已结清）
  let form = null;      // 新增视图的表单状态
  let errorText = '';
  let loadFailed = false;
  // 写操作共用一把锁：面板有 180ms 动画、手机上又常手抖，连点「已收回 / 保存」会各写一次。
  // settleReceivable 本身没有幂等保护（再调一次会把 settledAt 覆盖成新时间戳），保存则会多写一条。
  let busy = false;

  function load() {
    return store.listReceivables().then(rows => {
      list = Array.isArray(rows) ? rows : [];
      loadFailed = false;
    }).catch(err => {
      loadFailed = true;
      console.error(err);
    });
  }

  // filter 已经产出新数组，这里的 sort 不会就地改动 store 返回的数据。
  const outstandingOf = direction => list
    .filter(r => !r.settledAt && r.direction === direction)
    .sort((a, b) => b.occurredAt - a.occurredAt);

  const settledList = () => list
    .filter(r => r.settledAt)
    .sort((a, b) => b.settledAt - a.settledAt);

  // 来源说明：记账时勾了「有人分摊」派生出来的条目会带 sourceTxnId，与手动记的借还一眼可分。
  // iOwe 方向上不可能有 sourceTxnId（分摊只派生 owedToMe），它一律显示「借入」——
  // 在「我欠别人」那一行写「借出」，方向与金额正好相反。
  function sourceLabel(r) {
    if (r.sourceTxnId) return '分摊自一笔支出';
    return r.direction === 'iOwe' ? '借入' : '借出';
  }

  function metaText(r) {
    return [monthDayLabel(r.occurredAt), sourceLabel(r), r.note].filter(Boolean).join(' · ');
  }

  function errorNode() {
    return el('div', { class: 'form-error', hidden: errorText === '', text: errorText });
  }

  // —— 列表视图 ——

  function nameLine(r) {
    return el('div', { class: 'recv-name' }, [
      el('span', { text: r.personName || '未填姓名' }),
      el('span', { text: formatCents(r.amountCents || 0, { symbol: true }) })
    ]);
  }

  function outstandingRow(r, actionText) {
    return el('div', { class: 'recv-row' }, [
      el('div', { class: 'recv-main' }, [
        nameLine(r),
        el('div', { class: 'recv-meta', text: metaText(r) })
      ]),
      el('button', {
        class: 'btn', type: 'button', text: actionText,
        onclick: () => settle(r.id)
      })
    ]);
  }

  function settledRow(r) {
    return el('div', { class: 'recv-row settled' }, [
      el('div', { class: 'recv-main' }, [
        nameLine(r),
        el('div', { class: 'recv-meta', text: `${monthDayLabel(r.settledAt)} 结清` })
      ])
    ]);
  }

  function group(title, rows, emptyText) {
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'group-title', text: title }),
      rows.length === 0
        ? el('div', { class: 'recv-empty', text: emptyText })
        : el('div', {}, rows)
    ]);
  }

  function renderList() {
    const recv = receivableSummary(list);
    const owedToMe = outstandingOf('owedToMe');
    const iOwe = outstandingOf('iOwe');
    const settled = settledList();
    const shownSettled = settled.slice(0, SETTLED_LIMIT);
    const hiddenSettled = settled.length - shownSettled.length;

    return el('div', { class: 'stack' }, [
      errorNode(),
      loadFailed ? el('div', { class: 'empty', text: '应收记录读取失败，请稍后重试' }) : null,
      el('div', { class: 'recv-summary' }, [
        el('span', { text: `应收 ${moneyOrDash(recv.owedToMe)}` }),
        el('span', { text: `应付 ${moneyOrDash(recv.iOwe)}` })
      ]),
      el('button', {
        class: 'btn', type: 'button', text: '＋ 新增一笔',
        onclick: () => { form = blankForm(); errorText = ''; view = 'new'; render(); }
      }),
      group('别人欠我', owedToMe.map(r => outstandingRow(r, '已收回')), '没有别人欠我的钱'),
      group('我欠别人', iOwe.map(r => outstandingRow(r, '已还')), '没有我欠别人的钱'),
      settled.length === 0 ? null : el('section', { class: 'card stack' }, [
        el('div', { class: 'group-title', text: '已结清' }),
        el('div', {}, shownSettled.map(settledRow)),
        hiddenSettled > 0
          ? el('div', { class: 'recv-empty', text: `还有 ${hiddenSettled} 条更早的` })
          : null
      ])
    ]);
  }

  // —— 新增视图 ——

  function blankForm() {
    return {
      direction: 'owedToMe',
      personName: '',
      amount: '',
      date: todayValue(),
      note: ''
    };
  }

  // 金额文本 → 分。空、'.'、三位以上小数、带杂字符一律 null。
  function formCents() {
    return parseAmountToCents(String(form.amount).trim());
  }

  function canSave() {
    if (form.personName.trim() === '') return false;
    const cents = formCents();
    return cents !== null && cents > 0;
  }

  function renderNew() {
    const saveBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '保存',
      disabled: canSave() ? null : true,
      onclick: () => saveNew()
    });
    // 姓名与金额都只更新 state 再切保存按钮的禁用态，不 render()：重建 input 会让正在输入
    // 的那个框丢焦点（与预算设置同源的处理）。
    const refresh = () => { saveBtn.disabled = !canSave(); };

    return el('div', { class: 'stack' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '方向' }),
        // 改方向不 render()：重建 select 会丢掉它的展开状态。
        el('select', {
          onchange: e => { form.direction = e.target.value; }
        }, [
          el('option', { value: 'owedToMe', text: '别人欠我（借出/垫付）', selected: form.direction === 'owedToMe' }),
          el('option', { value: 'iOwe', text: '我欠别人（借入）', selected: form.direction === 'iOwe' })
        ])
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '对方姓名' }),
        el('input', {
          type: 'text', value: form.personName, placeholder: '如 小王',
          oninput: e => { form.personName = e.target.value; refresh(); }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '金额（元）' }),
        el('input', {
          type: 'text', inputmode: 'decimal', value: form.amount, placeholder: '如 120',
          oninput: e => { form.amount = e.target.value; refresh(); }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '日期' }),
        el('input', {
          type: 'date', value: form.date,
          oninput: e => { form.date = e.target.value; }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '备注（可选）' }),
        el('input', {
          type: 'text', value: form.note, placeholder: '如 垫付团建费',
          oninput: e => { form.note = e.target.value; }
        })
      ]),
      errorNode(),
      el('div', { class: 'form-actions' }, [
        saveBtn,
        el('button', {
          class: 'btn', type: 'button', text: '返回',
          onclick: () => { view = 'list'; errorText = ''; render(); }
        })
      ])
    ]);
  }

  // —— 写回 ——

  async function settle(id) {
    if (busy) return;
    busy = true;
    errorText = '';
    try {
      await store.settleReceivable(id);
    } catch (err) {
      busy = false;
      errorText = `操作失败：${err?.message || err}`;
      render();
      console.error(err);
      return;
    }
    await load();
    busy = false;
    render();
    if (onChanged) onChanged();
  }

  async function saveNew() {
    if (busy) return;
    const personName = form.personName.trim();
    const cents = formCents();
    // 保存按钮已按这两条禁用，这里再兜一道：禁用态在某些浏览器里仍可能被脚本触发。
    if (personName === '' || cents === null || cents <= 0) {
      errorText = '请填写姓名与大于 0 的金额';
      render();
      return;
    }
    // 日期被清空或填成非法值时回退到今天 0 点：宁可落到今天，也不写一个 NaN 进库
    // （与录入面板「清空日期不写非法时间」同一条纪律）。
    const occurredAt = dateValueToTs(form.date) ?? startOfDay(Date.now());

    busy = true;
    try {
      // id / settledAt 不在入参里：addReceivable 统一生成 id 并把 settledAt 置 null。
      await store.addReceivable({
        personName,
        direction: form.direction === 'iOwe' ? 'iOwe' : 'owedToMe',
        amountCents: cents,
        occurredAt,
        dueAt: null,
        note: form.note.trim(),
        sourceTxnId: null
      });
    } catch (err) {
      busy = false;
      errorText = `保存失败：${err?.message || err}`;
      render();
      console.error(err);
      return;
    }
    busy = false;
    await load();
    view = 'list';
    errorText = '';
    render();
    if (onChanged) onChanged();
  }

  function render() {
    titleNode.textContent = view === 'new' ? '新增一笔' : '应收与应付';
    mount(body, view === 'new' ? renderNew() : renderList());
  }

  // 先把空列表渲染出来（面板立刻滑出），数据读回来后再补一次。
  render();
  load().then(render);
  return sheet;
}
