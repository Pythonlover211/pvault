// 报销单的两个视图：列表（按状态分组）与详情（票 + 合计 + 时间线 + 操作）。
//
// 这个文件**不能**在浏览器之外直接跑起来（它静态依赖 settle-sheet → store → IndexedDB），
// 但它**能**在 Node 里被测：DOM 由 tests/helpers/fake-dom.js 顶上、IndexedDB 由
// tests/helpers/fake-browser.js 顶上，中间那几层是真的（与 settle-sheet.js 同一条路，
// 见 tests/reimburse-view.test.js）。别再写「UI 验不了」——那是在说桩盖不住的布局，
// 不是这里的行为（落库字段、屏幕上的文案、按钮的 disabled 全都验得了）。
//
// ⚠️ 依赖与缓存清单：本文件是被 ui/invoice-view.js **动态** import 的，**不在首屏 import 闭包里**，
// 所以 tests/boot-order.test.js 的守卫看不见它（那个守卫算的是静态 from '…' 的闭包）。
// 代价是：它自己静态依赖的 ./settle-sheet.js 与 ../reimburse-store.js 必须**跟本文件一起**
// 进 sw.js 的 ASSETS，否则已经装着旧缓存的设备在**离线**时切到「报销单」这一段，动态 import
// 会去网络取一个没缓存的文件 → 整段打不开（在线能用、离线白屏，而用户只在没网时碰上）。
import { el, mount } from './dom.js';
import { currentTab } from '../router.js';
import { formatCents } from '../money.js';
import { invoiceTitle, sumCents } from '../invoice-model.js';
import {
  STATUS, statusLabel, isActive, canEdit, canSubmit, canSettle, diffCents
} from '../reimburse-model.js';
import {
  listReimbursements, listInvoicesOf, getReimbursement,
  submitReimbursement, removeInvoiceFrom, deleteReimbursement
} from '../reimburse-store.js';
import { openSettleSheet } from './settle-sheet.js';
import { openInvoiceEditor } from './invoice-editor.js';
import { openSheet } from './sheet.js';

// 当前打开的报销单 id：null 表示在列表。存模块级，与 invoice-view 的 filter / keyword 同一做法——
// 切走再回来，用户应该还在他刚才那一单上。
let openId = null;

// 渲染序号。与 invoice-view.js 的 viewSeq 是同一类问题：main.js 的 renderSeq 只保证
// 「哪一次渲染有权挂 tabbar」，拦不住本视图在 await 之后自己写 root。
// 少了它，「进报销单详情后立刻点统计」会复现「统计高亮着、屏幕上是报销单」的错位。
let viewSeq = 0;

// 详情页的错误行（建出来就 hidden）。异步动作失败时写它，**不** mount 整块——
// 那会把用户正在看的详情整个重建，看起来像「页面自己跳了一下」。
// 与 settle-sheet.js 的 errorNode 同一约定（那里连同「别用 mount 重建面板」的理由一起写着）。
// 它必须是模块级的：动作处理器闭包捕获的是渲染那一刻的节点，重绘之后那个节点已经从屏幕上摘掉了，
// 往里写错误用户一个字都看不到。
let detailErrorNode = null;

// 动作失败：把 store 已经翻好的中文写进当前那个错误节点。
// 没有节点时（例如删除成功、已经切回列表）不能**静默**丢掉——留一条 console.error，
// 与 settle-sheet.js 处理「面板已收起时回调抛错」同一条纪律。
function fail(err) {
  const text = String(err?.message || err);
  if (!detailErrorNode) {
    console.error('报销单动作失败（当前页面没有可显示的错误行）', err);
    return;
  }
  detailErrorNode.textContent = text;
  detailErrorNode.hidden = false;
}

export async function renderReimbursements(root, { onSwitchToInvoices } = {}) {
  const seq = ++viewSeq;
  if (openId) return renderDetail(root, openId, { seq, onSwitchToInvoices });

  const all = await listReimbursements();
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;
  // 列表页没有动作错误行：详情页那一行已经随重绘摘掉了，置空免得 fail() 往一个不在屏幕上的节点写。
  detailErrorNode = null;

  // 每张单要显示「N 张 · 合计」，而这两个数都在发票表里，所以逐单查一次。
  // 报销单的数量是「人手动建的」，几十张顶天，不做批量化。
  const rows = await Promise.all(all.map(async r => ({ r, invoices: await listInvoicesOf(r.id) })));
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const active = rows.filter(({ r }) => isActive(r));
  const settled = rows.filter(({ r }) => r.status === STATUS.SETTLED);

  function card(r, invoices) {
    // 差额行只在**已到账**、**填了金额**、且**与合计不同**时出现。三个条件各有各的道理：
    //  · 没到账就没有「实际到账」这回事；
    //  · settledCents 为 null（只标记到账、没填金额）时 diffCents 本来就返回 null，这里的
    //    `!== null` 是一道**护栏**——不写它也能对，但那样就是把「不显示 ¥0.00」押在 diffCents
    //    的实现细节上了（它哪天改成对 null 返回 0，屏幕上就会冒出一行假差额）；
    //  · 差额为 0 不显示：没有差额就没有信息，一行「差额 ¥0.00」只是噪音。
    //    **所以这里判的是 diff 的真值，不是 `diffCents(...) !== null`**——后者会让 0 也渲染。
    const diff = (r.status === STATUS.SETTLED && r.settledCents !== null)
      ? diffCents(r.settledCents, invoices)
      : null;
    return el('button', {
      class: 'reimb-card', type: 'button',
      onclick: () => { openId = r.id; renderReimbursements(root, { onSwitchToInvoices }); }
    }, [
      el('div', { class: 'rc-head' }, [
        el('span', { class: 'rc-title', text: r.title }),
        el('span', { class: 'rc-status', text: statusLabel(r.status) })
      ]),
      el('div', { class: 'rc-meta', text: `${invoices.length} 张 · ${formatCents(sumCents(invoices), { symbol: true })}` }),
      diff ? el('div', {
        class: 'rc-diff',
        text: `实际到账 ${formatCents(r.settledCents, { symbol: true })} · 差额 ${formatCents(diff, { symbol: true })}`
      }) : null
    ]);
  }

  function group(title, list) {
    if (list.length === 0) return null;
    return el('div', { class: 'stack' }, [
      el('div', { class: 'muted tiny', text: `${title}（${list.length}）` }),
      ...list.map(({ r, invoices }) => card(r, invoices))
    ]);
  }

  mount(root,
    all.length === 0
      ? el('div', { class: 'empty' }, [
          el('div', { text: '还没有报销单' }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: '去发票里选几张',
            // 把「怎么开始」直接铺好：切回发票段并进入多选。参数形状是**跨文件契约**
            // （发票段那边的回调按 startSelecting 进入多选），改名字不会报错、只会点了没反应，
            // 所以 tests/reimburse-view.test.js 把这个形状钉住了。
            onclick: () => onSwitchToInvoices?.({ startSelecting: true })
          })
        ])
      : el('div', { class: 'stack' }, [
          group('进行中', active),
          group('已到账', settled)
        ].filter(Boolean))
  );
}

async function renderDetail(root, id, { seq, onSwitchToInvoices }) {
  const r = await getReimbursement(id);
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;
  // 单子不在了（另一个标签页删了、或数据被清过）：退回列表，而不是把一张空详情铺在屏幕上。
  if (!r) { openId = null; return renderReimbursements(root, { onSwitchToInvoices }); }

  const invoices = await listInvoicesOf(id);
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const total = sumCents(invoices);
  // settledCents 为 null（只标记到账、没记金额）时 diffCents 返回 null，差额那一行据此不渲染。
  const diff = diffCents(r.settledCents, invoices);
  const editable = canEdit(r);

  // 每次重绘换一个新节点：上一个已经随 mount 摘掉了（见 detailErrorNode 的注释）。
  detailErrorNode = el('div', { class: 'form-error', hidden: true });
  const errorNode = detailErrorNode;

  // 时间线：三个节点，未发生的灰显。已到账的单才显示到账节点的时间。
  const nodes = [
    { label: '创建', ts: r.createdAt },
    { label: '提交', ts: r.submittedAt },
    { label: '到账', ts: r.settledAt }
  ];

  const actions = [];
  // 判据用的是 canSubmit 而不是 canEdit：界面给出的按钮与 reimburse-store 放行的谓词同源，
  // 免得出现「界面给了按钮、store 却拒绝」这种自相矛盾的组合（今天两者等价，将来未必）。
  if (canSubmit(r)) {
    actions.push(el('button', {
      class: 'btn btn-primary', type: 'button', text: '提交给公司',
      // `.catch(fail)` 一个都不能省：onclick 返回的 Promise 在浏览器里**没人 await**，
      // 漏出去就是控制台里一条 unhandled rejection，而用户那头什么都不会变（settle-sheet
      // 的审查在同一个形状上踩过：async 回调的 rejection 必须被接住）。
      onclick: () => submitReimbursement(id)
        .then(() => renderReimbursements(root, { onSwitchToInvoices }))
        .catch(fail)
    }));
  }
  if (canSettle(r)) {
    actions.push(el('button', {
      class: 'btn btn-primary', type: 'button', text: '标记到账',
      onclick: () => openSettleSheet({
        reimb: r, invoices,
        // onSettled 的重绘由面板接住（settle-sheet 自己 try/catch 了 async 回调的 rejection）。
        onSettled: () => renderReimbursements(root, { onSwitchToInvoices })
      })
    }));
  }
  actions.push(el('button', {
    class: 'btn btn-danger', type: 'button', text: '删除',
    onclick: () => confirmDelete(r, () => {
      openId = null;
      renderReimbursements(root, { onSwitchToInvoices }).catch(fail);
    })
  }));

  mount(root, el('div', { class: 'stack' }, [
    el('button', {
      class: 'btn', type: 'button', text: '← 报销单',
      onclick: () => { openId = null; renderReimbursements(root, { onSwitchToInvoices }); }
    }),
    errorNode,
    el('div', { class: 'rd-title', text: r.title }),
    el('div', { class: 'muted tiny', text: statusLabel(r.status) }),

    // 票的列表。点一张进发票编辑器（那里能看到原图与全部字段）。
    invoices.length === 0
      ? el('div', { class: 'empty', text: '这张报销单还没有发票' })
      : el('div', {}, invoices.map(inv => el('div', { class: 'rd-inv' }, [
          el('button', {
            class: 'rd-inv-main', type: 'button', text: invoiceTitle(inv),
            onclick: () => openInvoiceEditor({
              id: inv.id,
              onSaved: () => renderReimbursements(root, { onSwitchToInvoices })
            })
          }),
          // ?? 0 在这里是**对的**：金额缺失时票本身还是可以显示的一行，
          // 而「没填」这件事已经由 invoice-editor 那边负责讲清楚。
          el('span', { class: 'rd-inv-amt', text: formatCents(inv.amountCents ?? 0, { symbol: true }) }),
          // 「移除」只在草稿态出现（规格 §6：提交给公司之后就不能再改这张单里的票）。
          editable ? el('button', {
            class: 'btn tiny', type: 'button', text: '移除',
            onclick: () => removeInvoiceFrom(id, inv.id)
              .then(() => renderReimbursements(root, { onSwitchToInvoices }))
              .catch(fail)
          }) : null
        ]))),

    el('div', { class: 'rd-total' }, [
      el('span', { text: '发票合计' }),
      el('span', { text: formatCents(total, { symbol: true }) })
    ]),
    r.status === STATUS.SETTLED ? el('div', { class: 'rd-total' }, [
      el('span', { text: '实际到账' }),
      // settledCents 为 null = 这单是「只标记到账、不记收入」标掉的，用户从没填过金额。
      // **不能写成 `?? 0`**：那会让详情页写着「实际到账 ¥0.00」，而用户一个字都没输过。
      // 在记账 app 里「没填」与「是 0 元」必须能分开——settledCents 的默认值当初从 0 改成
      // null 就是为这件事（reimburse-store 里有一行又把它们合并回去过，已被任务 9 的审查修掉）。
      el('span', { text: r.settledCents === null ? '未填' : formatCents(r.settledCents, { symbol: true }) })
    ]) : null,
    diff ? el('div', { class: 'rd-diff', text: `差额 ${formatCents(diff, { symbol: true })}` }) : null,

    el('div', { class: 'rd-timeline' }, nodes.map(n => el('div', {
      class: 'rd-node' + (n.ts ? '' : ' is-pending')
    }, [
      el('span', { class: 'rd-dot' }),
      // 标签不单独上样式：它就是正文色，与右边的次要灰时间形成对比（多一个空规则只是噪音）。
      el('span', { text: n.label }),
      el('span', { class: 'rd-time', text: n.ts ? new Date(n.ts).toLocaleString('zh-CN') : '—' })
    ]))),

    el('div', { class: 'rd-actions' }, actions)
  ]));
}

// 删除保护（规格 §6.6）：生成过收入账的单子必须问，而且**不能默认**——
// 两边都留会变成对不上的账，默认删又会动用户账上的钱。
// 这两个选项都不是 btn-primary 是有意的：强调色会把其中一个画成「默认选它」。
function confirmDelete(r, onDone) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '删除报销单', body });
  // 错误行**不 mount 整块 body**：删除失败是原子的（什么都没发生），用户的下一步就是重试，
  // 把面板换成一行错误等于逼他关掉重开。与 settle-sheet.js 纪律 3 同一处置。
  const errorNode = el('div', { class: 'form-error', hidden: true });

  function fail(err) {
    errorNode.textContent = String(err?.message || err);
    errorNode.hidden = false;
  }

  async function run(deleteTxn) {
    try {
      await deleteReimbursement(r.id, { deleteTxn });
      sheet.close();
      onDone();
    } catch (err) {
      // 删除这条路**不翻异常**（deleteReimbursement 走 db.replaceAllRecords，与
      // invoice-store.deleteInvoice 同一处置，理由写在那个函数的 JSDoc 里），所以这里拿到的是
      // 英文原文；它仍然是**原子的失败**，用户能做的就是重试一次——所以原样显示，不假装是别的事。
      fail(err);
    }
  }

  mount(body,
    el('div', { class: 'muted tiny', text: '单里的发票会回到「待报销」，不会被删掉。' }),
    errorNode,
    r.txnId
      ? el('div', { class: 'stack' }, [
          el('div', { text: '这张报销单生成过一笔收入，要不要一起删？' }),
          el('button', { class: 'btn btn-danger', type: 'button', text: '连那笔收入一起删', onclick: () => run(true) }),
          el('button', { class: 'btn', type: 'button', text: '只删报销单，留下收入', onclick: () => run(false) })
        ])
      : el('button', { class: 'btn btn-danger', type: 'button', text: '删除', onclick: () => run(false) })
  );
}
