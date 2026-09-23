// 预算设置（任务 18）。入口在首页月份行的齿轮按钮 → 设置面板 →「预算设置」。
//
// 与 accounts-view.js / categories-view.js 同一套结构：**一个 panel 里切换「列表 / 编辑固定支出」
// 两块内容**，不嵌套第二层 sheet（两层 sheet 共用 document.body.style.overflow，
// 关掉任一层都会把它清空，见 sheet.js）。
//
// 写回的是三个设置项：
// - budgetTotalCents：整数分，0 = 未设（首页据此决定要不要渲染预算卡）
// - budgetByCategory：{ [categoryId]: cents }，**没有键 = 这个分类没设预算**，
//   所以清空输入框必须删掉这个键，而不是写 0（stats-view 把 0 也当「没设」，但留一堆
//   0 值键会让设置项越滚越大，也让「用户到底设过哪些分类」变得不可读）
// - recurring：固定支出数组，每项 { id, name, amountCents, categoryId, accountId, dayOfMonth, enabled, lastPromptedAt }
//
// 金额回填纪律（与 keypad.setFromCents、entry-panel 同源）：
// 回填到输入框的必须是**纯数字文本** `(cents / 100).toFixed(2)`，不能用 formatCents()——
// 后者带 ¥ 前缀，parseAmountToCents('¥12.40') 返回 null，用户一打开面板金额就变空了。
// 这里额外多兜一层 parseAmount()：用户从别处粘贴「¥1,500」时能读回 150000 而不是直接判非法。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { formatCentsShort, parseAmountToCents } from '../money.js';
import * as store from '../store.js';

const DAY_MIN = 1;
const DAY_MAX = 28;   // 29/30/31 在短月不存在，固定支出只允许 1~28

// 分 → 输入框文本（纯数字，两位小数）。
function centsText(cents) {
  return (Number(cents) / 100).toFixed(2);
}

// 输入框文本 → 分。空、'.'、非法一律 null（表示「这一项不设」）。
// 先做一次宽松清洗：去掉货币符号、千分位逗号、空白与全角空格——
// 从账单里粘贴「¥1,500」是常见操作，直接判非法会让用户以为输入框坏了。
function parseAmount(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[¥￥,\s\u3000]/g, '');
  if (cleaned === '') return null;
  return parseAmountToCents(cleaned);
}

// 每月几号 → 1~28 的整数。越界钳制、非数字拒绝（返回 null 由调用方回退到上一个有效值）。
// 绝不把 0 或 29+ 写进库：0 号不存在，29 号在 2 月不存在，都是定时炸弹。
function parseDayOfMonth(text) {
  const n = Number.parseInt(text, 10);
  if (!Number.isInteger(n)) return null;
  return Math.min(DAY_MAX, Math.max(DAY_MIN, n));
}

export function openBudgetSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  // openSheet 的标题是自己渲染的 span，无法回填新标题，这里换成可写节点，
  // 让「预算设置 / 固定支出」两个视图共用同一个面板头。
  const titleNode = el('span', { text: '预算设置' });
  const sheet = openSheet({ title: '预算设置', body });
  const headTitle = sheet.panel.querySelector('.sheet-head span');
  if (headTitle) headTitle.replaceWith(titleNode);

  let view = 'list';         // 'list' | 'recurring'
  let categories = [];       // 全部（含归档），编辑固定支出时也要能看到已归档的分类名
  let accounts = [];         // 未归档
  let budgetTotalText = '';  // 列表视图里总预算输入框的文本
  let budgetTexts = {};      // categoryId → 分类预算输入框的文本
  let recurring = [];        // 固定支出数组（编辑中的那一项用对象替换，不做深拷贝）
  let form = null;           // 编辑视图的表单状态
  let errorText = '';
  let loadFailed = false;

  const catsOf = kind => categories.filter(c => !c.archived && c.kind === kind);

  function load() {
    return Promise.all([
      store.listAllCategories(),
      store.listAccounts(),
      store.getSetting('budgetTotalCents', 0),
      store.getSetting('budgetByCategory', {}),
      store.getSetting('recurring', [])
    ]).then(([cats, accs, total, byCat, rec]) => {
      categories = Array.isArray(cats) ? cats : [];
      accounts = Array.isArray(accs) ? accs : [];
      budgetTotalText = total ? centsText(total) : '';
      const map = byCat && typeof byCat === 'object' ? byCat : {};
      budgetTexts = {};
      for (const [id, cents] of Object.entries(map)) {
        // 0 与非法值按「没设」显示：留一个 0.00 会让用户以为自己设过 0 元预算。
        if (typeof cents === 'number' && cents > 0) budgetTexts[id] = centsText(cents);
      }
      recurring = Array.isArray(rec) ? rec : [];
      loadFailed = false;
    }).catch(err => {
      loadFailed = true;
      console.error(err);
    });
  }

  // 表单状态 → 待写入的固定支出条目。
  function buildRecurring() {
    const editing = form.id !== null;
    const name = form.name.trim();
    if (name === '') return null;   // 保存按钮已禁用，这里再兜一道
    const cents = parseAmount(form.amount);
    if (cents === null || cents <= 0) return null;
    const day = parseDayOfMonth(form.dayOfMonth);
    return {
      id: editing ? form.id : store.uid(),
      name,
      amountCents: cents,
      // 分类必须是支出类：固定支出（房租、话费、订阅）都是支出，选到收入分类会让
      // 录入面板填出来的那笔账挂在一个收入分类上，统计口径又要撕裂。
      categoryId: form.categoryId || null,
      accountId: form.accountId || null,
      dayOfMonth: day === null ? DAY_MIN : day,
      enabled: form.enabled,
      // 上一句「今天该记 X」的日期。本次任务只做展示提示，不改写它；
      // 留成字段是为了将来加「本月已提醒过」这类逻辑时不用再改数据结构。
      lastPromptedAt: editing ? (recurring.find(r => r.id === form.id)?.lastPromptedAt ?? null) : null
    };
  }

  function formOf(item) {
    return {
      id: item.id,
      name: item.name || '',
      amount: centsText(item.amountCents || 0),   // 回填纯数字，见文件头
      categoryId: item.categoryId || '',
      accountId: item.accountId || (accounts.length > 0 ? accounts[0].id : ''),
      dayOfMonth: item.dayOfMonth == null ? '' : String(item.dayOfMonth),
      enabled: item.enabled !== false         // 缺字段按启用处理
    };
  }

  function blankRecurring() {
    return {
      id: null,
      name: '',
      amount: '',
      categoryId: catsOf('expense').length > 0 ? catsOf('expense')[0].id : '',
      accountId: accounts.length > 0 ? accounts[0].id : '',
      dayOfMonth: '1',
      enabled: true
    };
  }

  function errorNode() {
    return el('div', { class: 'form-error', hidden: errorText === '', text: errorText });
  }

  // —— 列表视图 ——

  function renderBudgetTotal() {
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'muted tiny', text: '月度总预算' }),
      el('div', { class: 'field' }, [
        el('label', { text: '每月预算（元，留空表示不设）' }),
        el('input', {
          type: 'text', inputmode: 'decimal', value: budgetTotalText, placeholder: '如 5000',
          // 只更新状态、不 render()：重建 input 会让正在输入的框丢焦点。
          oninput: e => { budgetTotalText = e.target.value; }
        })
      ])
    ]);
  }

  function renderCategoryBudgets() {
    const list = catsOf('expense');
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'muted tiny', text: '分类预算' }),
      list.length === 0
        ? el('div', { class: 'muted tiny', text: '还没有支出分类' })
        : el('div', {}, list.map(c => el('div', { class: 'budget-row' }, [
            el('span', { class: 'budget-label', text: `${c.icon || '📦'} ${c.name}` }),
            el('input', {
              class: 'budget-amount',
              type: 'text', inputmode: 'decimal',
              value: budgetTexts[c.id] || '', placeholder: '不设',
              'aria-label': `${c.name} 的每月预算`,
              oninput: e => { budgetTexts[c.id] = e.target.value; }
            })
          ]))),
      el('div', { class: 'muted tiny', text: '留空表示这个分类不单独设预算；0 与留空等价。' })
    ]);
  }

  function recurringRow(item) {
    // 归档过的分类/账户在这里仍然显示名字（按 id 查名），否则用户会看到一条没有分类的固定支出。
    const cat = categories.find(c => c.id === item.categoryId);
    const acc = accounts.find(a => a.id === item.accountId);
    const meta = [cat ? `${cat.icon || '📦'} ${cat.name}` : '未选分类', acc ? acc.name : '未选账户']
      .join(' · ');
    return el('div', { class: 'recurring-row' }, [
      // 启用开关直接改 state 并重渲染：固定支出是纯配置数据，改 enabled 不影响它的其它字段。
      el('input', {
        type: 'checkbox', checked: item.enabled !== false,
        'aria-label': `${item.name} 启用`,
        onchange: e => { item.enabled = e.target.checked; render(); }
      }),
      el('div', { class: 'recurring-main' }, [
        el('div', { text: item.name || '未命名' }),
        el('div', {
          class: 'recurring-meta',
          // 列表行用简短金额（¥2,500 而不是 ¥2500.00）：这一行还要挤下分类与账户名。
          text: `${formatCentsShort(item.amountCents || 0)} · 每月 ${item.dayOfMonth} 号 · ${meta}`
        })
      ]),
      el('button', {
        class: 'btn', type: 'button', text: '编辑',
        onclick: () => { form = formOf(item); errorText = ''; view = 'recurring'; render(); }
      })
    ]);
  }

  function renderRecurring() {
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'muted tiny', text: '固定支出' }),
      el('button', {
        class: 'btn', type: 'button', text: '＋ 新增固定支出',
        onclick: () => { form = blankRecurring(); errorText = ''; view = 'recurring'; render(); }
      }),
      recurring.length === 0
        ? el('div', { class: 'muted tiny', text: '还没有固定支出。加一条后，到了设定的日子打开录入面板会提示你记这一笔。' })
        : el('div', {}, recurring.map(recurringRow)),
      el('div', { class: 'muted tiny', text: '停用的固定支出不会再出现在录入面板的提示里。' })
    ]);
  }

  function renderList() {
    return el('div', { class: 'stack' }, [
      errorNode(),
      loadFailed ? el('div', { class: 'empty', text: '预算设置读取失败，请稍后重试' }) : null,
      renderBudgetTotal(),
      renderCategoryBudgets(),
      renderRecurring(),
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '保存',
          // 保存按钮在底部（金额输入框是实时写 state 的，不需要逐项「确认」）。
          onclick: () => save()
        })
      ])
    ]);
  }

  // —— 固定支出编辑视图 ——

  function renderRecurringEdit() {
    const expenseCats = catsOf('expense');
    const saveBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '保存',
      disabled: form.name.trim() === '' ? true : null,
      onclick: () => saveRecurring()
    });

    const nodes = [
      el('div', { class: 'field' }, [
        el('label', { text: '名称' }),
        el('input', {
          type: 'text', value: form.name, placeholder: '如 房租',
          oninput: e => {
            form.name = e.target.value;
            saveBtn.disabled = form.name.trim() === '';
          }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '金额（元）' }),
        el('input', {
          type: 'text', inputmode: 'decimal', value: form.amount, placeholder: '如 2500',
          oninput: e => { form.amount = e.target.value; }
        })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '分类' }),
        expenseCats.length === 0
          ? el('div', { class: 'muted tiny', text: '还没有支出分类，先去分类管理建一个' })
          // 改分类不 render()：重建 select 会丢掉它的展开状态。
          : el('select', {
              onchange: e => { form.categoryId = e.target.value; }
            }, expenseCats.map(c =>
              el('option', { value: c.id, text: `${c.icon || '📦'} ${c.name}`, selected: c.id === form.categoryId })))
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '账户' }),
        accounts.length === 0
          ? el('div', { class: 'muted tiny', text: '还没有可用账户，先去账户管理建一个' })
          : el('select', {
              onchange: e => { form.accountId = e.target.value; }
            }, accounts.map(a =>
              el('option', { value: a.id, text: a.name, selected: a.id === form.accountId })))
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '每月几号（1~28）' }),
        el('input', {
          type: 'number', min: String(DAY_MIN), max: String(DAY_MAX), value: form.dayOfMonth,
          oninput: e => { form.dayOfMonth = e.target.value; },
          // 失焦时把非法/越界值钳回合法范围并**在界面上显示**钳制后的值：
          // 只在提交时静默改数，用户会以为自己填的 31 号生效了。
          onblur: e => {
            const day = parseDayOfMonth(form.dayOfMonth);
            form.dayOfMonth = String(day === null ? DAY_MIN : day);
            e.target.value = form.dayOfMonth;
          }
        }),
        el('div', { class: 'muted tiny', text: '只允许 1~28 号：29/30/31 在 2 月这类短月并不存在。' })
      ]),
      el('label', { class: 'split-toggle' }, [
        el('input', {
          type: 'checkbox', checked: form.enabled,
          onchange: e => { form.enabled = e.target.checked; }
        }),
        el('span', { text: '启用（到日子时在录入面板提示）' })
      ]),
      errorNode(),
      el('div', { class: 'form-actions' }, [
        saveBtn,
        // 固定支出是纯配置数据，没有历史交易引用它，删除是物理删除（不像账户/分类要归档）。
        el('button', {
          class: 'btn btn-danger', type: 'button', text: '删除',
          hidden: form.id === null ? true : null,
          onclick: () => removeRecurring()
        }),
        el('button', {
          class: 'btn', type: 'button', text: '返回',
          onclick: () => { view = 'list'; errorText = ''; render(); }
        })
      ])
    ];

    return el('div', { class: 'stack' }, nodes);
  }

  // —— 写回 ——

  async function writeSettings(entries) {
    for (const [key, value] of entries) {
      await store.setSetting(key, value);
    }
  }

  // 列表视图的「保存」：三个设置项一次性写回。写失败留在原地显示错误，不关面板、不丢用户输入。
  async function save() {
    const totalParsed = parseAmount(budgetTotalText);
    const byCategory = {};
    for (const [id, text] of Object.entries(budgetTexts)) {
      const cents = parseAmount(text);
      // 清空（或填 0 / 填非法值）→ 这个键**不存在**，不是存 0。
      if (cents !== null && cents > 0) byCategory[id] = cents;
    }
    errorText = '';
    try {
      await writeSettings([
        ['budgetTotalCents', totalParsed === null ? 0 : totalParsed],
        ['budgetByCategory', byCategory],
        ['recurring', recurring]
      ]);
    } catch (err) {
      errorText = `保存失败：${err?.message || err}`;
      render();
      console.error(err);
      return;
    }
    view = 'list';
    render();
    if (onChanged) onChanged();
  }

  async function saveRecurring() {
    const next = buildRecurring();
    if (next === null) {
      errorText = '请填写名称与大于 0 的金额';
      render();
      return;
    }
    const index = recurring.findIndex(r => r.id === next.id);
    if (index >= 0) recurring[index] = next;
    else recurring.push(next);

    errorText = '';
    try {
      // 只写 recurring 一项：用户改的是固定支出，不该顺手把列表视图里还没保存的预算改动落盘。
      await writeSettings([['recurring', recurring]]);
    } catch (err) {
      errorText = `保存失败：${err?.message || err}`;
      render();
      console.error(err);
      return;
    }
    view = 'list';
    render();
    if (onChanged) onChanged();
  }

  async function removeRecurring() {
    recurring = recurring.filter(r => r.id !== form.id);
    errorText = '';
    try {
      await writeSettings([['recurring', recurring]]);
    } catch (err) {
      errorText = `删除失败：${err?.message || err}`;
      render();
      console.error(err);
      return;
    }
    view = 'list';
    render();
    if (onChanged) onChanged();
  }

  function render() {
    titleNode.textContent = view === 'recurring'
      ? (form && form.id === null ? '新增固定支出' : '编辑固定支出')
      : '预算设置';
    mount(body, view === 'recurring' ? renderRecurringEdit() : renderList());
  }

  // 先把空列表渲染出来（面板立刻滑出），数据读回来后再补一次。
  render();
  load().then(render);
  return sheet;
}
