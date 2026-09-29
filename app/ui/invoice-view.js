// 发票 Tab：搜索、筛选、汇总、列表。
// 依赖 invoice-store（进而 IndexedDB），验证靠模拟器实测。

import { el, mount } from './dom.js';
import { currentTab } from '../router.js';
import * as invoiceStore from '../invoice-store.js';
import { formatCents } from '../money.js';
import { typeLabel, invoiceTitle, sumCents } from '../invoice-model.js';
import { openInvoiceEditor } from './invoice-editor.js';
import { openSheet } from './sheet.js';
import { autoTitle, matchFilter, invoiceBadge } from '../reimburse-model.js';
import { createReimbursement, addInvoicesTo, getReimbursement } from '../reimburse-store.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待报销' },
  { id: 'reimbursed', label: '已报销' },
  { id: 'unlinked', label: '未挂账' },
  { id: 'stored', label: '仅存档' }
];

// 筛选状态按 Tab 生命周期保存在模块级：切走再回来不该被重置，
// 与统计页存口径是同一种做法。
let filter = 'all';
let keyword = '';

// 当前分段：'list' 发票列表 / 'reimburse' 报销单。与 filter / keyword 同一做法存模块级——
// 切走再回来不该被重置。默认停在发票列表，保持既有用户习惯不变。
let segment = 'list';

// 多选模式：null 表示不在多选；数组表示正在多选的发票 id。
// 用数组而不是 Set：它要参与重渲染比较，数组的顺序稳定、好断言。
let selecting = null;

// 多选的目标：null = 攒够票新建一张报销单；否则是「往这一单里加票（id）」。
// 加票态是从报销单详情页的「加票」进来的，它决定底部那颗按钮的文案与动作——
// 同一个「加」字，加到哪一张单是两回事，用户按之前必须看得见。
let selectTarget = null;

// 多选态要说给用户的一句话（加票时票被别处挪走了、或写库失败）。
// 存模块级而不是闭包里：写它的地方（addPickedToTarget）在一次重绘之后才拿到结果，
// 那时原来的闭包已经随 root 一起被换掉了，写进去没有第二个人看得见。
let selectError = '';

// 当前列表渲染序号：每次 paint() 自增。paint 是分批 await 取缩略图的异步循环，
// 而切 Tab 会立刻发起新的一次渲染——main.js 的 renderSeq 只保证外壳（root）不被旧渲染盖，
// 管不到这个 listBox。少了这道检查，先发起、后完成的那次会把新列表盖回去，
// 用户切回来看到的是一份旧数据（点进去还会是已经被删掉的那张票）。
let paintSeq = 0;

// 当前视图渲染序号：每次 renderInvoices 自增。它与 paintSeq 管的是两件事——
// 这个管「哪一次渲染有权往 root 上写」，paintSeq 管「哪一份列表该留在 listBox 里」。
// 必须有这一道：await 之后本文件自己会 mount(root, …)，而 main.js 的 renderSeq 只保证
// 「最后一次发起者挂 tabbar」，拦不住视图在这个窗口里写 view。复现是——进发票页后立刻点「统计」，
// 统计先画完并挂上高亮，发票那一次随后 mount 覆盖掉内容，「统计」高亮着却显示发票列表，
// 且此后不会再有 hashchange 来自愈。写法照 vault-view.js 的 activeSeq。
let viewSeq = 0;

// 本次会话是否已经清过孤儿图。cleanupOrphanFiles 要扫两张表、可能删掉几十条 blob，
// 而它跑的时候首屏那批缩略图正在读同一个 IndexedDB——每次切回发票页都全表扫一遍就是白跟首屏抢时间，
// 而清理本身是「迟早会做」的事：一个会话做一次就够，这次之后新产生的孤儿留给下次会话。
let cleanedOnce = false;

function matches(inv, kw) {
  if (!kw) return true;
  const hay = [inv.seller, inv.number, inv.note, inv.buyerTitle].join(' ').toLowerCase();
  return hay.includes(kw);
}

function inFilter(inv) {
  // 判据本身在 reimburse-model.js 里（可单测），这里只做转发——
  // 五个筛选的边界（尤其「仅存档算不算已报销」）不该只在界面上被验。
  return matchFilter(inv, filter);
}

export async function renderInvoices(root) {
  const seq = ++viewSeq;

  // 上一次留在屏幕上的那句话（「有 N 张已经在别的报销单里」之类）属于**上一次**的按钮动作，
  // 每次重新进入这一段都清掉：留着它就成了屏幕上一条没有来由的提示。
  selectError = '';

  // 报销单那一段整块交给 reimburse-view，本文件不掺和它的内部结构（分流放在取数据之前：
  // 那一段要的是报销单与它自己的票，发票列表与汇总对它是白读一次库）。
  if (segment === 'reimburse') return renderReimburseSegment(root, seq);

  // 顺手清一次孤儿图（拍完照又取消保存留下的那份）。**故意不 await**：它要扫两张表、
  // 可能要删掉几十条 blob，等它做完用户看到的就是一段白屏；而清理是「迟早会做」的事，
  // 晚几百毫秒和立刻做完对用户没有区别。清理失败也不该让发票页打不开，所以整段 catch 掉。
  // 整个会话只发起一次（见 cleanedOnce）：置位放在发起之前，renderInvoices 并发两次时也只跑一遍。
  if (!cleanedOnce) {
    cleanedOnce = true;
    invoiceStore.cleanupOrphanFiles().catch(() => {});
  }

  // 列表与汇总一起取：两者是同一次渲染的两半，串行 await 只是白白多等一个事务。
  // 加票态还要多一份目标单（只是为了在按钮上写出它的标题），第三项就是它；其余情况不发这次读。
  const [invoices, sum, target] = await Promise.all([
    invoiceStore.listInvoices(),
    invoiceStore.summary(),
    selectTarget ? getReimbursement(selectTarget) : Promise.resolve(null)
  ]);
  // 等数据这段时间用户完全来得及切走（前面那次全表清理还在抢 IO）。两个条件都要过：
  // ① 已经切到别的 Tab 就直接走人——main.js 用同一个 view 元素渲染所有 Tab，此时写进去
  //    就是「统计」高亮着却显示发票列表，而且此后不会再有 hashchange 来自愈。
  //    这一条是序号拦不住的：切走不会让 viewSeq 变化（本视图根本没被再次调用）。
  //    与 vault-view.js 里那句「切走之后不去动别人的视图」是同一道检查。
  // ② 还是本 Tab、但已经又发起过一次发票渲染（切走再切回），交给新的那次去画。
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  // 目标单在别处被删掉了（另一个标签页删的、或用户刚在详情页删的）：退回「新建」态。
  // **不能**让它停在加票态——那时按钮上的标题取不到、按下去又要往一个已经不存在的单里写，
  // 而用户按之前看到的还是「加票」两个字。
  if (selectTarget && !target) selectTarget = null;
  const targetTitle = target ? target.title : '';

  const all = invoices;

  const searchInput = el('input', {
    type: 'search',
    placeholder: '搜索销售方、号码、备注',
    value: keyword,
    oninput: (e) => { keyword = e.target.value; paint(); }
  });

  const listBox = el('div', {});
  const filterBox = el('div', { class: 'inv-filters' });
  // 汇总区要能单独重画（保存完发票后金额和张数都变了），所以留一个容器节点，
  // 与 listBox 同样的做法：整页只 mount 一次，之后局部替换内容。
  const summaryBox = el('div', { class: 'inv-summary' });
  // 工具条（「选择 / 取消」）与底部操作条也各留一个容器：它俩的**内容**随多选态变，
  // 而这两个节点只建一次。不留容器的话，点完「选择」按钮上的字还写着「选择」——
  // 那颗按钮是在这里创建的，paint() 够不着它。
  const toolBox = el('div', { class: 'inv-tools' });
  // 底部操作条挂在**本视图的 root 里**，不是 document.body：它属于这一屏，跟着 root 一起被换掉
  // 正好——切段、切 Tab 时它自己就没了，不必在别处再写一句「记得把上一次那条删掉」
  // （那种「两处各记一半」的清理迟早会漏一处）。position: fixed 不要求它是 body 的直接子节点。
  const barBox = el('div', {});

  // 展示金额一律带 ¥（formatCents 的 symbol 选项）：记账页与编辑器都带，
  // 同一个屏幕上两个口径（列表带符号、汇总不带）会让人以为它们不是同一种数。
  function paintSummary(s) {
    mount(summaryBox,
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: '本月发票' }),
        el('div', { class: 'v', text: formatCents(s.monthCents, { symbol: true }) })
      ]),
      el('div', { class: 'inv-summary-cell' }, [
        el('div', { class: 'k', text: `待报销（${s.pendingCount} 张）` }),
        el('div', { class: 'v', text: formatCents(s.pendingCents, { symbol: true }) })
      ])
    );
  }

  function paintFilters() {
    mount(filterBox, FILTERS.map(f => el('button', {
      type: 'button',
      'aria-selected': String(f.id === filter),
      onclick: () => { filter = f.id; paint(); }
    }, [f.label])));
  }

  function paintTool() {
    mount(toolBox, el('button', {
      class: 'btn', type: 'button',
      text: selecting ? '取消' : '选择',
      onclick: () => {
        if (selecting) {
          // 「取消」把两个都退掉：加票目标属于这一次多选的上下文，留着它下次进多选会
          // 悄悄变成「加到那一单」——用户以为自己只是要选几张票。
          selecting = null;
          selectTarget = null;
        } else {
          selecting = [];
          selectTarget = null;
          // 进入多选时把筛选切到「待报销」：不然用户可能把已经报出去的票又选进来，
          // 而那种票会被 createReimbursement 跳过——他白选一场，还不知道为什么。
          filter = 'pending';
        }
        selectError = '';
        paint();
      }
    }));
  }

  /**
   * 底部操作条：选中 ≥1 张才出现。筹码式的禁用态会让人猜「为什么不能点」，
   * 而这里本来就没有可做的事（一张都没选时无话可说）。
   *
   * 按目标分叉：新建态是「发起报销」，加票态的按钮文本里**带着目标单的标题**——
   * 用户按下去之前必须知道这些票要往哪一张单里加。
   */
  function paintBar() {
    const picked = selecting ? all.filter(i => selecting.includes(i.id)) : [];
    if (picked.length === 0) {
      // 空集就是「什么都不画」。不过这里有个已知边界：加票时若**每一张**都被别处挪走了，
      // addPickedToTarget 写进 selectError 的那句话会随这条路径一起消失在屏幕上
      // （票一张不剩 → 没有操作条 → 没地方显示它）。它需要「另一个标签页刚好同时动了同一批票」
      // 才撞得上，代价是那个用户看不到解释；要修得给这一屏另配一条独立的提示行，不在本次范围里。
      mount(barBox);
      return;
    }
    const total = sumCents(picked);
    mount(barBox, el('div', { class: 'reimburse-bar' }, [
      // 左边是「选了什么」，右边是「按下去会发生什么」——两件事分开写，按钮才是唯一的行动点。
      el('div', {}, [
        el('span', {
          class: 'rb-total',
          text: `已选 ${picked.length} 张 · ${formatCents(total, { symbol: true })}`
        }),
        selectError ? el('div', { class: 'form-error', text: selectError }) : null
      ]),
      selectTarget
        ? el('button', {
            class: 'btn btn-primary', type: 'button', text: `加到「${targetTitle}」`,
            onclick: () => { addPickedToTarget(root, picked); }
          })
        : el('button', {
            class: 'btn btn-primary', type: 'button', text: '发起报销',
            onclick: () => { openCreateReimburseSheet(root, picked); }
          })
    ]));
  }

  /**
   * 把勾中的票加进目标单（底部条上那颗「加到「…」」）。与「发起报销」的两处不同：
   *  · 走 addInvoicesTo——store 里的加票入口，规格 §5.1 把「加票」和改名、移票一起算进 canEdit；
   *  · 失败时**留在原地**（不切段、不重取数据）：用户勾的那几张还在，改一改再点一次就行。
   */
  async function addPickedToTarget(root, picked) {
    const target = selectTarget;
    try {
      const { skipped } = await addInvoicesTo(target, picked.map(i => i.id));
      if (skipped.length > 0) {
        // 这些票在勾选之后被别处挪进了别的单（另一个标签页）。**不静默跳走**：把它们从勾选集合里
        // 摘掉、把话说明白；剩下的仍然勾着，用户再点一次就能加进去。
        // 直接跳过去的话，他只知道「我勾了三张、怎么只进去两张」，而解释那时已经不在屏幕上了。
        selecting = (selecting ?? []).filter(id => !skipped.includes(id));
        selectError = `有 ${skipped.length} 张已经进了别的报销单，这次没加进去。`;
        paint();
        return;
      }
      await goToReimbursement(root, target);
    } catch (err) {
      // store 已经把存储异常翻成中文了（「已经提交给公司的报销单不能修改」这类也是它给的），
      // 原样说出来即可——这里再做一层翻译只会让两种说法并存。
      selectError = String(err?.message || err);
      paint();
    }
  }

  async function paint() {
    const seq = ++paintSeq;
    paintFilters();
    paintTool();
    const kw = keyword.trim().toLowerCase();
    const rows = all.filter(inv => inFilter(inv) && matches(inv, kw));
    if (rows.length === 0) {
      if (seq !== paintSeq) return;
      mount(listBox, el('div', { class: 'empty' }, [
        all.length === 0 ? '还没有发票，点右下角拍一张' : '没有符合条件的发票'
      ]));
      // 空列表也要画操作条：筛掉的是**屏幕上的行**，不是用户已经勾中的票——他切一下筛选
      // 就得重新勾一遍的话，多选这件事就没法用了。
      paintBar();
      // 这一屏一张缩略图都不需要，缓存里的全部作废（listBox 刚被整块换掉，旧节点上的 URL
      // 已经没人看）。空集就是「一个都不留」。
      invoiceStore.pruneUrlCache(new Set());
      return;
    }

    // 本批真的取到 URL 的 fileId，paint 结束时按它做差集回收。
    // 不能再像原来那样开头一律清空：搜索框每敲一个字都跑一次 paint，
    // 全量清空等于每按一个键都把可见缩略图重新读一遍 IndexedDB、重新建一遍 blob URL，
    // 而其中绝大多数上一批刚取过。
    const keep = new Set();
    // 有图可取的行的占位节点：等 URL 回来逐个替换成 <img>。
    const pending = [];

    // ① 骨架先行：整页**同步**搭出来、一次 mount。原来是边 await 边拼节点、全部取完才 mount，
    // 几十张票的时候 listBox 会在几百毫秒内完全是空的——而用户只是切回来看一眼列表。
    // 缩略图位置先放占位节点，真实图片随后填进去。
    const items = rows.map(inv => {
      // 占位块（没图 / PDF / OFD 都会留在这里）。文案固定成「发票文件」而不区分 PDF / OFD：
      // getThumbUrl 只回 URL、不回 mime，要区分就得为列表每一行多读一次 IndexedDB 记录。
      const thumb = el('div', {
        class: 'inv-thumb',
        role: 'img',
        title: inv.fileId ? '发票文件' : '没有文件',
        'aria-label': inv.fileId ? '发票文件' : '没有文件',
        text: inv.fileId ? '📄' : '🧾'
      });
      if (inv.fileId) pending.push({ fileId: inv.fileId, thumb });
      // 多选态下整行是**勾选**而不是打开：同一个按钮干两件事，用户按之前得看得出来
      // （勾选框只在多选态出现，就是这个信号）。
      const checked = selecting ? selecting.includes(inv.id) : false;
      return el('button', {
        // is-selecting 是给样式用的：多选态那一行多出一个勾选框，列宽要跟着变
        // （不加这个类就只能靠 :has()，而 Chrome 83 不认识它）。
        class: 'inv-item' + (selecting ? ' is-selecting' : '') + (checked ? ' is-checked' : ''),
        type: 'button',
        onclick: () => {
          if (!selecting) { openInvoiceEditor({ id: inv.id, onSaved: refresh }); return; }
          // 已在单里的票不给选：createReimbursement / addInvoicesTo 会把它跳过，选它只是白选一场；
          // 「仅存档」的票更硬——addInvoicesTo 会直接抛错，那是界面给了他一个不该给的选择。
          // 进多选时筛选已经切到「待报销」，这两类票通常根本不在屏幕上；但用户完全可以先切筛选
          // 再回来点，所以守卫必须在这里，不能只靠筛选。
          if (inv.reimbursementId || inv.archived) return;
          selecting = checked ? selecting.filter(x => x !== inv.id) : [...selecting, inv.id];
          selectError = '';
          paint();
        }
      }, [
        selecting ? el('span', { class: 'inv-check', 'aria-checked': String(checked), role: 'checkbox' }) : null,
        thumb,
        el('div', {}, [
          el('div', { class: 'inv-title', text: invoiceTitle(inv) }),
          el('div', { class: 'inv-meta', text: [typeLabel(inv.type), inv.number].filter(Boolean).join(' · ') }),
          el('div', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: invoiceBadge(inv, null) })
        ]),
        el('div', { class: 'inv-amount', text: formatCents(inv.amountCents, { symbol: true }) })
      ]);
    });
    mount(listBox, items);
    // 骨架先行的同时把操作条画出来：它与列表是同一屏的两半，晚一帧出现会让「我勾中了没有」
    // 悬在半空（缩略图那几批 await 在后面，与它无关）。
    paintBar();

    // ② 分批并发取图。原来是一行一行串行 await：一张 200ms、三十张就是好几秒的空白；
    // 而全部并发又会一次性往 IndexedDB 排几十个读 + 同时解码几十张图（手机最先在内存上撑不住）。
    // 每批 6 个：首屏压到一个批次的时间，同时解码的图也不会太多。
    const BATCH = 6;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const urls = await Promise.all(
        batch.map(p => invoiceStore.thumbUrlFor(p.fileId).catch(() => null))
      );
      // 每批之后都要重新对一次序号：一次列表可能有几十张票，用户完全来得及切走再切回来。
      // 这里停手而不是继续填图，省掉后面几批无用的 IO（新的那次 paint 会自己再取一遍）。
      if (seq !== paintSeq) return;
      batch.forEach((p, j) => {
        const url = urls[j];
        // 取不到不算异常：PDF 本来就没有缩略图，占位节点留着就是它应有的形态。
        if (!url) return;
        keep.add(p.fileId);
        // 只替换这一个占位节点，不整块重挂列表：整块重挂会让列表闪一下，
        // 也会把用户正按住的那一行从手指底下抽走。
        p.thumb.replaceWith(el('img', { class: 'inv-thumb', src: url, alt: '发票文件' }));
      });
    }
    if (seq !== paintSeq) return;
    // ③ 差集回收：只 revoke 这一批不再需要的缩略图 URL，用户接着敲下一个字时
    // 还在画面上的那些留在缓存里，命中就是零成本。full: 前缀不归这里管（见 image-store）。
    invoiceStore.pruneUrlCache(keep);
  }

  async function refresh() {
    // refresh 由编辑器的 onSaved 回调触发，跑在 renderInvoices 之外，所以这里取当前的 viewSeq
    // 当作「我属于这一次渲染」的凭据：保存后用户可能已经切走，那时不该再往一个别人的 root 里写。
    const seq = viewSeq;
    // 汇总必须跟列表一起重取：保存成功后列表多了一行，而顶部「本月发票 / 待报销（N 张）」
    // 若还是旧值，金额和张数都对不上——用户最容易在这里犯疑「我刚存的那张算进去了没」。
    const [fresh, freshSum] = await Promise.all([invoiceStore.listInvoices(), invoiceStore.summary()]);
    // 两个条件都要查，与 renderInvoices 里那次检查保持一致（那里也是 currentTab() + 序号一起判）。
    // 只查序号是不够的：切 Tab 不会让 viewSeq 变化（本视图压根没被再次调用），所以改完发票、
    // 面板还开着的时候顺手切到「统计」，这次迟到的 refresh 会**照样**往下写——
    // 把已经画好的统计页盖成发票列表和汇总，并且此后不会再有 hashchange 来自愈。
    // seq 管的是「切走又切回来、已经有新的一次渲染在跑」那种情形，两者各管一头，缺一不可。
    if (currentTab() !== 'invoice' || seq !== viewSeq) return;
    all.length = 0;
    all.push(...fresh);
    paintSummary(freshSum);
    await paint();
  }

  paintSummary(sum);

  mount(root, el('div', { class: 'stack' }, [
    // 分段条排在最上面：它管的是「这一屏是什么」，比汇总那两个数更靠前。
    segmentBar(root),
    summaryBox,
    searchInput,
    toolBox,
    filterBox,
    listBox,
    barBox
  ]),
  // 右下角新建入口：类名、位置、观感都跟记账页的 FAB 保持一致。
  // 少了它就等于没有入口——空态那句「点右下角拍一张」会指向一片空气。
  el('button', {
    class: 'fab', type: 'button', text: '+',
    'aria-label': '新建发票',
    onclick: () => openNewInvoice(refresh)
  }));

  await paint();
}

// 分段条：发票 / 报销单。两个按钮都在屏幕上，谁被选中由 aria-selected 说明（样式挂在它上面）。
// 切段一律退掉多选与加票目标——留着它们，用户下次回到发票段看到的是一屏带勾选框的列表，
// 而他自己不记得点过「选择」；加票目标更是上一次那一段的上下文，留下只会让按钮说谎。
function segmentBar(root) {
  const go = id => () => {
    segment = id;
    selecting = null;
    selectTarget = null;
    selectError = '';
    // 点当前这一段也重新渲染：它是这一段唯一的重绘入口（切走再回来，或者这一屏画坏了要重试）。
    renderInvoices(root);
  };
  const seg = (id, label) => el('button', {
    class: 'seg', type: 'button', text: label,
    'aria-selected': String(segment === id),
    onclick: go(id)
  });
  return el('div', { class: 'seg-bar' }, [seg('list', '发票'), seg('reimburse', '报销单')]);
}

/**
 * 报销单视图是**动态** import 的：它连带 sheet / keypad / settle-sheet 一整串，只有用户真的切到
 * 那一段才需要，静态 import 会让发票页的首屏多背一份用不上的代码（与 main.js 里已有的做法一致）。
 *
 * 代价是它可能在离线时加载失败。失败抛出来的原始信息是「Failed to fetch dynamically imported
 * module」这种英文——用户看不懂，对排查也没有信息量（原因只有一个：离线，而缓存里缺这个文件），
 * 所以在这里翻成一句能照着做的话，原文进控制台。
 * 注意这个模块**已经在 sw.js 的 ASSETS 里**（任务 8 加的，与 settle-sheet / reimburse-store 一起），
 * 所以正常情况下离线也加载得到——这条兜底挡的是「缓存还没装上/被清掉」那一类。
 */
function loadReimburseView() {
  return import('./reimburse-view.js').catch(err => {
    console.error('报销单视图加载失败', err);
    throw new Error('报销单这一段没加载出来。多半是网络断了、而离线缓存里还没有它——连上网络后重开一次应用就好。');
  });
}

// 报销单那一段：分段条仍是本文件的（用户得能切回发票段），卡片整块交给 reimburse-view，
// 本文件不掺和它的内部结构（它自己往传进去的容器里 mount）。
async function renderReimburseSegment(root, seq) {
  let renderReimbursements;
  try {
    ({ renderReimbursements } = await loadReimburseView());
  } catch (err) {
    if (currentTab() !== 'invoice' || seq !== viewSeq) return;
    // 加载失败也要把分段条画出来：否则用户卡在这一段上，连切回发票列表的路都没有。
    mount(root, el('div', { class: 'stack' }, [
      segmentBar(root),
      el('div', { class: 'empty' }, [
        el('div', { text: '报销单这一段没加载出来' }),
        el('div', { class: 'muted tiny', text: String(err?.message || err) })
      ])
    ]));
    return;
  }
  // 动态 import 要等一次网络/缓存，这期间用户完全来得及切走**或者切回发票段**——
  // 与取数据那两处同一道检查（切回发票段时 viewSeq 已经变了，seq 就拦住了）。
  if (currentTab() !== 'invoice' || seq !== viewSeq) return;

  const box = el('div', {});
  mount(root, el('div', { class: 'stack' }, [segmentBar(root), box]));
  // 回调**必须收参数**：reimburse-view 的空状态用 `{ startSelecting: true }` 请我们直接进多选，
  // 详情页的「加票」用 `{ startSelecting: true, targetId }` 说明目标是某一单。
  // 写成无参箭头函数不会报错，只会让那个按钮点了什么都不发生——所以测试把这条路整条钉住了。
  await renderReimbursements(box, {
    onSwitchToInvoices: opts => switchToInvoices(root, opts)
  });
}

/**
 * 从报销单那一段回到发票段。参数形状是**跨文件契约**（reimburse-view 怎么写，这里就得怎么收）：
 *   { startSelecting: true }            → 直接进多选（列表空状态那个「去发票里选几张」）
 *   { startSelecting: true, targetId }  → 进多选，且目标是某一单（详情页的「加票」）
 * 少收一个键不会报错，只会让用户点完按钮之后什么也没发生。
 */
function switchToInvoices(root, { startSelecting = false, targetId = null } = {}) {
  segment = 'list';
  selectError = '';
  if (startSelecting) {
    // 与「选择」按钮同一套动作：进多选 + 切到「待报销」（已经报出去的票会被 store 跳过，白选一场）。
    selecting = [];
    selectTarget = targetId ?? null;
    filter = 'pending';
  } else {
    selecting = null;
    selectTarget = null;
  }
  renderInvoices(root);
}

/**
 * 切到报销单段并打开某一单的详情。「发起报销」与「加票」两条路都以它收尾。
 *
 * openId 是 reimburse-view 的模块状态，只有它自己能设——所以那边为这条调用点导出了
 * `openReimbursement(id)`；这是**跨模块契约**，删掉那个导出，这两条路的终点会从「那一单的详情」
 * 悄悄变回「报销单列表」，而不会有任何地方报错（tests/invoice-view.test.js 钉住了终点）。
 */
async function goToReimbursement(root, id) {
  selecting = null;
  selectTarget = null;
  segment = 'reimburse';
  try {
    const { openReimbursement } = await loadReimburseView();
    openReimbursement(id);
  } catch {
    // 模块加载不出来：至少切到报销单那一段，由它画出「没加载出来」的说明页（那里有自己的文案），
    // 比把用户留在多选态、什么反馈都没有强。
  }
  renderInvoices(root);
}

// 发起报销：确认标题。默认「9月报销 · N 张」，可改。
function openCreateReimburseSheet(root, invoices) {
  const input = el('input', { type: 'text', value: autoTitle(Date.now(), invoices.length) });
  // 错误行**不 mount 整块 body**：失败是原子的（什么都没发生），用户的下一步就是重试，
  // 把面板换成一行错误等于逼他关掉重开（与 reimburse-view 的改名 / 删除面板同一处置）。
  const errorNode = el('div', { class: 'form-error', hidden: true });
  const body = el('div', { class: 'stack' }, [
    el('div', {
      class: 'muted tiny',
      text: `这 ${invoices.length} 张票会打成一单，合计 ${formatCents(sumCents(invoices), { symbol: true })}`
    }),
    input,
    errorNode,
    el('button', {
      class: 'btn btn-primary', type: 'button', text: '创建报销单',
      onclick: async () => {
        try {
          // createReimbursement 返回 { reimb, skipped } **两件**（store 的注释解释了为什么不合成一件）。
          const { reimb, skipped } = await createReimbursement({
            invoiceIds: invoices.map(i => i.id),
            title: input.value
          });
          // skipped 非空 = 在我们选完之后，这几张票被别处挪进了别的单（另一个标签页先建了单）。
          // 这一屏**不静默跳走**：先把「哪几张没进这一单」说清楚，用户点一下再去看那一单。
          // 直接跳过去的话，他只知道「我勾了三张、怎么单里只有两张」，而那时解释已经不在屏幕上了。
          if (skipped.length > 0) {
            mount(body,
              el('div', {
                class: 'muted tiny',
                text: `有 ${skipped.length} 张已经进了别的报销单，这一单只收下 ${invoices.length - skipped.length} 张。`
              }),
              el('button', {
                class: 'btn btn-primary', type: 'button', text: '看这一单',
                onclick: () => { sheet.close(); goToReimbursement(root, reimb.id); }
              })
            );
            return;
          }
          sheet.close();
          goToReimbursement(root, reimb.id);
        } catch (err) {
          errorNode.textContent = String(err?.message || err);
          errorNode.hidden = false;
        }
      }
    })
  ]);
  const sheet = openSheet({ title: '发起报销', body });
}

export function openNewInvoice(onSaved) {
  return openInvoiceEditor({ onSaved });
}

// 从记账页点「🧾N」进来的小面板：看这笔账挂了哪些票，也能当场补挂一张。
// 与编辑器的分工：这里只管「挂靠」这一件事，看大图/改字段交给编辑器。
// txn 由调用方直接传整条对象（ledger-home 手里就有），不再查一次库；
// categoryName 同理已由调用方查好，这里不重复查分类表。
export function openInvoiceLinkSheet({ txn, categoryName = '', onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '这笔账的发票', body });

  async function refresh() {
    const list = await invoiceStore.listByTxn(txn.id);

    const rows = list.map(inv => el('button', {
      class: 'inv-row', type: 'button',
      onclick: () => {
        sheet.close();
        openInvoiceEditor({ id: inv.id, onSaved: onChanged });
      }
    }, [
      el('span', { class: 'inv-row-main' }, [
        el('span', { text: inv.seller || inv.number || '未命名发票' }),
        el('span', { class: 'muted tiny', text: `${inv.number || '无号码'} · ${formatCents(inv.amountCents ?? 0, { symbol: true })}` })
      ]),
      el('span', { class: 'inv-tag ' + (inv.archived ? 'stored' : 'pending'), text: invoiceBadge(inv, null) })
    ]));

    mount(body,
      el('div', { class: 'muted tiny', text: `${categoryName || '这笔账'} ${formatCents(txn.amountCents ?? 0, { symbol: true })}　已挂 ${list.length} 张` }),
      // el(tag, props, children) 的 children 收数组（不能像 mount 那样变参展开）
      list.length === 0
        ? el('div', { class: 'empty', text: '这笔账还没有发票' })
        : el('div', { class: 'stack' }, rows),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '＋ 新建发票并挂到这笔账',
        // txnId 直接交给编辑器：saveInvoice 会把它写进发票，不必再调 linkToTxn。
        onclick: () => {
          sheet.close();
          openInvoiceEditor({ txnId: txn.id, onSaved: onChanged });
        }
      })
    );
  }

  refresh().catch(err => {
    mount(body, el('div', { class: 'vault-error', text: String(err?.message || err) }));
  });
}
