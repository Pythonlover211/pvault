// 录入面板（设计规格 5.2 / 5.3）：记一笔的全流程都在这。
//
// 自上而下：三态切换（支出/收入/转账）→ 自建数字键盘（金额）→ 分类九宫格
// → 账户（转账时两个）→ 时间 → 备注 → 分摊（仅支出）→ 错误文字 → 完成。
//
// 四条踩过的纪律，改这个文件前先读一遍：
// 1. 判「没有金额」只能用 `cents === null`。0 元是合法金额（免单、抹零调整），
//    `if (!cents)` 会把 0 元当成没输入、完成按钮永远点不动。
// 2. 分摊合计必须用 reduce，不要写 addCents(shares.map(...))：漏写展开运算符时
//    非空数组传进 addCents 会静默变成 NaN，超额判断跟着失灵。
// 3. 回填金额只能用 keypad.setFromCents(cents)。formatCents 的输出带 ¥，
//    而 parseAmountToCents('¥12.40') 返回 null，回填后金额会变空。
// 4. createKeypad 的 onChange 里只能用回调参数。创建时会同步首调一次，那时
//    `const keypad = createKeypad(...)` 还在 TDZ，闭包引用它会抛
//    "Cannot access 'keypad' before initialization"。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import { predictCategory } from '../predict.js';
import { formatCents, parseAmountToCents } from '../money.js';
import * as store from '../store.js';

const KINDS = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
  { id: 'transfer', label: '转账' }
];

// 时间戳 → <input type="datetime-local"> 要的本地时间字符串（YYYY-MM-DDTHH:mm）。
// 必须手工补零：个位数月份/日期/小时都只有一位，'2026-9-3T8:5' 不是合法值，控件会显示空白。
// 也不能用 toISOString()：它转成 UTC，东八区晚上 8 点记的账会显示成中午 12 点。
function toLocalInputValue(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// datetime-local 字符串 → 时间戳。不带时区偏移的值由浏览器按**本地时间**解析，
// 所以它和上面的生成逻辑互为逆运算。
// 空值/半截输入得到 Invalid Date（getTime() 为 NaN），一律返回 null 让调用方保留上一次有效值：
// NaN 不是合法的 IndexedDB 键，写进 occurredAt 这笔账就再也查不出来了。
function fromLocalInputValue(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

// 同一时刻只留一个撤销浮层：它们都是 fixed 在同一位置，叠在一起完全重合，
// 用户既看不见下面那个，也点不到它，还会在 3 秒后各自消失。
let activeToast = null;

function showUndoToast({ onUndo }) {
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }

  // 撤销只能生效一次：await deleteTransaction 期间浮层还在页面上，
  // 快速双击会发出两次删除（第二次删已删的 id 虽然无害，但 onSaved 会重渲染两次、
  // 数据层也白跑一趟）。
  let settled = false;
  let timer = null;

  const label = el('span', { text: '已记一笔' });
  const btn = el('button', { type: 'button', text: '撤销', onclick: undo });
  const toast = el('div', { class: 'toast' }, [label, btn]);

  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (activeToast === toast) activeToast = null;
    toast.classList.remove('open');
    // 等 .18s 的退场过渡走完再摘节点，否则浮层会瞬间消失、没有动画。
    setTimeout(() => toast.remove(), 200);
  }

  async function undo() {
    if (settled) return;
    // 先置位、再 await：第二次点击（包括 await 期间的那次）会被这一行挡住。
    settled = true;
    btn.disabled = true;
    try {
      await onUndo();
    } catch (err) {
      // 撤销失败就把浮层留在原地并恢复可点：否则用户看到「已记一笔」消失，
      // 会以为这笔已经删掉了，实际首页金额还挂着。
      settled = false;
      btn.disabled = false;
      label.textContent = '撤销失败，请重试';
      console.error(err);
      return;
    }
    dismiss();
  }

  activeToast = toast;
  document.body.append(toast);
  // 先挂上 DOM 再在下一帧加 .open：同一帧里做，浏览器会把「初始 opacity:0」和 .open
  // 合并成一次样式计算，过渡不会播放（和 sheet.js 同理）。
  requestAnimationFrame(() => toast.classList.add('open'));
  timer = setTimeout(dismiss, 3000);
  return toast;
}

export async function openEntryPanel({ onSaved } = {}) {
  const [categories, accounts, txns, lastAccountId] = await Promise.all([
    store.listAllCategories(),
    store.listAccounts(),
    store.listTransactionsInMonths(6),
    store.getSetting('lastAccountId', null)
  ]);

  let kind = 'expense';
  let cents = null;
  let categoryId = null;
  // 上次用过的账户优先；它可能已被归档（不在列表里），那时退回第一个账户。
  let accountId = accounts.some(a => a.id === lastAccountId)
    ? lastAccountId
    : (accounts.length > 0 ? accounts[0].id : null);
  let toAccountId = null;
  let occurredAt = Date.now();
  let note = '';
  let shares = [];
  let splitOpen = false;   // 「有人分摊」勾选状态
  let saving = false;
  let submitted = false;   // 已经成功保存过：面板收起前再点「完成」不许插第二笔
  let errorText = '';
  let shareNote = null;    // 分摊合计/超额提示节点（每次 render 重建，供局部更新用）

  function catsOf(k) {
    return categories.filter(c => !c.archived && c.kind === k);
  }

  // 切换 kind（以及首次打开）时的分类默认值。
  function defaultCategoryIdFor(k) {
    if (k === 'transfer') return null;
    const list = catsOf(k);
    if (list.length === 0) return null;
    if (k === 'expense') {
      const guess = predictCategory({ hour: new Date().getHours(), txns, categories });
      // predictCategory 返回 null（没有可用支出分类）时退回该 kind 的第一个分类；
      // 它返回的分类万一不在当前列表里（被归档/数据被改过）也退回第一个，不能让高亮落空。
      if (guess && list.some(c => c.id === guess)) return guess;
    }
    // predictCategory 内部写死了 kind === 'expense'，对收入类它给不出答案，只能取第一个收入分类。
    return list[0].id;
  }

  function firstOtherAccount() {
    const other = accounts.find(a => a.id !== accountId);
    return other ? other.id : null;
  }

  categoryId = defaultCategoryIdFor(kind);
  toAccountId = firstOtherAccount();

  const body = el('div', { class: 'stack' });
  const doneBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: '完成',
    onclick: () => submit()
  });
  const errorNode = el('div', { class: 'form-error', hidden: true });

  // 键盘只创建一次，它的输入状态（state 与 display 文本）都在闭包里。
  // render() 会把 keypad.node 从旧位置摘下来挂到新位置，元素对象本身没变，状态因此不丢。
  // onChange 里只允许用回调参数，见文件头纪律 4。
  const keypad = createKeypad({
    onChange: ({ cents: c }) => { cents = c; updateDone(); }
  });

  const sheet = openSheet({ title: '记一笔', body });

  // —— 派生量 ——

  function shareTotal() {
    // 纪律 2：reduce 而不是 addCents(shares.map(...))。
    // amountCents === null 表示这一行还没填出有效金额，按 0 计入；0 本身是合法金额。
    return shares.reduce((sum, s) => sum + (s.amountCents === null ? 0 : s.amountCents), 0);
  }

  function shareOverflow() {
    // 只在支出、且勾了「有人分摊」时才有意义：取消勾选后这些行既不显示也不提交，
    // 要是还按它们禁用按钮，用户会看到一个点不动的「完成」却找不到任何红色提示。
    // 金额还没输入（null）时无从比较——注意 0 元是合法金额，能比。
    return kind === 'expense' && splitOpen && cents !== null && shareTotal() > cents;
  }

  function canSubmit() {
    if (saving || submitted) return false;
    if (cents === null) return false;              // 0 元能提交，只有 null 是「没输入金额」
    if (accountId === null) return false;          // 账户全被归档时记不了账（种子数据保证非空）
    if (kind === 'transfer' && (!toAccountId || toAccountId === accountId)) return false;
    if (shareOverflow()) return false;
    return true;
  }

  function updateDone() {
    doneBtn.disabled = !canSubmit();
  }

  function updateError() {
    errorNode.textContent = errorText;
    errorNode.hidden = errorText === '';
  }

  function updateShareNote() {
    if (!shareNote) return;
    const over = shareOverflow();
    shareNote.className = over ? 'form-error share-note' : 'muted tiny share-note';
    shareNote.textContent = over
      ? '分摊合计不能超过金额'
      : `分摊合计 ${formatCents(shareTotal(), { symbol: true })}`;
    updateDone();
  }

  function blankShare() {
    return { personName: '', amountText: '', amountCents: null };
  }

  // —— 各区块渲染 ——

  function renderKindSwitch() {
    return el('div', { class: 'kind-switch' }, KINDS.map(k =>
      el('button', {
        type: 'button',
        // 必须是字符串：CSS 只对 [aria-selected="true"] 生效，而 el() 会跳过 false 值。
        'aria-selected': String(k.id === kind),
        text: k.label,
        onclick: () => switchKind(k.id)
      })
    ));
  }

  function renderCategories() {
    const list = catsOf(kind);
    if (list.length === 0) return el('div', { class: 'muted tiny', text: '还没有可用分类' });
    return el('div', { class: 'cat-grid' }, list.map(c =>
      el('button', {
        class: c.id === categoryId ? 'cat-cell selected' : 'cat-cell',
        type: 'button',
        onclick: () => { categoryId = c.id; render(); }
      }, [
        el('span', { class: 'cat-icon', text: c.icon || '📦' }),
        el('span', { text: c.name })
      ])
    ));
  }

  function accountOptions(selectedId) {
    return accounts.map(a =>
      el('option', { value: a.id, text: a.name, selected: a.id === selectedId }));
  }

  function renderAccounts() {
    if (accounts.length === 0) {
      return el('div', { class: 'muted tiny', text: '还没有可用账户，记不了账' });
    }
    if (kind === 'transfer') {
      return el('div', { class: 'row entry-accounts' }, [
        el('div', { class: 'field' }, [
          el('label', { text: '从' }),
          // 改账户只更新状态 + 重算按钮，不 render()：重建 select 会丢掉它的展开状态。
          el('select', { onchange: e => { accountId = e.target.value; updateDone(); } }, accountOptions(accountId))
        ]),
        el('span', { class: 'muted', text: '→' }),
        el('div', { class: 'field' }, [
          el('label', { text: '到' }),
          el('select', { onchange: e => { toAccountId = e.target.value; updateDone(); } }, accountOptions(toAccountId))
        ])
      ]);
    }
    return el('div', { class: 'field' }, [
      el('label', { text: '账户' }),
      el('select', { onchange: e => { accountId = e.target.value; updateDone(); } }, accountOptions(accountId))
    ]);
  }

  function renderTimeNote() {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '时间' }),
        el('input', {
          type: 'datetime-local',
          value: toLocalInputValue(occurredAt),
          // 这里刻意不 render()：重建 input 会让正在编辑的控件丢焦点。
          // 值存在 occurredAt / note 上，下次整块重建时按状态回填，用户输入不会丢。
          oninput: e => {
            const ts = fromLocalInputValue(e.target.value);
            if (ts !== null) occurredAt = ts;
          }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '备注' }),
        el('input', {
          type: 'text',
          value: note,
          placeholder: '备注（可选）',
          oninput: e => { note = e.target.value; }
        })
      ])
    ]);
  }

  function renderSplit() {
    const toggle = el('input', {
      type: 'checkbox',
      checked: splitOpen,
      onchange: e => {
        splitOpen = e.target.checked;
        // 勾上时先给一行空行，否则用户勾完看到的是一片空白，不知道下一步该做什么。
        if (splitOpen && shares.length === 0) shares.push(blankShare());
        render();
      }
    });
    const toggleRow = el('label', { class: 'split-toggle' }, [
      toggle,
      el('span', { text: '有人分摊' })
    ]);

    if (!splitOpen) {
      shareNote = null;
      return el('div', { class: 'stack' }, [toggleRow]);
    }

    const rows = shares.map((s, i) => el('div', { class: 'share-row' }, [
      el('input', {
        type: 'text',
        value: s.personName,
        placeholder: '对方姓名',
        oninput: e => { s.personName = e.target.value; }
      }),
      el('input', {
        type: 'text',
        inputmode: 'decimal',
        value: s.amountText,
        placeholder: '金额',
        oninput: e => {
          s.amountText = e.target.value;
          // parseAmountToCents 对非法输入返回 null（'' 和 '.' 也是 null）。
          // 文本要留着：重渲染时按文本回填，用户输到一半也不会被改写。
          s.amountCents = parseAmountToCents(e.target.value);
          // 只更新提示与按钮状态，不重建 DOM，避免正在输入的金额框丢焦点。
          updateShareNote();
        }
      }),
      el('button', {
        class: 'btn share-del',
        type: 'button',
        text: '✕',
        'aria-label': '删除这一行',
        onclick: () => { shares.splice(i, 1); render(); }
      })
    ]));

    shareNote = el('div', { class: 'muted tiny share-note' });
    const box = el('div', { class: 'stack' }, [
      toggleRow,
      ...rows,
      el('button', {
        class: 'btn',
        type: 'button',
        text: '加一行',
        onclick: () => { shares.push(blankShare()); render(); }
      }),
      shareNote
    ]);
    updateShareNote();
    return box;
  }

  // 整块重建 body 的各个区块。keypad.node 与 doneBtn 是同一批元素对象，
  // mount() 只是把它们挪个位置，状态与事件监听都还在。
  function render() {
    // 非支出时把提示节点的引用清掉：它已经从 DOM 上摘下来，再往这个游离节点写文字
    // 没人看得见，还会让下一次 updateShareNote 以为提示还挂在页面上。
    if (kind !== 'expense') shareNote = null;

    mount(body,
      renderKindSwitch(),
      keypad.node,
      kind === 'transfer' ? null : renderCategories(),
      renderAccounts(),
      renderTimeNote(),
      kind === 'expense' ? renderSplit() : null,
      errorNode,
      doneBtn
    );
    // 每次重建后同步一次按钮状态：切 kind / 改分摊都会影响 canSubmit。
    updateDone();
  }

  function switchKind(next) {
    if (next === kind) return;
    kind = next;
    // 金额与账户保留（用户切错了不想重输），只重算分类默认值。
    categoryId = defaultCategoryIdFor(kind);
    // 收入/转账不该带分摊：勾选状态和已填的行都清掉。留着只会让这几行藏在面板里，
    // 下次切回支出时又冒出来，而用户根本不知道它们是哪来的。
    splitOpen = false;
    shares = [];
    if (kind === 'transfer' && (!toAccountId || toAccountId === accountId)) {
      toAccountId = firstOtherAccount();
    }
    render();
  }

  // —— 提交 ——

  async function submit() {
    // disabled 的按钮点不动，但回车提交、程序触发仍可能进来，这里再兜一道。
    if (!canSubmit()) return;
    saving = true;
    errorText = '';
    updateError();
    updateDone();

    // 分摊只属于支出，且必须处于「有人分摊」勾选状态：取消勾选后这些行既不显示也不提交，
    // 否则用户会记下一笔自己看不见的分摊。切 kind 时已经清空，这里再兜一层；且只传
    // { personName, amountCents }：direction / sourceTxnId / 结算状态由 store.addTransaction
    // 统一补，UI 不越权。
    const payloadShares = kind === 'expense' && splitOpen
      ? shares
          .filter(s => s.personName.trim() !== '' && s.amountCents !== null && s.amountCents > 0)
          .map(s => ({ personName: s.personName.trim(), amountCents: s.amountCents }))
      : [];

    let txn = null;
    try {
      txn = await store.addTransaction({
        kind,
        amountCents: cents,
        categoryId: kind === 'transfer' ? null : categoryId,
        accountId,
        toAccountId: kind === 'transfer' ? toAccountId : null,
        // 兜底：万一 occurredAt 成了非法值，宁可记成「现在」也不能把 NaN 写进库。
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.now(),
        note,
        shares: payloadShares
      });
    } catch (err) {
      // 保存失败绝不关面板：用户填的金额、分类、分摊都还在，看到原因后能直接重试。
      errorText = `保存失败：${err?.message || err}`;
      updateError();
      console.error(err);
      saving = false;
      updateDone();
      return;
    }

    // 成功之后就锁死：面板收起有 180ms 动画，这期间再点「完成」不能插第二笔。
    submitted = true;
    saving = false;
    updateDone();

    // 记住这次用的账户，下次打开默认还是它。
    // 单独 try：写设置失败不该被当成「记账失败」——那会让用户重试，结果记两笔。
    try {
      await store.setSetting('lastAccountId', accountId);
    } catch (err) {
      console.error(err);
    }

    sheet.close();
    if (onSaved) onSaved();
    showUndoToast({
      onUndo: async () => {
        await store.deleteTransaction(txn.id);
        // 撤销后首页的月度汇总、今日流水、应收都要跟着回去，所以再通知一次。
        if (onSaved) onSaved();
      }
    });
  }

  render();
}
