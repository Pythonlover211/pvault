// 分类管理（任务 17）。入口在首页月份行的齿轮按钮 → 设置面板 →「分类管理」。
//
// 与 accounts-view.js 同一套结构：一个面板里切换「列表 / 编辑」两块内容，不嵌套第二层 sheet
// （两层 sheet 共用 document.body.style.overflow，关掉任一层都会把它清空，见 sheet.js）。
//
// 归档代替删除：分类被历史交易引用，物理删除会让那些交易在统计里凭空消失
// （summary.byCategory 找不到 categoryId 就跳过它），金额和分类明细会对不上。
// 归档后分类不再出现在录入面板的九宫格与 type 选择里（listCategories 过滤 archived）。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import * as store from '../store.js';

const KIND_OPTIONS = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' }
];
const KIND_LABEL = { expense: '支出', income: '收入' };
// 支出/收入的默认图标：新增时先给一个，省得用户每建一个分类都要挑 emoji。
const DEFAULT_ICON = { expense: '📦', income: '💰' };
const EMOJI_QUICK = ['🍜', '🚇', '🛍️', '🧴', '🎮', '💊', '🎁', '🏠', '💰', '🎉', '↩️', '📦'];

export function openCategoriesSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const titleNode = el('span', { text: '分类管理' });
  const sheet = openSheet({ title: '分类管理', body });
  const headTitle = sheet.panel.querySelector('.sheet-head span');
  if (headTitle) headTitle.replaceWith(titleNode);

  let view = 'list';        // 'list' | 'edit'
  let newPickerOpen = false; // 列表顶部「新增」展开的支出/收入选择
  let categories = [];
  let form = null;
  let errorText = '';
  let loadFailed = false;

  function blankForm(kind) {
    return {
      id: null,                    // null = 新增
      name: '',
      kind,
      icon: DEFAULT_ICON[kind] || '📦',
      archived: false,
      sort: ''                     // 只有编辑既有分类时才是数字
    };
  }

  function formOf(category) {
    return {
      id: category.id,
      name: category.name || '',
      kind: category.kind || 'expense',
      icon: category.icon || '',
      archived: !!category.archived,
      sort: category.sort == null ? '' : String(category.sort)
    };
  }

  // 排序号：只接受非负整数，其它一律当成「沿用原来的值」。
  // 用 0 兜底是危险的——用户手滑清空输入框就会把分类甩到最前面，而他什么都没改。
  function parseSort(text) {
    const n = Number.parseInt(text, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  async function load() {
    try {
      // 必须用 listAllCategories()（含归档）：管理界面要能看到并恢复已归档的分类。
      categories = await store.listAllCategories();
      loadFailed = false;
    } catch (err) {
      categories = [];
      loadFailed = true;
      console.error(err);
    }
  }

  // 新分类排在**同类型**末尾：支出与收入各自独立编号（种子数据就是这样），
  // 混着算最大值会让新加的支出分类排到很后面。
  function nextSort(kind) {
    return categories
      .filter(c => c.kind === kind)
      .reduce((max, c) => Math.max(max, Number(c.sort) || 0), 0) + 1;
  }

  // 表单状态 → 待写入的分类对象。保存与归档共用，避免两处字段各写一份。
  function buildCategory({ archived }) {
    const editing = form.id !== null;
    const name = form.name.trim();
    const parsed = parseSort(form.sort);
    return {
      id: editing ? form.id : store.uid(),
      name: name === '' ? (editing ? (categories.find(c => c.id === form.id)?.name || '未命名') : '未命名') : name,
      kind: form.kind,
      icon: form.icon.trim(),
      archived,
      // 编辑时排序框留空/非法 → 保留原 sort；新增时用同类型末尾 + 1。
      sort: parsed !== null ? parsed : (editing ? (categories.find(c => c.id === form.id)?.sort ?? 0) : nextSort(form.kind))
    };
  }

  async function persist(category) {
    errorText = '';
    try {
      const saved = await store.saveCategory(category);
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
      // 名称必填；新增时这里是 true，之后由 oninput 解禁（el() 只跳过 null/undefined/false）。
      disabled: form.name.trim() === '' ? true : null,
      onclick: () => save()
    });

    const nameInput = el('input', {
      type: 'text',
      value: form.name,
      placeholder: '分类名称（必填）',
      // 只改按钮状态，不 render()：重建 input 会让正在输入的名称框丢焦点。
      oninput: e => {
        form.name = e.target.value;
        saveBtn.disabled = form.name.trim() === '';
      }
    });

    const iconInput = el('input', {
      type: 'text',
      value: form.icon,
      placeholder: '一个 emoji，如 🍜',
      oninput: e => { form.icon = e.target.value; }
    });
    const quickRow = el('div', { class: 'emoji-quick' }, EMOJI_QUICK.map(emoji =>
      el('button', {
        type: 'button',
        text: emoji,
        'aria-label': `使用图标 ${emoji}`,
        onclick: () => {
          form.icon = emoji;
          iconInput.value = emoji;
        }
      })));

    const kindSelect = el('select', {
      onchange: e => {
        // 改类型不影响排序框、不管其它字段：整块重建由 onchange 后的 render() 完成，
        // 名称/图标/排序都按 form 回填。
        form.kind = e.target.value;
        render();
      }
    }, KIND_OPTIONS.map(k => el('option', { value: k.id, text: k.label, selected: k.id === form.kind })));

    const nodes = [
      el('div', { class: 'field' }, [el('label', { text: '名称' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: '图标' }), iconInput, quickRow]),
      el('div', { class: 'field' }, [el('label', { text: '类型' }), kindSelect]),
      el('div', { class: 'field' }, [
        el('label', { text: '排序（数字越小越靠前）' }),
        el('input', {
          type: 'number', min: '0', value: form.sort,
          oninput: e => { form.sort = e.target.value; }
        })
      ]),
      errorNode(),
      el('div', { class: 'form-actions' }, [
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
      ])
    ];

    return el('div', { class: 'stack' }, nodes);
  }

  // —— 列表视图 ——

  function categoryRow(c) {
    return el('div', { class: 'manage-row', 'data-category': c.id }, [
      el('div', { class: 'manage-main' }, [
        el('span', { class: 'manage-name', text: `${c.icon || '📦'} ${c.name}` }),
        c.archived ? el('span', { class: 'manage-archived', text: '已归档' }) : null
      ]),
      el('button', {
        class: 'btn',
        type: 'button',
        text: '编辑',
        onclick: () => { form = formOf(c); errorText = ''; view = 'edit'; render(); }
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: c.archived ? '恢复' : '归档',
        onclick: () => toggleArchived(c, !c.archived)
      })
    ]);
  }

  function renderGroup(kind) {
    const list = categories.filter(c => c.kind === kind);
    return el('div', { class: 'stack' }, [
      el('div', { class: 'group-title', text: KIND_LABEL[kind] }),
      list.length === 0
        ? el('div', { class: 'muted tiny', text: '这个类型下还没有分类' })
        : el('div', {}, list.map(categoryRow))
    ]);
  }

  function renderList() {
    const picker = newPickerOpen
      ? el('div', { class: 'chip-row' }, [
          el('span', { class: 'muted tiny', text: '新增：' }),
          ...KIND_OPTIONS.map(k => el('button', {
            class: 'btn',
            type: 'button',
            text: k.label,
            onclick: () => {
              newPickerOpen = false;
              form = blankForm(k.id);
              errorText = '';
              view = 'edit';
              render();
            }
          }))
        ])
      : null;

    return el('div', { class: 'stack' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: '＋ 新增分类',
        // 先选类型再进表单：默认支出会让想加收入分类的用户白填一遍再切类型。
        onclick: () => { newPickerOpen = !newPickerOpen; render(); }
      }),
      picker,
      errorNode(),
      loadFailed
        ? el('div', { class: 'empty', text: '分类读取失败，请稍后重试' })
        : el('div', { class: 'stack' }, [renderGroup('expense'), renderGroup('income')]),
      el('div', { class: 'muted tiny', text: '归档的分类不再出现在记账的分类九宫格里，历史流水不受影响。' })
    ]);
  }

  // —— 保存 / 归档 ——

  async function save() {
    if (form.name.trim() === '') return;
    const saved = await persist(buildCategory({ archived: form.archived }));
    if (saved === null) return;   // 写失败：留在编辑视图看错误
    view = 'list';
    render();
  }

  // 列表里的快捷按钮：直接改那一条的 archived，不经过表单。
  async function toggleArchived(category, archived) {
    await persist({ ...category, archived });
    render();
  }

  // 编辑视图里的按钮：先把表单里的其它改动一起落盘再改 archived，
  // 否则「改了名字顺手点归档」会把名字的改动一起丢掉。
  async function setArchived(archived) {
    form.archived = archived;
    const saved = await persist(buildCategory({ archived }));
    if (saved === null) return;
    view = 'list';
    render();
  }

  function render() {
    titleNode.textContent = view === 'edit'
      ? (form.id === null ? '新增分类' : '编辑分类')
      : '分类管理';
    mount(body, view === 'edit' ? renderEdit() : renderList());
  }

  // 先把空列表渲染出来（面板立刻滑出），分类读回来后再补一次。
  render();
  load().then(render);
  return sheet;
}
