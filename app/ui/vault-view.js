// 密码箱主视图（任务 7）：三态 —— 初始化引导 / 锁屏 / 列表。
//
// 状态机的唯一判据是仓库层的两个函数，本文件不自己记「我上锁了没」：
//   isInitialized() === false                    → 初始化引导（含恢复码展示）
//   isInitialized() === true && !isUnlocked()    → 锁屏
//   isUnlocked() === true                        → 列表（任务 8）
// 之所以不在视图里缓存状态：空闲 5 分钟自动上锁的判定在 vault-store 内部（谁先问到谁负责
// 清会话并发通知），视图每次渲染前重新问一遍，就永远不会显示一个已经不成立的界面。
//
// 两条不能破的纪律：
// 1. 锁屏状态下**一个条目字段都不许进 DOM**。列表分支是唯一调用 loadItems() 的地方，
//    它只可能在 isUnlocked() 为真时进入——锁屏页里没有任何路径能读到条目数据。
// 2. 同一时刻只允许存在一个 onLockChange 订阅，见 bindLockChange()。
import { el, mount } from './dom.js';
import * as vaultStore from '../vault-store.js';
import { formatRecoveryCode } from '../recovery-code.js';
import {
  ITEM_TYPES, FIELD_LABELS, SECRET_FIELDS,
  searchItems, groupItems, maskSecret, itemSummary
} from '../vault-model.js';
import { copyWithAutoClear } from './clipboard.js';
import { openVaultEditor } from './vault-editor.js';

const MIN_PASSWORD = 8;
const FAIL_THRESHOLD = 3;
const UNLOCK_DELAY_MS = 1000;

// 当前渲染序号：每次 renderVault 自增。异步流程（读存储、等延迟、读条目）在每一步之后
// 都要拿自己的 seq 跟它对一下，不是最后一次渲染就立刻停手——否则快速切 Tab 时，
// 先发起、后完成的那次渲染会把界面盖回去（main.js 的 renderSeq 只保证外壳不被盖）。
let activeSeq = 0;
// 当前唯一活跃的退订函数。
let activeUnsub = null;

// 锁屏页的「连续失败次数」放模块级：错误提示是改 textContent 显示的，但一旦重渲染
// （比如上锁通知把界面换了一遍）局部变量就归零了，用户会看到延迟莫名消失。
let lockFailCount = 0;

// 「用恢复码访问」提示要跨渲染持续显示：恢复码解锁成功后置真，用主密码成功解锁后置假
// （那时候用户显然知道主密码，这条提醒就没有意义了）。页面刷新即回到初始值——会话本来也只活在内存里。
let usingRecoveryCode = false;

function releaseSubscription() {
  if (activeUnsub) {
    activeUnsub();
    activeUnsub = null;
  }
}

// 只保留一个活跃订阅。renderVault 每次切到这个 Tab 都会被 main.js 调用一次，
// 若每次订阅却从不取消，listeners 会随切换次数线性增长：一次上锁要跑 N 遍回调，
// 其中 N-1 遍渲染的是一个早就不在页面上的旧容器（而且会各自再订阅一次，越滚越多）。
function bindLockChange(root, seq) {
  releaseSubscription();
  const off = vaultStore.onLockChange(unlocked => {
    // 迟到的旧订阅：自己已经不是最后一次渲染了，什么都不做（正常情况下它早被取消）。
    if (seq !== activeSeq) return;
    // 解锁不在这里处理：解锁成功的那段代码自己会重渲染，它比这条通知更清楚接下来该显示什么。
    if (unlocked) return;
    renderVault(root).catch(err => console.error('密码箱重新渲染失败', err));
  });
  // 订阅动作本身是同步的，但「订阅期间又发生了一次渲染」仍可能成立（回调里嵌套渲染），
  // 这时要把自己摘掉，不能把陈旧的订阅留在仓库层。
  if (seq !== activeSeq) {
    off();
    return;
  }
  activeUnsub = off;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function renderVault(root) {
  const seq = ++activeSeq;
  // 先断旧订阅再做任何 await：等待期间发生的任何通知都不该由一个即将被替换的视图处理。
  releaseSubscription();

  let initialized;
  try {
    initialized = await vaultStore.isInitialized();
  } catch (err) {
    if (seq !== activeSeq) return;
    mount(root, el('div', { class: 'empty', text: '密码箱状态读取失败：' + (err?.message || err) }));
    console.error(err);
    return;
  }
  if (seq !== activeSeq) return;

  if (!initialized) {
    mount(root, renderIntro(root, seq));
    bindLockChange(root, seq);
    return;
  }
  // isUnlocked() 自己带空闲超时判定，所以问它这一次就等于「顺手把该锁的锁掉」。
  if (vaultStore.isUnlocked()) {
    await renderList(root, seq);
    bindLockChange(root, seq);
    return;
  }
  mount(root, renderLock(root, seq));
  bindLockChange(root, seq);
}

// —— 一态：初始化引导 ——

function renderIntro(root, seq) {
  let pw = '';
  let confirmPw = '';
  let busy = false;

  const errorNode = el('div', { class: 'vault-error' });
  const createBtn = el('button', {
    class: 'btn btn-primary', type: 'button', text: '创建密码箱', disabled: true,
    onclick: () => { create(); }
  });

  // 只切按钮禁用态，不整页重渲染：重建 input 会让正在输入的那个框丢焦点。
  function refresh() {
    createBtn.disabled = !(pw.length >= MIN_PASSWORD && pw === confirmPw);
  }

  async function create() {
    if (busy || createBtn.disabled) return;
    busy = true;
    createBtn.disabled = true;
    errorNode.textContent = '';
    try {
      const { recoveryCode } = await vaultStore.initVault(pw);
      if (seq !== activeSeq) return;
      // 恢复码只在这一个瞬间存在：initVault 不会把它写进任何可再读的地方，
      // 所以这里必须当场展示，绝不能「稍后再显示」。
      mount(root, renderRecovery(root, seq, recoveryCode));
    } catch (err) {
      // 失败必须把按钮还原，否则用户被卡在一个再也点不动的界面上。
      busy = false;
      refresh();
      errorNode.textContent = '创建失败：' + (err?.message || err);
      console.error(err);
    }
  }

  return el('div', { class: 'vault-wrap' }, [
    el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', text: '密码箱把网站密码、银行卡资料和零散备注都锁在这台设备上，只有你的主密码能打开它。' }),
      el('div', { class: 'vault-warn', text: '忘记主密码没有任何找回方式。你会得到一串恢复码，请抄下来离线保存——它和主密码一样重要，丢了就再也打不开。' })
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '主密码（至少 8 位）' }),
      el('input', {
        type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位',
        oninput: e => { pw = e.target.value; refresh(); }
      })
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '再输一次' }),
      el('input', {
        type: 'password', autocomplete: 'new-password', placeholder: '两次要一致',
        oninput: e => { confirmPw = e.target.value; refresh(); }
      })
    ]),
    errorNode,
    createBtn
  ]);
}

// —— 二态：恢复码展示（不允许跳过）——

function renderRecovery(root, seq, code) {
  const formatted = formatRecoveryCode(code);

  const enterBtn = el('button', {
    class: 'btn btn-primary', type: 'button', text: '进入密码箱', disabled: true,
    onclick: () => {
      // 禁用态在某些浏览器里仍可能被脚本触发，这里再兜一道。
      if (enterBtn.disabled) return;
      renderVault(root).catch(err => console.error(err));
    }
  });
  const check = el('input', {
    type: 'checkbox',
    onchange: () => { enterBtn.disabled = !check.checked; }
  });
  const copyBtn = el('button', {
    class: 'btn', type: 'button', text: '复制',
    onclick: () => { copy(formatted, copyBtn); }
  });

  return el('div', { class: 'vault-wrap' }, [
    el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-warn', text: '这是你的恢复码，恢复码只显示这一次——离开这个界面之后再没有地方能看到它。' }),
      // formatRecoveryCode 给出 8 组 4 字符；等宽大字号便于逐组核对，也允许选中。
      el('div', { class: 'vault-code', text: formatted }),
      el('div', { class: 'vault-code-row' }, [copyBtn])
    ]),
    el('label', { class: 'vault-check' }, [
      check,
      el('span', { text: '我已抄写并妥善保存这串恢复码' })
    ]),
    el('div', { class: 'vault-hint', text: '忘记主密码时，只有这串恢复码能拿回密码箱里的内容。' }),
    enterBtn
  ]);
}

// 复制失败一律静默：非安全上下文（局域网 http://）、用户拒绝授权都会失败，
// 而恢复码此刻就在屏幕上，手抄完全可行，弹一个红字反而更吓人。
async function copy(text, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '已复制';
  } catch {
    btn.textContent = '复制失败';
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// —— 三态：锁屏 ——

function renderLock(root, seq) {
  let pw = '';
  let code = '';
  let codeOpen = false;
  let busy = false;

  const errorNode = el('div', { class: 'vault-error' });
  const codeArea = el('div', { class: 'stack' });
  // 恢复码那一路的按钮节点随卡片展开而重建，所以留个引用而不是去 querySelector 找它
  // （既少一次选择器匹配，也让「哪条路在用哪个按钮」在代码里一眼可见）。
  let codeBtn = null;

  const unlockBtn = el('button', {
    class: 'btn btn-primary', type: 'button', text: '解锁',
    onclick: () => { attempt('password'); }
  });
  const pwInput = el('input', {
    type: 'password', autocomplete: 'current-password', placeholder: '主密码',
    oninput: e => { pw = e.target.value; },
    onkeydown: e => { if (e.key === 'Enter') attempt('password'); }
  });
  const toggleBtn = el('button', {
    class: 'link-like muted tiny', type: 'button', text: '用恢复码解锁',
    onclick: () => { codeOpen = !codeOpen; paintCodeArea(); }
  });

  function paintCodeArea() {
    toggleBtn.textContent = codeOpen ? '收起恢复码输入' : '用恢复码解锁';
    mount(codeArea, codeOpen ? [codeInputRow()] : []);
  }

  function codeInputRow() {
    codeBtn = el('button', {
      class: 'btn', type: 'button', text: '解锁',
      onclick: () => { attempt('code'); }
    });
    return el('div', { class: 'vault-lock' }, [
      el('div', { class: 'field' }, [
        el('label', { text: '恢复码' }),
        el('input', {
          type: 'text', autocomplete: 'off', placeholder: 'ABCD-EFGH-…',
          oninput: e => { code = e.target.value; }
        })
      ]),
      codeBtn
    ]);
  }

  async function attempt(kind) {
    if (busy) return;
    busy = true;
    const btn = kind === 'code' ? codeBtn : unlockBtn;
    const target = btn || unlockBtn;
    const label = target.textContent;

    // 连错 3 次之后，每次尝试前先等 1 秒。真正的防线是 PBKDF2 的迭代次数，
    // 这一秒的作用是让手动逐个试密码变慢、并给「是不是记错了」留出停顿。
    if (lockFailCount >= FAIL_THRESHOLD) {
      target.disabled = true;
      target.textContent = '请稍候…';
      await sleep(UNLOCK_DELAY_MS);
      // 等待期间界面可能已经被换掉（切了 Tab、被空闲上锁）：别再往旧节点上写状态。
      if (seq !== activeSeq) return;
    }

    let ok = true;
    try {
      if (kind === 'code') await vaultStore.unlockWithRecoveryCode(code);
      else await vaultStore.unlock(pw);
    } catch {
      // 底层异常一律不抛给用户：这里只区分「哪条路不对」，文案在下面按 kind 给。
      ok = false;
    }
    if (seq !== activeSeq) return;

    if (!ok) {
      lockFailCount += 1;
      busy = false;
      target.disabled = false;
      target.textContent = label;
      errorNode.textContent = kind === 'code' ? '恢复码不正确或已损坏' : '主密码不正确';
      return;
    }

    // 成功：连续失败清零，否则下次上锁后第一次输错又要等 1 秒。
    lockFailCount = 0;
    // 用恢复码进来的人需要持续被提醒去改密码；用主密码进来的人不需要。
    usingRecoveryCode = kind === 'code';
    busy = false;
    await renderVault(root);
  }

  paintCodeArea();

  return el('div', { class: 'vault-wrap vault-lock' }, [
    el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', text: '密码箱已锁定。输入主密码解锁，密钥只在内存里，不会写进磁盘。' }),
      el('div', { class: 'field' }, [
        el('label', { text: '主密码' }),
        pwInput
      ]),
      errorNode,
      unlockBtn,
      toggleBtn,
      codeArea
    ])
  ]);
}

// —— 列表、搜索与详情（已解锁）——
// 数据只读一次（loadItems），列表与详情共用这一份，互相切换时不必重新解密。
// 搜索只在列表区局部重画，不整块重渲染（见 paintList 的注释）。
async function renderList(root, seq) {
  mount(root, el('div', { class: 'empty', text: '正在打开密码箱…' }));

  let items;
  try {
    items = await vaultStore.loadItems();
  } catch (err) {
    if (seq !== activeSeq) return;
    mount(root, el('div', { class: 'empty', text: '密码箱读取失败：' + (err?.message || err) }));
    console.error(err);
    return;
  }
  if (seq !== activeSeq) return;
  // 读的过程中可能已经被空闲上锁（loadItems 会 requireSession，正常应当抛错），
  // 这里再确认一次：宁可多问一句，也不能把明文条目留在锁屏之上。
  if (!vaultStore.isUnlocked()) {
    await renderVault(root);
    return;
  }

  // 列表状态收在这一处：搜索词、当前详情、写操作锁、错误文案。
  // 它们都不放模块级——离开密码箱这个 Tab 就该全部忘掉，尤其是 detailId。
  let query = '';
  let detailId = null;
  let busy = false;
  let errorText = '';

  const wrap = el('div', { class: 'vault-wrap' });
  mount(root, wrap);

  const goList = () => { detailId = null; errorText = ''; paint(); };
  const goDetail = id => { detailId = id; errorText = ''; paint(); };

  function openEditor(item) {
    // 任务 9 才实现真正的编辑器；保存成功后整块重读一次，
    // 不在本地拼条目，避免界面上的数据和存储里的密文对不上。
    openVaultEditor({
      item,
      onSaved: () => { renderVault(root).catch(err => console.error('密码箱重新渲染失败', err)); }
    });
  }

  // 列表与详情共用一次数据读取：paint() 决定画哪一个，两者之间切换不必重新解密。
  function paint() {
    const item = detailId ? items.find(i => i.id === detailId) : null;
    // 条目可能在别处被删掉了（或 detailId 来自一份过期的界面）：退回列表，
    // 而不是渲染一个字段全空的详情壳子。
    if (detailId && !item) detailId = null;
    const children = [];
    // 「用恢复码访问」的提醒要一直挂在页面顶部，切进详情也不该消失。
    if (usingRecoveryCode) {
      children.push(el('div', { class: 'vault-warn', text: '你正在用恢复码访问，建议尽快修改主密码' }));
    }
    children.push(item ? detailView(item) : listView());
    mount(wrap, children);
  }

  // —— 列表 ——

  function listView() {
    const listArea = el('div', { class: 'stack' });
    const countNode = el('div', { class: 'vault-count tiny muted' });
    const searchInput = el('input', {
      class: 'vault-search', type: 'search', placeholder: '搜索标题、用户名、备注',
      value: query,
      oninput: e => { query = e.target.value; paintList(); }
    });

    // 输入时只重画下面的列表区，不重建搜索框本身：重建会让正在输入的那个框丢焦点，
    // 中文输入法正在拼的词也会一起丢掉。
    function paintList() {
      const q = query.trim();
      const matched = searchItems(items, q);

      if (q && matched.length === 0) {
        countNode.textContent = '';
        mount(listArea, el('div', { class: 'empty', text: '没有匹配的条目' }));
        return;
      }
      countNode.textContent = q ? `${matched.length} 条匹配` : '';

      if (items.length === 0) {
        mount(listArea, el('div', { class: 'empty', text: '密码箱还是空的，点「＋ 新建」放第一条进来' }));
        return;
      }

      const groups = groupItems(matched);
      const sections = [];
      // ITEM_TYPES 的顺序就是分组顺序；空分组直接跳过，新用户不会看到
      // 「银行卡与证件（0）」这种纯噪音。
      for (const [type, def] of Object.entries(ITEM_TYPES)) {
        const rows = groups[type] ?? [];
        if (rows.length === 0) continue;
        sections.push(el('section', { class: 'card stack' }, [
          el('div', { class: 'vault-group-title', text: `${def.label}（${rows.length}）` }),
          el('div', { class: 'vault-list' }, rows.map(rowView))
        ]));
      }
      mount(listArea, sections);
    }

    paintList();

    return el('div', { class: 'stack' }, [
      el('div', { class: 'vault-toolbar' }, [
        searchInput,
        el('button', {
          class: 'btn', type: 'button', text: '＋ 新建',
          onclick: () => openEditor(null)
        })
      ]),
      countNode,
      listArea,
      el('div', { class: 'vault-foot' }, [
        el('button', {
          class: 'btn', type: 'button', text: '锁定',
          // lock() 会广播 false，订阅回调把界面切回锁屏——这里不自己重渲染，
          // 手动上锁和空闲上锁走同一条路，避免两条路各自实现一遍而行为不一致。
          onclick: () => { vaultStore.lock(); }
        })
      ])
    ]);
  }

  // 行是 button：整行可点、键盘可达，不需要额外挂点击处理。
  function rowView(item) {
    const def = ITEM_TYPES[item.type];
    return el('button', {
      class: 'vault-row', type: 'button',
      onclick: () => goDetail(item.id)
    }, [
      el('span', { class: 'vault-row-icon', text: def ? def.icon : '🔒' }),
      el('span', { class: 'vault-row-main' }, [
        el('span', { class: 'vault-row-title', text: item.title || '（未命名）' }),
        el('span', { class: 'vault-row-sub', text: itemSummary(item) })
      ])
    ]);
  }

  // —— 详情 ——

  function detailView(item) {
    const def = ITEM_TYPES[item.type];
    // 字段顺序照 ITEM_TYPES[type].fields 走；空字段不列出来——
    // 一排「备注：」空行除了占地方没有别的用处。
    const keys = (def ? def.fields : Object.keys(item.fields ?? {}))
      .filter(k => String(item.fields?.[k] ?? '').trim() !== '');

    const fields = keys.length
      ? keys.map(key => fieldView(key, String(item.fields[key])))
      : [el('div', { class: 'vault-hint', text: '这条还没有填写任何内容' })];

    let armed = false;
    const delBtn = el('button', {
      class: 'btn btn-danger', type: 'button', text: '删除',
      onclick: () => {
        // 二次确认：第一次点击只把按钮变成「确认删除？」，再点一次才真的删。
        // 这里刻意不用 confirm()：那是同步阻塞的原生弹窗，样式无法统一，
        // 在 PWA 里还会打断整页；而按钮就长在原来的位置上，撤销成本为零。
        if (!armed) {
          armed = true;
          delBtn.textContent = '确认删除？';
          return;
        }
        if (busy) return;
        busy = true;
        errorText = '';
        removeItem(item).then(() => { goList(); }).catch(err => {
          busy = false;
          errorText = '删除失败：' + (err?.message || err);
          console.error(err);
          paint();
        });
      }
    });

    return el('div', { class: 'stack' }, [
      errorText ? el('div', { class: 'vault-error', text: errorText }) : null,
      el('button', {
        class: 'link-like muted tiny', type: 'button', text: '← 返回列表',
        onclick: () => goList()
      }),
      el('section', { class: 'card stack' }, [
        el('div', { class: 'vault-detail-head' }, [
          el('span', { class: 'vault-row-icon', text: def ? def.icon : '🔒' }),
          el('span', { class: 'vault-row-main' }, [
            el('span', { class: 'vault-row-title', text: item.title || '（未命名）' }),
            el('span', { class: 'vault-row-sub', text: def ? def.label : '' })
          ])
        ]),
        el('div', { class: 'vault-fields' }, fields)
      ]),
      el('div', { class: 'vault-actions' }, [
        el('button', { class: 'btn', type: 'button', text: '编辑', onclick: () => openEditor(item) }),
        delBtn
      ])
    ]);
  }

  function fieldView(key, value) {
    const isSecret = SECRET_FIELDS.has(key);
    // 掩码态与明文态都只是文本节点：隐藏时 DOM 里根本没有明文——刻意不给 input 赋值，
    // 因为「值在 value 属性里、只是显示成圆点」会给人一种是遮罩的错觉，看源码就能读到。
    const valueNode = el('span', {
      class: 'vault-value',
      text: isSecret ? maskSecret(value) : value
    });
    const nodes = [
      el('span', { class: 'vault-detail-label', text: FIELD_LABELS[key] || key }),
      valueNode
    ];

    if (isSecret) {
      let shown = false;
      const toggle = el('button', {
        class: 'btn vault-mini', type: 'button', text: '显示',
        onclick: () => {
          shown = !shown;
          valueNode.textContent = shown ? value : maskSecret(value);
          toggle.textContent = shown ? '隐藏' : '显示';
        }
      });
      nodes.push(toggle);
    }

    const copyBtn = el('button', {
      class: 'btn vault-mini', type: 'button', text: '复制',
      onclick: () => { doCopy(copyBtn, value); }
    });
    nodes.push(copyBtn);

    return el('div', { class: 'vault-detail-row' }, nodes);
  }

  // 删除要走整包重写（条目整体加密，没有单条删除），所以先按 id 过滤再 saveItems。
  async function removeItem(item) {
    const next = items.filter(i => i.id !== item.id);
    await vaultStore.saveItems(next);
    items = next;
  }

  paint();
}

// 复制成功短暂显示「已复制」，失败（非安全上下文、权限被拒）时按钮自己说明结果，
// 不弹 alert：按钮就在手指底下，是比弹窗更近的反馈位。
async function doCopy(btn, value) {
  try {
    await copyWithAutoClear(value);
    btn.textContent = '已复制';
  } catch {
    btn.textContent = '复制失败';
  }
  setTimeout(() => { btn.textContent = '复制'; }, 1500);
}
