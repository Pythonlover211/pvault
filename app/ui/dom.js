// 极简 DOM 构造工具。零依赖、无构建，所以不引入任何模板引擎：
// 所有视图都用 el() 声明式地拼节点，用 mount() 整体替换容器内容。
//
// 约定：
// - class / text / html / dataset / on* 是特殊键，其余一律走 setAttribute。
// - null / undefined / false 的 prop 与 child 会被跳过，方便写 `cond && el(...)`。
// - 注意 html 走 innerHTML，只在内容是可信常量时使用；用户数据一律用 text。
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, ...nodes) {
  clear(parent);
  parent.append(...nodes.flat().filter(Boolean));
  return parent;
}
