// 极简 DOM 桩：给「函数一调用就要 document」的那几个模块用——眼下是 app/ui/settle-sheet.js
// 以及它拉进来的 dom.js / sheet.js / keypad.js 三个。
//
// 为什么可以这么小：这几个 UI 文件是零框架、手写 el() + append 拼出来的，用到的 DOM 面只有
// createElement / createTextNode / append / removeChild / remove / setAttribute / className /
// classList / textContent / hidden / disabled / checked / value / addEventListener / document.body。
// 桩只做这些，**它不是 DOM 的仿真器**（与 tests/helpers/fake-browser.js 同一立场：
// 先把盖不住的差异列清楚，免得后来者把这里的绿读成「浏览器里也就这样」）。
//
// **它盖得住的是行为**：点一下按钮之后库里多了什么、控件此刻是什么状态、错误文案是什么。
// 这正是「UI 在 Node 里验不了」这句话不成立的地方——桩不用实现完整 DOM，只要能把点击喂进去、
// 把写入落到 fake-IndexedDB 上，就能验「连点两次会不会记出两笔」「空金额会不会静默落 0」这类
// 只有真机手点才撞得到的路径。
//
// **它盖不住**（每一条都可能让一条本来该红的断言变绿，别指望它）：
//  1. **布局与样式**：没有 CSS、没有 getComputedStyle、没有可见性计算。`.form-error` 的 hidden
//     只是一个属性，桩不会因为祖先 hidden 就隐藏子树——所以「错误写进已关闭的面板用户看不见」
//     这件事只能靠**代码结构**（不调 showError）来验，不能靠桩里的可见性。
//  2. **焦点、滚动、过渡**：sheet.js 的 180ms 收起动画在桩里只是 setTimeout(180)，
//     节点在被 remove() 之前一直留在 DOM 里、也一直可点——这与真实一致（busy 闸门要挡的正是这段）。
//  3. **事件冒泡与默认行为**：dispatch 只调**该节点自己**的监听器，不冒泡、不触发默认动作
//     （设 checkbox.checked 不会自动派发 change，要触发就显式 fireEvent）。
//  4. **select 只实现了单选选中态**：multiple / size / 键盘 / change 事件都不管。
//  5. **innerHTML 只存字符串、不解析**：桩里造不出新节点（ui 层也确实从不用它）。
//  6. **没有属性反射**：setAttribute('disabled', x) 只认「出现了就是真」，
//     与真实 DOM 的 booleans 反射规则只在这一种用法上对齐。
//
// 事件监听器用真实的 Map 存，click() 是一个**桩特有的方法**（真实 DOM 没有），
// 它按注册顺序 await 每个监听器——被测的 onclick 是 async 的，不 await 就看不到它写完库。

// confirm 的答案：默认放行（面板里只有「金额为 0」那一条路会问）。
let confirmAnswer = true;

class FakeClassList {
  constructor(node) { this.node = node; }

  _set() {
    return new Set(String(this.node.className || '').split(/\s+/).filter(Boolean));
  }

  _write(set) { this.node.className = [...set].join(' '); }

  add(...names) { const s = this._set(); for (const n of names) s.add(n); this._write(s); }

  remove(...names) { const s = this._set(); for (const n of names) s.delete(n); this._write(s); }

  contains(name) { return this._set().has(name); }
}

class FakeNode {
  constructor(tagName = null) {
    // tagName 为 null 表示文本节点（nodeType 3），这是 dom.js 的 `child instanceof Node` 之外
    // 唯一需要区分的差别。
    this.tagName = tagName === null ? null : String(tagName).toUpperCase();
    this.nodeType = tagName === null ? 3 : 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this._listeners = new Map();
    this._text = '';
    this._value = '';
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.selected = false;
    this.type = '';
  }

  get firstChild() { return this.childNodes[0] ?? null; }

  // 真实 textContent 是**递归**取子树文本，这里的 getter 照做——findByText 依赖它。
  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this._text + this.childNodes.map(c => c.textContent).join('');
  }

  set textContent(v) {
    this._text = v === null || v === undefined ? '' : String(v);
    this.childNodes = [];
  }

  get value() { return this._value; }

  set value(v) { this._value = v === null || v === undefined ? '' : String(v); }

  append(...nodes) {
    for (const raw of nodes) {
      const node = typeof raw === 'string' ? globalThis.document.createTextNode(raw) : raw;
      node.parentNode = this;
      this.childNodes.push(node);
      // select 的「没有显式 selected 时第一个 option 自动选中」是浏览器的默认行为，
      // 少了它，桩里的下拉永远是 value=''，断言就区分不出「选中了第一项」。
      if (typeof this._onChildAdded === 'function') this._onChildAdded(node);
    }
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    // 属性 -> 属性的同步：真实的 booleans 反射（disabled / hidden / checked / selected）
    // 在 ui 层只有「出现了就是真」这一种用法，桩照这个口径做，不做完整的反射规则。
    if (name === 'class') this.className = String(value);
    else if (name === 'value') this.value = value;
    else if (name === 'type') this.type = String(value);
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'hidden') this.hidden = true;
    else if (name === 'checked') this.checked = true;
    else if (name === 'selected') this.selected = true;
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  // 桩特有：把该节点的 click 监听器按注册顺序 await 一遍。
  async click() {
    for (const fn of this._listeners.get('click') ?? []) await fn({ type: 'click', target: this });
  }
}

class FakeOption extends FakeNode {
  constructor() {
    super('option');
    this._selected = false;
  }

  get selected() { return this._selected; }

  // 单选 select 里，把一个 option 设为选中会取消其它选项的选中——不实现这条，
  // 「浏览器显示第一项、后台变量是 null」这种不一致在桩上就显不出来。
  set selected(v) {
    this._selected = !!v;
    if (v && this.parentNode && this.parentNode.tagName === 'SELECT') this.parentNode._selectOnly(this);
  }
}

class FakeSelect extends FakeNode {
  constructor() { super('select'); }

  get options() { return this.childNodes.filter(n => n.tagName === 'OPTION'); }

  get value() {
    const hit = this.options.find(o => o._selected);
    return hit ? hit.value : '';
  }

  set value(v) {
    const str = v === null || v === undefined ? '' : String(v);
    // 真实 select 的 value setter：找不到匹配的 option 时**一个都不选**（value 报 ''）。
    const hit = this.options.find(o => o.value === str) ?? null;
    for (const o of this.options) o._selected = false;
    if (hit) hit._selected = true;
  }

  _selectOnly(keep) { for (const o of this.options) if (o !== keep) o._selected = false; }

  _onChildAdded(node) {
    if (node.tagName === 'OPTION' && !this.options.some(o => o._selected)) node._selected = true;
  }
}

function createElement(tag) {
  const name = String(tag).toLowerCase();
  if (name === 'select') return new FakeSelect();
  if (name === 'option') return new FakeOption();
  return new FakeNode(name);
}

/** 装上 document / Node / requestAnimationFrame / window（= globalThis，与浏览器一致）。 */
export function installFakeDom() {
  globalThis.document = {
    body: new FakeNode('body'),
    createElement,
    createTextNode: text => {
      const n = new FakeNode(null);
      n._text = String(text);
      return n;
    }
  };
  // dom.js 用的是裸的 `child instanceof Node`，所以 Node 必须是**全局**的同一个类。
  globalThis.Node = FakeNode;
  // sheet.js 在挂载后下一帧加 .open（否则过渡不播放）。桩里没有样式，帧就等于 setTimeout(0)。
  globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);
  // 真实浏览器里 window === globalThis。theme-store.js 靠 `typeof window !== 'undefined'`
  // 判断环境，装上之后它还会再看 matchMedia —— 桩上没有 matchMedia，走的仍是同一条安全分支。
  globalThis.window = globalThis;
  globalThis.confirm = () => confirmAnswer;
}

/** 清空 body（上一个用例残留的 sheet）。节点结构不清——表结构与 db 的缓存同理。 */
export function resetFakeDom() {
  globalThis.document.body.childNodes = [];
}

export function setConfirmAnswer(v) { confirmAnswer = v; }

/** 触发一个事件（桩不冒泡、不做默认动作，change 要自己派）。 */
export async function fireEvent(node, type) {
  for (const fn of node._listeners.get(type) ?? []) await fn({ type, target: node });
}

export function findAll(root, pred) {
  const out = [];
  const walk = node => {
    if (pred(node)) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

export function findOne(root, pred, label = '节点') {
  const hit = findAll(root, pred)[0];
  if (!hit) throw new Error(`桩里找不到${label}`);
  return hit;
}

/** 按文本找节点，返回**最深**的那个匹配（父节点的 textContent 必然包含子节点的文本）。 */
export function findByText(root, needle) {
  const matches = findAll(root, n => n.textContent.includes(needle));
  let deepest = null;
  let bestDepth = -1;
  for (const m of matches) {
    let d = 0;
    for (let p = m.parentNode; p; p = p.parentNode) d += 1;
    if (d > bestDepth) { bestDepth = d; deepest = m; }
  }
  return deepest;
}

/** 从任意节点往上走到根（面板 close() 之后节点会被摘出 body，断言仍要能看见它的子树）。 */
export function topOf(node) {
  let n = node;
  while (n.parentNode) n = n.parentNode;
  return n;
}
