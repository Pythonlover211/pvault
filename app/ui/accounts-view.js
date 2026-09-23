// 账户管理（任务 17）。入口在首页月份行的齿轮按钮 → 设置面板 →「账户管理」。
//
// 只开一层 sheet：列表与编辑是同一个面板里切换的两块内容（mount(body, ...)），
// 不嵌套第二层面板。理由见 sheet.js——两层 sheet 都改 document.body.style.overflow，
// 关掉任意一层都会把它清空，另一层开着时背景却能滚动。
//
// 归档代替删除：账户被历史交易引用，物理删除会让统计断裂（流水里的账户名变空、
// 按账户汇总对不上）。归档即隐藏，录入面板的账户下拉不会再出现它，因为 store.listAccounts()
// 过滤 archived —— 本视图用的是 store.listAllAccounts()，它不过滤，所以已归档项仍能看见并恢复。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import * as store from '../store.js';

// 账户类型的中文名。未知类型原样显示 id，不吞掉数据。
const KIND_LABEL = { cash: '现金', savings: '储蓄', credit: '信用卡' };
const KIND_OPTIONS = [
  { id: 'cash', label: '现金' },
  { id: 'savings', label: '储蓄' },
  { id: 'credit', label: '信用卡' }
];
// 图标快捷选择：覆盖种子数据里的五个 + 三个常见补充。
const EMOJI_QUICK = ['💵', '💚', '🅰️', '🏦', '💳', '📱', '🪙', '👛'];

export function openAccountsSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  // openSheet 会把标题渲染成自己那个 span，无法回填新标题，这里把它替换成可写的节点：
  // 「账户管理 / 新增账户 / 编辑账户」三种标题共用同一个面板头。
  const titleNode = el('span', { text: '账户管理' });
  const sheet = openSheet({ title: '账户管理', body });
  const headTitle = sheet.panel.querySelector('.sheet-head span');
  if (headTitle) headTitle.replaceWith(titleNode);

  let view = 'list';     // 'list' | 'edit'
  let accounts = [];
  let form = null;       // 编辑视图的表单状态（见 blankForm）
  let errorText = '';
  let loadFailed = false;

  function blankForm() {
    return {
      id: null,          // null = 新增
      name: '',
      kind: 'cash',
      icon: '',
      trackBalance: false,
      billDay: '',
      dueDay: '',
      archived: false,
      sort: null        // 只有编辑既有账户时才是数字
    };
  }

  function formOf(account) {
    return {
      id: account.id,
      name: account.name || '',
      kind: account.kind || 'cash',
      icon: account.icon || '',
      trackBalance: !!account.trackBalance,
      // 数字输入框回填用字符串：null / undefined 都要变成 ''，否则控件里会显示 "null"。
      billDay: account.billDay == null ? '' : String(account.billDay),
      dueDay: account.dueDay == null ? '' : String(account.dueDay),
      archived: !!account.archived,
      sort: account.sort
    };
  }

  // 1~28 的日期输入。越界或非数字一律得到 null（= 不设），绝不把非法日期写进库：
  // 账单日 31 号在 2 月不存在，后续算账单周期时是个定时炸弹。
  function dayOf(text) {
    const n = Number.parseInt(text, 10);
    return Number.isInteger(n) && n >= 1 && n <= 28 ? n : null;
  }

  async function load() {
    try {
      accounts = await store.listAllAccounts();
      loadFailed = false;
    } catch (err) {
      // 读失败不能让面板变成一片空白：给出文字提示，用户至少知道发生了什么。
      accounts = [];
      loadFailed = true;
      console.error(err);
    }
  }

  // 新建时 sort 取现有最大值 + 1；编辑时**原样保留** sort（含 0、负数）——
  // 排序决定账户在列表与下拉里的位置，改个名字不该把它挪到末尾。
  async function nextSort() {
    const all = await store.listAllAccounts();
    return all.reduce((max, a) => Math.max(max, Number(a.sort) || 0), 0) + 1;
  }

  // 表单状态 → 待写入的账户对象。归档/保存两条路径共用，避免两处字段各写一份、
  // 某一处漏了 billDay 的清空逻辑。
  async function buildAccount({ archived }) {
    const editing = form.id !== null;
    const name = form.name.trim();
    return {
      id: editing ? form.id : store.uid(),
      // 编辑既有账户时名称不可能为空（保存按钮已禁用），兜底只为「新增时直接点归档」这种路径。
      name: name === '' ? (editing ? (accounts.find(a => a.id === form.id)?.name || '未命名') : '未命名') : name,
      kind: form.kind,
      icon: form.icon.trim(),
      trackBalance: form.trackBalance,
      // 非信用卡不写账单日/还款日：类型切回储蓄后，上次填的日期不该继续挂在账户上。
      billDay: form.kind === 'credit' ? dayOf(form.billDay) : null,
      dueDay: form.kind === 'credit' ? dayOf(form.dueDay) : null,
      archived,
      sort: editing ? form.sort : await nextSort()
    };
  }

  // 写库 + 重新读列表 + 通知调用方。失败时留在原地显示错误，不关面板、不丢用户填的内容。
  async function persist(account) {
    errorText = '';
    try {
      const saved = await store.saveAccount(account);
      await load();
      if (onChanged) onChanged();
      return saved;
    } catch (err) {
      errorText = `保存失败：${err?.message || err}`;
      render();
      console.error(err);
      return null;
    }
  }

  function errorNode() {
    return el('div', { class: 'form-error', hidden: errorText === '', text: errorText });
  }

  // —— 编辑视图 ——

  function renderEdit() {
    const saveBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: '保存',
      // 名称必填：空名字的账户在流水里显示成空白，等于数据丢失。
      // 新增时这里是 true（el() 只跳过 null/undefined/false，所以 true 会写成 disabled="true"）；
      // 解禁走下面 oninput 里的 saveBtn.disabled = false。
      disabled: form.name.trim() === '' ? true : null,
      onclick: () => save()
    });

    const nameInput = el('input', {
      type: 'text',
      value: form.name,
      placeholder: '账户名称（必填）',
      // 只改按钮状态、不 render()：重建 input 会让正在输入的名称框丢焦点。
      oninput: e => {
        form.name = e.target.value;
        saveBtn.disabled = form.name.trim() === '';
      }
    });

    const iconInput = el('input', {
      type: 'text',
      value: form.icon,
      placeholder: '一个 emoji，如 💳',
      oninput: e => { form.icon = e.target.value; }
    });
    const quickRow = el('div', { class: 'emoji-quick' }, EMOJI_QUICK.map(emoji =>
      el('button', {
        type: 'button',
        text: emoji,
        'aria-label': `使用图标 ${emoji}`,
        onclick: () => {
          form.icon = emoji;
          // 只回填输入框的值，不重建 DOM：重建会丢焦点，也会让快捷按钮在指尖下换位置。
          iconInput.value = emoji;
        }
      })));

    const kindSelect = el('select', {
      onchange: e => {
        form.kind = e.target.value;
        // 类型决定「账单日/还款日」是否显示，必须重建这一小段；其余输入框都按 form 回填，
        // 用户已输入的名称/图标不丢。
        render();
      }
    }, KIND_OPTIONS.map(k => el('option', { value: k.id, text: k.label, selected: k.id === form.kind })));

    const nodes = [
      el('div', { class: 'field' }, [el('label', { text: '名称' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: '图标' }), iconInput, quickRow]),
      el('div', { class: 'field' }, [el('label', { text: '类型' }), kindSelect]),
      el('label', { class: 'split-toggle' }, [
        el('input', {
          type: 'checkbox',
          checked: form.trackBalance,
          onchange: e => { form.trackBalance = e.target.checked; }
        }),
        el('span', { text: '追踪余额' })
      ]),
      el('div', { class: 'muted tiny', text: '储蓄类账户一般只当标签用，不必追踪余额；信用卡建议开启，方便对账单。' })
    ];

    // 账单日 / 还款日只在信用卡下出现。留空表示不设（存 null），不是 0。
    if (form.kind === 'credit') {
      nodes.push(el('div', { class: 'row entry-accounts' }, [
        el('div', { class: 'field' }, [
          el('label', { text: '账单日（留空不设）' }),
          el('input', {
            type: 'number', min: '1', max: '28', value: form.billDay,
            oninput: e => { form.billDay = e.target.value; }
          })
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: '还款日（留空不设）' }),
          el('input', {
            type: 'number', min: '1', max: '28', value: form.dueDay,
            oninput: e => { form.dueDay = e.target.value; }
          })
        ])
      ]));
    }

    nodes.push(errorNode());
    nodes.push(el('div', { class: 'form-actions' }, [
      saveBtn,
      el('button', {
        class: form.archived ? 'btn' : 'btn btn-danger',
        type: 'button',
        text: form.archived ? '恢复' : '归档',
        onclick: () => setArchived(!form.archived)
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: '返回',
        onclick: () => { view = 'list'; render(); }
      })
    ]));

    return el('div', { class: 'stack' }, nodes);
  }

  // —— 列表视图 ——

  function renderList() {
    const rows = accounts.map(account => el('div', { class: 'manage-row', 'data-account': account.id }, [
      el('div', { class: 'manage-main' }, [
        el('span', { class: 'manage-name', text: `${account.icon || '📦'} ${account.name}` }),
        el('span', { class: 'manage-kind', text: KIND_LABEL[account.kind] || account.kind || '' }),
        account.archived ? el('span', { class: 'manage-archived', text: '已归档' }) : null
      ]),
      el('button', {
        class: 'btn',
        type: 'button',
        text: '编辑',
        onclick: () => { form = formOf(account); errorText = ''; view = 'edit'; render(); }
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: account.archived ? '恢复' : '归档',
        onclick: () => toggleArchived(account, !account.archived)
      })
    ]));

    return el('div', { class: 'stack' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '＋ 新增账户',
        onclick: () => { form = blankForm(); errorText = ''; view = 'edit'; render(); }
      }),
      errorNode(),
      loadFailed
        ? el('div', { class: 'empty', text: '账户读取失败，请稍后重试' })
        : (rows.length === 0
            ? el('div', { class: 'empty', text: '还没有账户' })
            : el('div', {}, rows)),
      el('div', { class: 'muted tiny', text: '归档的账户不再出现在记账的账户选择里，历史流水不受影响。' })
    ]);
  }

  // —— 保存 / 归档 ——

  async function save() {
    if (form.name.trim() === '') return;
    const saved = await persist(await buildAccount({ archived: form.archived }));
    if (saved === null) return;   // 写失败：留在编辑视图看错误
    view = 'list';
    render();
  }

  // 列表里的快捷按钮：直接改那一条的 archived，不经过表单（表单可能正停着别的账户）。
  async function toggleArchived(account, archived) {
    await persist({ ...account, archived });
    render();
  }

  // 编辑视图里的按钮：先把表单里的其它改动一起落盘再改 archived，
  // 否则「改了名字顺手点归档」会把名字的改动一起丢掉。
  async function setArchived(archived) {
    form.archived = archived;
    const saved = await persist(await buildAccount({ archived }));
    if (saved === null) return;
    view = 'list';
    render();
  }

  function render() {
    titleNode.textContent = view === 'edit'
      ? (form.id === null ? '新增账户' : '编辑账户')
      : '账户管理';
    mount(body, view === 'edit' ? renderEdit() : renderList());
  }

  // 先把空列表渲染出来（面板立刻滑出），账户读回来后再补一次。
  render();
  load().then(render);
  return sheet;
}
