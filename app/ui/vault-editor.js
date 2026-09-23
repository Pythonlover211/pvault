// 密码箱条目编辑器（任务 9）：新建 / 编辑 / 删除三类条目。
//
// 接口是任务 8 就定下的 { item, onSaved }：item 为 null 表示新建，onSaved 在保存成功后回调
// （调用方 vault-view 用整块重渲染响应它）。列表的「＋ 新建」与详情的「编辑」两处调用方
// 一行都没改过。
//
// 四条纪律：
// 1. **不嵌套第二层 sheet**：sheet.js 的每一层都把 document.body.style.overflow 设成 'hidden'，
//    而 close() 一律清空它——两层同时挂着时，关掉任意一层都会把另一层的滚动锁解掉。
//    所以「选类型」「填表单」「删除确认」全部在这一层里切换内容（与 budget-view 同源做法）。
// 2. **类型的可改性只在新建时存在**：ITEM_TYPES[type].fields 决定表单有哪些字段，
//    编辑到一半换类型，已填的内容该留还是该丢没有正确答案。选定即锁死；编辑既有条目只读展示。
// 3. **卡号是纯显示层格式化**：输入框里每 4 位一个空格（便于和卡片逐位核对），
//    进库前一律 replace(/\s/g, '')。存储层与搜索结果里永远是裸数字——
//    带空格的卡号会让「搜索 62258888」搜不到，也会让 maskSecret 多打出一串点。
// 4. **条目内容不进控制台**：报错只打 err 本身，绝不打 item（尤其密码）。
//    骨架版那句 `console.log('vault editor not implemented yet', item)` 正是这里要消灭的东西。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import * as vaultStore from '../vault-store.js';
import { uid } from '../store.js';
import { ITEM_TYPES, FIELD_LABELS, SECRET_FIELDS, emptyItem, validateItem } from '../vault-model.js';

// 与 vault-view 的 MIN_PASSWORD 取值相同、含义不同：那边是主密码长度下限（有密码学含义），
// 这里只是「别让卡号被格式化成别的东西」的守卫——出现非数字就说明输入的不是卡号。
const DIGIT_ONLY = /^\d*$/;

// 每 4 位插一个空格。**唯一**允许把空格加进卡号的地方（存库前会被去掉）。
function groupDigits(text) {
  return String(text).replace(/\s/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

// 用户删掉最后一个字符时，浏览器传进来的值形如 '6225 8888 '（空格还在），
// 只管分组的话它会立刻被重新拼回来——退格键看起来失灵。这里显式识别这种形态，退一位数字。
function deleteLastDigit(raw) {
  return /[ -]$/.test(raw) ? raw.replace(/[ -]+$/, '').slice(0, -1) : raw;
}

export function openVaultEditor({ item, onSaved } = {}) {
  const isEdit = Boolean(item);
  // 新建时类型未定（null）；编辑时以条目自己的类型为起点。两者都**只改一次**，见纪律 2。
  let type = isEdit ? item.type : null;
  // 表单字段与原始条目解耦：编辑时保留 id/createdAt/updatedAt，字段值单独收在这里。
  const fields = {};
  let busy = false;

  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: isEdit ? '编辑条目' : '新建条目', body });

  // —— 类型选择（仅新建且尚未选定）——

  function typeChooser() {
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', text: '选择要保存的类型。类型决定这条要填哪些字段，选定后不能再改。' }),
      el('div', { class: 'stack' }, Object.entries(ITEM_TYPES).map(([key, def]) =>
        el('button', {
          class: 'btn manage-entry', type: 'button',
          dataset: { type: key },
          text: `${def.icon} ${def.label}`,
          onclick: () => { type = key; paint(); }
        })
      ))
    ]);
  }

  // —— 表单 ——

  // 字段行。number 类型走分组格式化（见纪律 3），SECRET_FIELDS 走 type="password" + 显示切换。
  function fieldRow(key) {
    const label = FIELD_LABELS[key] || key;
    const isNumber = key === 'number';
    // 秘密字段的判据**只能**来自 vault-model 的 SECRET_FIELDS——不在 UI 里再写一份
    // 「哪些字段是秘密」的名单：两处名单迟早会不一致，而这里写错的后果是密码明文显示在屏幕上。
    const isSecret = SECRET_FIELDS.has(key);
    // 初始值：卡号按 4 位分组显示（可读），进库前再脱掉空格。
    const initial = isNumber ? groupDigits(fields[key] || '') : String(fields[key] || '');
    const input = el('input', {
      type: isSecret ? 'password' : 'text', autocomplete: 'off',
      class: 'vault-input',
      value: initial,
      oninput: e => {
        if (isNumber) {
          // e.target.value 是浏览器给出的结果值，直接当输入结果用；仅当它含非数字时才清理。
          const raw = DIGIT_ONLY.test(e.target.value) ? e.target.value : deleteLastDigit(e.target.value);
          fields[key] = raw.replace(/\s/g, '');
          e.target.value = groupDigits(raw);
        } else {
          fields[key] = e.target.value;
        }
      }
    });

    const nodes = [
      el('label', { text: label }),
      input
    ];

    if (isSecret) {
      // 只切 input 的 type 属性：值一直在主 input 里，不做「再画一个明文框」——
      // 两份 DOM 都有值时，隐藏后明文仍留在页面里，那是假遮罩。
      let shown = false;
      const toggle = el('button', {
        class: 'btn vault-mini', type: 'button', text: '显示',
        onclick: () => {
          shown = !shown;
          input.setAttribute('type', shown ? 'text' : 'password');
          toggle.textContent = shown ? '隐藏' : '显示';
        }
      });
      // 输入框与切换按钮同一行：.vault-field-row 的 input 自己带宽度，不需要外层 grid。
      return el('div', { class: 'field vault-field-row' }, [
        nodes[0],
        el('div', { class: 'vault-field-inline' }, [input, toggle])
      ]);
    }

    return el('div', { class: 'field vault-field-row' }, nodes);
  }

  // openSheet 的标题是自己渲染的 span，无法回填，这里换成可写节点（同 budget-view）。
  const titleNode = el('span');
  const headTitle = sheet.panel.querySelector('.sheet-head span');
  if (headTitle) headTitle.replaceWith(titleNode);

  function paint() {
    titleNode.textContent = isEdit ? '编辑条目' : '新建条目';

    // 新建、还没选类型：这一层里只放类型选择，不出现任何字段输入框
    // （空表单先长出来再被换掉，会让人以为「已经可以开始填了」）。
    if (!type) {
      mount(body, [typeChooser()]);
      return;
    }

    const typeDef = ITEM_TYPES[type];
    titleNode.textContent = isEdit ? '编辑条目' : `新建${typeDef?.label ?? '条目'}`;
    // 新建时表单里没有「类型」输入框（选完就没了），所以顶部补一行只读展示：
    // 用户随时能确认自己在填哪一类，也解释了字段为什么是这几个。
    const header = [el('div', { class: 'vault-hint', text: `类型：${typeDef?.icon ?? '🔒'} ${typeDef?.label ?? type}` })];

    const titleInput = el('input', {
      type: 'text', autocomplete: 'off', placeholder: '给这条起个名字',
      value: String(fields.title || ''),
      oninput: e => { fields.title = e.target.value; }
    });

    const errorsNode = el('div', { class: 'vault-error', dataset: { role: 'editor-errors' } });
    const saveBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '保存',
      onclick: () => { save(errorsNode); }
    });

    const children = header.concat([
      el('section', { class: 'card stack' }, [
        el('div', { class: 'field' }, [el('label', { text: '标题' }), titleInput]),
        ...(typeDef?.fields ?? Object.keys(fields).filter(k => k !== 'title')).map(fieldRow)
      ]),
      errorsNode,
      // 保存与删除同一行：删除是破坏性操作，放在最后一排的右侧，与保存拉开距离。
      el('div', { class: 'form-actions' }, isEdit ? [deleteBtn(), saveBtn] : [saveBtn])
    ]);
    mount(body, children);
  }

  // —— 保存 ——

  function collect(now) {
    const next = { type, title: String(fields.title || '').trim(), fields: {} };
    // 字段集合严格照 ITEM_TYPES[type].fields 生成：表单里没出现的键绝不进库。
    // 类型不认识时（老版本数据、被外部改过的库）退回「已填的字段」而不是抛 TypeError——
    // 这种情况下该由 validateItem 给出「未知的条目类型」这句人话，不是崩溃。
    const keys = ITEM_TYPES[type]?.fields ?? Object.keys(fields).filter(k => k !== 'title');
    for (const f of keys) next.fields[f] = String(fields[f] ?? '');
    if (isEdit) {
      // id 与 createdAt 原样保留：它们是这条记录的身份与「什么时候建的」，
      // 编辑内容不该改变它们（详情页的排序与后续同步都依赖 id 稳定）。
      next.id = item.id;
      next.createdAt = item.createdAt;
    } else {
      next.id = uid();
      next.createdAt = now;
    }
    next.updatedAt = now;
    // 兜底：无论上面哪个分支，进库前一律脱空格。卡号可能在 fields 里以任何形态存在，
    // 去空格这一步不能只挂在 oninput 上（粘贴、程序化赋值都绕得过去）。
    for (const [k, v] of Object.entries(next.fields)) {
      if (k === 'number') next.fields[k] = String(v).replace(/\s/g, '');
    }
    return next;
  }

  async function save(errorsNode) {
    if (busy) return;
    const draft = collect(Date.now());
    const check = validateItem(draft);
    if (!check.ok) {
      // 逐条列出 + 面板不关闭 + 不写库。这是「校验失败」与「保存失败」的合流点：
      // 前者是用户能当场改的，后者只能重试，文案分开写但走同一个显示位。
      mount(errorsNode, check.errors.map(msg => el('div', { text: msg })));
      return;
    }
    mount(errorsNode, []);
    busy = true;
    try {
      const items = await vaultStore.loadItems();
      const idx = isEdit ? items.findIndex(i => i.id === draft.id) : -1;
      // 先整包读出、再整包写回（条目整体加密，没有单条更新）。
      // 找不到原条目时当作新增追加，而不是静默丢掉——用户点了保存就应当留下东西。
      const next = idx >= 0
        ? items.map((i, n) => (n === idx ? draft : i))
        : items.concat([draft]);
      await vaultStore.saveItems(next);
    } catch (err) {
      // 失败必须解锁按钮，否则用户被卡在一个再也点不动的「保存」上。
      busy = false;
      mount(errorsNode, [el('div', { text: '保存失败：' + (err?.message || err) })]);
      // 只打 err，绝不打 draft/items（里面有明文密码）。
      console.error('密码箱条目保存失败', err);
      return;
    }
    // 写库成功了才关面板：关面板是「已经落库」的信号，不能先关再写。
    busy = false;
    sheet.close();
    if (onSaved) onSaved();
  }

  // —— 删除（仅编辑既有条目）——

  function deleteBtn() {
    let armed = false;
    const btn = el('button', {
      class: 'btn btn-danger', type: 'button', text: '删除',
      onclick: () => {
        // 二次确认：第一次点击只把按钮变成「确认删除？」，再点一次才真的删。
        // 刻意不用 confirm()：原生弹窗样式无法统一，在 PWA 里还会打断整页；
        // 而按钮就长在原来的位置上，撤销成本为零。
        if (!armed) {
          armed = true;
          btn.textContent = '确认删除？';
          return;
        }
        remove(btn);
      }
    });
    return btn;
  }

  async function remove(btn) {
    if (busy) return;
    busy = true;
    try {
      const items = await vaultStore.loadItems();
      await vaultStore.saveItems(items.filter(i => i.id !== item.id));
    } catch (err) {
      busy = false;
      btn.textContent = '删除失败';
      console.error('密码箱条目删除失败', err);
      return;
    }
    busy = false;
    sheet.close();
    if (onSaved) onSaved();
  }

  // 编辑既有条目：把存储里的字段复制进本地状态。只取该类型定义的字段，
  // 旧版本留下的多余字段不会跟着回写（避免把历史垃圾越带越多）。
  if (isEdit) {
    for (const f of ITEM_TYPES[type]?.fields ?? Object.keys(item.fields ?? {})) {
      fields[f] = String(item.fields?.[f] ?? '');
    }
    fields.title = String(item.title ?? '');
  }

  paint();
  return sheet;
}
