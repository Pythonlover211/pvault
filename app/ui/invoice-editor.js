// 新建 / 编辑发票的半屏 sheet。
// 复用项目既有的 openSheet 与 createKeypad，不另造一套。

import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import { downloadBlob } from './download.js';
import * as invoiceStore from '../invoice-store.js';
import { prepareFile, saveFile, getFile, getFullUrl, revokeUrl, setEditingFile, getEditingFile } from '../image-store.js';
import { MAX_FILE_BYTES, fileKind, sanitizeFilename, fallbackFileName } from '../file-info.js';
import { INVOICE_TYPES, validateInvoice } from '../invoice-model.js';
import { formatCents } from '../money.js';
import { formatDayLabel } from '../dates.js';
// 关联账目要读流水与分类表，走仓库层（视图不直接碰 db.js）。
import * as store from '../store.js';

let activeSheet = null;

// 关联账目的候选只列最近 50 笔：流水可能几百笔，全铺开会把这个面板撑得又长又慢，
// 而「这张票该挂哪笔账」几乎总是最近那几笔。
const MAX_TXN_OPTIONS = 50;
// 「已经挂着的那笔账还在不在」用更宽的时间窗确认：仓库层没有按 id 查单笔交易的接口
// （只有按时间范围取），而票往往是过后才挂上去的，那笔账完全可能比 6 个月还早。
// 少了这一次查询，几个月前挂的票会被误报成「账目已不存在」。
const LINKED_LOOKBACK_MONTHS = 120;

export function openInvoiceEditor({ id = null, txnId = null, onSaved } = {}) {
  // 同一时刻只开一层：与项目其它 sheet 的约定一致
  if (activeSheet) { activeSheet.close(); activeSheet = null; }

  const state = {
    id,
    number: '', issuedAt: Date.now(), amountCents: null,
    seller: '', type: 'other', buyerTitle: '', buyerTaxId: '',
    taxCents: null, note: '', fileId: null, txnId,
    archived: false, busy: false
  };
  // 查重提示只弹一次（见 submit）：用户第二次点「保存」就放行。
  let dupWarned = false;
  // 保存防重入，与 entry-panel.js 的 saving / submitted 是同一套。先置位再 await：
  // saving 管「这一次提交还没走完」——第二次点击会在同一个 fileId、同一个 state 上再存一遍；
  // submitted 管「已经存进去了」——sheet.close() 之后节点还要留 ~180ms 才移除，
  // 这期间再点一次「保存」就是实打实的第二条记录。
  let saving = false;
  let submitted = false;
  // 预览渲染序号：pickFile 与 paintPreview 中间都要 await（压缩、写库、读记录、取 URL）。
  // 连续快速选两张图时，先发起的那次完全可能后完成，把预览覆盖回上一条——
  // 用户看到的、以及将来保存下去的都会是错的那张。
  let previewSeq = 0;

  // —— 关联账目 ——
  // 候选流水与分类表在打开面板时取一次（loadTxns），分类只用来把 categoryId 翻成人看得懂的名字。
  let txns = [];          // 已知的流水（含为确认老账目而多查回来的那一笔）
  let txnByDate = [];     // 列表要画的那些：时间倒序、最多 MAX_TXN_OPTIONS 笔
  let catOf = new Map();  // categoryId → 分类记录
  // 用两个标志区分三态。读回来之前什么都不画：「未关联」会在一两秒后自己变成别的内容，
  // 用户会以为面板在乱跳；而把「还没读回来」当成「已不存在」更糟——那是在报一个不存在的错。
  let txnsLoaded = false;
  let txnsFailed = false;
  let pickerOpen = false;

  // —— 删除（两段式确认）——
  // delArmed 表示「已经点过一次」；delTimer 负责几秒后自动复原；deleting 防重入，
  // 与 submit 的 saving / submitted 是同一套。
  let delArmed = false;
  let delTimer = null;
  let deleting = false;
  // 导出防重入，与 saving / deleting 同一套：连点两次会读两遍、下载两份。
  let exporting = false;

  const errorNode = el('div', { class: 'vault-error' });
  const previewBox = el('div', {});
  // 导出按钮只在真的有文件时出现：没有文件时它按下去也没用，
  // 而一个按了没反应的按钮比没有按钮更让人困惑。
  const exportBtn = el('button', {
    class: 'btn', type: 'button', text: '导出这份文件',
    onclick: () => { exportCurrentFile(); }
  });
  // 用 style.display 显隐而不是 hidden 属性：.row 这类类选择器带 display:flex，
  // 会盖掉 hidden 自带的 display:none。置空字符串是让元素回到 CSS 自己的 display。
  const exportRow = el('div', { class: 'row', style: 'display:none' }, [exportBtn]);
  const body = el('div', { class: 'stack' });

  // 关联账目这一行的三个节点：状态文案、点开后出现的候选列表、两个动作按钮。
  // 它们都在构造期建好、之后只 mount 内容，这样 loadTxns 回来时不必整块重建面板
  // （重建会把用户已经填好的字段和正在编辑的输入框一起换掉）。
  const txnStatus = el('div', { class: 'inv-link-status' });
  const txnPicker = el('div', {});
  const txnActions = el('div', { class: 'row' });
  const txnBox = el('div', { class: 'stack', style: 'gap:6px' }, [txnStatus, txnPicker, txnActions]);

  // 删除按钮只在编辑已有发票时构造（新建时没什么可删的）。
  // 它在「保存」下面单独占一行、不并排：两个按钮挨着时手指很容易点错，而这个操作不可逆。
  const deleteBtn = id
    ? el('button', {
        class: 'btn btn-danger', type: 'button', text: '删除这张发票',
        onclick: () => { removeInvoice(); }
      })
    : null;

  const sheet = openSheet({
    title: id ? '编辑发票' : '新建发票',
    body,
    // onClose 在面板**开始收起**时触发，close() 自己也会走到这里（见 sheet.js），
    // 所以「点保存」「点删除」那两条已经清过标记的路径会再清一次，是幂等的、无害的；
    // 它真正兜住的是「拍了照又关掉面板」那条路——原来这里没接 onClose，那条路上
    // setEditingFile 的标记会一直挂着，那张孤儿图此后**再也不会**被 cleanupOrphanFiles 收走
    // （逐张问 getEditingFile()，见 invoice-store 的注释），不误删、但永久白占一份配额。
    onClose: () => {
      // ① 先让还在处理中的那张图作废：手机上压缩一张要几百毫秒到数秒，用户完全来得及在
      //    它落库之前把面板关掉，而那次选图回来后会照旧 setEditingFile(fileId)——
      //    标记就此挂在一张面板早已不管的图上，正是这一条要堵的漏。
      //    递增 previewSeq 后，pickFile 里那道 `seq !== previewSeq` 的检查会让它连
      //    state.fileId 都不写（沿用那里的既有写法，不加第二套机制）。
      previewSeq += 1;
      // ② 只清理**本面板**挂上的那个标记，且当前编辑的就是这张 sheet。
      //    不能无条件 setEditingFile(null)：用户可能已经在别处打开了另一个发票编辑器
      //    （比如从记账页的「🧾N」进来看另一张票），把它的标记清掉等于把它正拿在手里的图
      //    交出去——那张图会提前 24 小时进入清理视野。加 state.fileId === getEditingFile()
      //    这一判，误清就不可能发生。
      //    activeSheet 必须等这一整套判断走完再置 null：顺序反了，第 27 行的
      //    「同一时刻只开一层」就失效（那边靠 activeSheet 非空去关掉上一个面板）。
      if (activeSheet === sheet) {
        if (state.fileId && getEditingFile() === state.fileId) setEditingFile(null);
        activeSheet = null;
      }
      // 保存成功与删除成功那两条路已经自己清过标记了（见 submit / removeInvoice），
      // 重复清一次没有副作用——叶子状态就是「编辑器还拿在手里的那张图」。
    }
  });
  activeSheet = sheet;

  // 换预览内容时先记住旧节点：从图片换成 PDF 占位之后，旧图片那个 object URL 再没人持有，
  // 不 revoke 就是每换一次文件泄漏一份内存（原来只在「图换图」那一支做了，漏了「图换 PDF」）。
  function mountPreview(node) {
    const old = previewBox.firstChild;
    mount(previewBox, node);
    if (old?.tagName === 'IMG') revokeUrl(old.src);
  }

  // 非图片文件（PDF / OFD）在预览区只能给一个占位块：它们没有缩略图，也不能塞进 <img>
  // （getFullUrl 对任何存在的记录都返回 blob URL，直接塞进去得到的是裂图加一行浅灰 alt 文字）。
  // 有原始文件名就显示文件名——存进去的文件从此有了「长相」，不然一堆票在界面上全长一样。
  function filePlaceholder(rec, kind) {
    const name = String(rec?.name ?? '').trim();
    const text = name || (kind === 'ofd' ? 'OFD 已保存'
      : kind === 'pdf' ? 'PDF 已保存'
      // kind 走到 'image' 只可能是「记录在、blob 却空了」这种坏数据（正常图片有 URL 就渲染成图了）
      : '文件读不出来');
    // title 与 aria-label 都放完整名字。真机上没有悬停、长按弹的也是文本选择而不是它，
    // 所以这两个属性主要给读屏和桌面浏览器——「看全名」靠的是导出时那个名字，不是这里。
    return el('div', { class: 'inv-thumb inv-file-thumb', role: 'img', title: text, 'aria-label': text, text });
  }

  async function paintPreview() {
    // 这里**不能**自增 previewSeq。paintPreview 基本总是被 pickFile 在结尾调用，它自增之后
    // pickFile 的 finally 里那句 `seq === previewSeq` 就永远不成立，state.busy 再也清不掉——
    // 表现为图片早就显示出来了，用户每次点「保存」都只得到「图片还在处理，稍等一下再保存」，
    // 这张发票永远存不下去（真机上实测踩到过）。序号只由「发起一次新操作」的地方推进：
    // pickFile 与关闭面板。这里只读它，回答「我这次要画的是不是已经过期了」。
    const seq = previewSeq;
    // 跟着「有没有文件」走，与下面的分支一一对应。放在序号检查之前，
    // 因为它是同步的、不依赖任何 await 结果。
    exportRow.style.display = state.fileId ? '' : 'none';
    // 把这次要画的 fileId 固定下来：await 期间它可能被下一次选图换掉，
    // 而那时该由那一次自己来画。
    const fileId = state.fileId;
    if (!fileId) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '🧾 还没有文件' }));
      return;
    }
    const rec = await getFile(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    // 判类型要看 mime 与文件名两样，统一走 file-info.fileKind——不要在视图里另写一套正则，
    // 否则「OFD 该按什么算」这件事就有了两个说法。
    const kind = rec ? fileKind(rec.mime, rec.name) : 'image';
    // fileKind 的 'image' 是「不认识就按图片算」的兜底，**不是**「确认这是一张图」。
    // 能不能塞进 <img> 得看 mime 真的以 image/ 开头——否则 application/octet-stream
    // 的记录会走进 <img>，得到裂图加一行浅灰 alt 文字，那正是这段代码一直在防的东西。
    const canRenderImage = String(rec?.mime || '').startsWith('image/');
    if (!rec || !canRenderImage) {
      mountPreview(filePlaceholder(rec, kind));
      return;
    }
    const url = await getFullUrl(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    if (!url) {
      // 记录在、URL 却建不出来：按图片算但只能给占位。老记录没有 name，会落到默认文案上。
      mountPreview(filePlaceholder(rec, kind));
      return;
    }
    mountPreview(el('img', { class: 'inv-preview', src: url, alt: '发票' }));
  }

  async function pickFile(file) {
    if (!file) return;
    // 上限在 prepareFile **之前**判：那个函数的契约是「任何一步失败都回退原图，
    // 不能因为省体积就把用户的发票弄丢」，往里塞一个「直接拒绝」的分支会把契约弄浑。
    // 这里直接 return，不碰 previewSeq、不碰 state.fileId——上一次选的文件继续有效，
    // 用户也不该因为选错了一个大文件就丢掉上一张已经选好的票。
    if ((Number(file.size) || 0) > MAX_FILE_BYTES) {
      errorNode.textContent = '这个文件太大了（超过 20 MB）。发票一般没这么大——原来选好的那张没有变';
      return;
    }
    const seq = ++previewSeq;
    state.busy = true;
    errorNode.textContent = '';
    try {
      const prepared = await prepareFile(file);
      const fileId = await saveFile(prepared);
      // 处理这张图的期间用户又选了另一张（手机上压缩一张要几百毫秒到数秒，很常见）：
      // 这一次已经不是他要的那张了，连 state.fileId 都不要写回去——写了，界面上和随后
      // 保存进发票的都会是先选的那张，而用户明明选的是后一张。它落的库由 cleanupOrphanFiles 收走。
      if (seq !== previewSeq) return;
      state.fileId = fileId;
      // 告诉清理逻辑「这张正拿在手里」：它还没被任何发票引用，光靠 24 小时那条时间线护不住。
      setEditingFile(fileId);
      if (prepared.failed) {
        errorNode.textContent = '图片未能压缩，已按原样保存';
      } else if (prepared.compressed) {
        const saved = Math.round((1 - prepared.size / prepared.originalSize) * 100);
        errorNode.textContent = `已压缩，省了约 ${saved}%`;
      }
      await paintPreview();
    } catch (err) {
      // 失败提示同样要过序号：用户已经换了下一张图时，这条错误说的是上一张，别贴到新预览上。
      if (seq === previewSeq) errorNode.textContent = '图片保存失败：' + (err?.message || err);
    } finally {
      // busy 只由最新那次选图来清：迟到的旧选图提前把 busy 清零，用户就会在下一张图还没
      // 处理完的时候保存（正是「存下一张没有图的发票」那条路）。
      if (seq === previewSeq) state.busy = false;
    }
  }

  // 把当前文件导出到手机的下载目录。
  // 为什么不是「预览」：OFD / PDF 在这个 WebView 里都渲染不了，能做的只有把原件交出去，
  // 让系统里的 OFD 阅读器 / PDF 阅读器去打开它。
  //
  // 顺序：先 await 把 blob 和名字都取好，再调 downloadBlob。await 之后调没问题
  // （备份导出就是这么干的，真机验过），要求的是不要在 downloadBlob 内部再插 await。
  async function exportCurrentFile() {
    const fileId = state.fileId;
    if (!fileId || exporting) return;
    exporting = true;
    try {
      const rec = await getFile(fileId);
      if (!rec?.blob) {
        errorNode.textContent = '文件读不出来了，请重新选择一次';
        return;
      }
      const kind = fileKind(rec.mime, rec.name);
      const fallback = fallbackFileName({
        number: state.number, issuedAt: state.issuedAt, kind, mime: rec.mime
      });
      // 有原始名就用它（用户认得出这是哪个文件），没有才用兜底名。
      // 净化交给 sanitizeFilename：库里存的是未净化的原始名（可能含路径分隔符、控制字符、超长）。
      const filename = sanitizeFilename(rec.name, fallback);
      downloadBlob(rec.blob, filename);
      errorNode.textContent = `已导出到手机的下载目录：${filename}`;
    } catch (err) {
      console.error('导出发票文件失败', err);
      errorNode.textContent = '导出失败：' + (err?.message || err);
    } finally {
      exporting = false;
    }
  }

  function fileInput(accept, capture) {
    const input = el('input', {
      type: 'file', accept,
      ...(capture ? { capture } : {}),
      style: 'display:none',
      onchange: (e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }
    });
    return input;
  }

  const cameraInput = fileInput('image/*', 'environment');
  const albumInput = fileInput('image/*,application/pdf,.ofd,application/ofd');

  const amountText = el('div', { class: 'vault-code', text: '¥0.00' });
  const keypad = createKeypad({
    onChange: ({ cents }) => {
      state.amountCents = cents;
      amountText.textContent = cents === null ? '¥0.00' : formatCents(cents, { symbol: true });
    }
  });

  const numberInput = el('input', {
    type: 'text', placeholder: '发票号码',
    oninput: (e) => { state.number = e.target.value; }
  });

  function field(label, node) {
    return el('label', { class: 'stack', style: 'gap:4px' }, [
      el('span', { class: 'k', text: label }),
      node
    ]);
  }

  const typeSelect = el('select', {
    onchange: (e) => { state.type = e.target.value; }
  }, INVOICE_TYPES.map(t => el('option', { value: t.id, text: t.label })));

  // 这几个输入框要具名：load() 回填时必须逐个写回控件的 value，
  // 只把值塞进 state 是不够的（state 有值 ≠ 界面上有值）。
  const sellerInput = el('input', { type: 'text', placeholder: '开票单位名称', oninput: (e) => { state.seller = e.target.value; } });
  const buyerTitleInput = el('input', { type: 'text', oninput: (e) => { state.buyerTitle = e.target.value; } });
  const buyerTaxIdInput = el('input', { type: 'text', oninput: (e) => { state.buyerTaxId = e.target.value; } });
  const noteInput = el('input', { type: 'text', oninput: (e) => { state.note = e.target.value; } });
  const archivedCheck = el('input', { type: 'checkbox', onchange: (e) => { state.archived = e.target.checked; } });

  async function submit() {
    // 两道锁放最前面（与 entry-panel.js 一致）：saving 期间连查重都不必再跑一遍，
    // submitted 之后连提示都不该再弹。先置位、再 await——置位晚一步，两次点击就都进得来。
    if (saving || submitted) return;
    // 图片还在 prepareFile / saveFile 里（手机上几百毫秒到数秒）。这时候放过去，
    // 写进发票的 fileId 还是 null：用户以为图存上了，而图片随后写好的那个 fileId
    // 再没有任何人引用，直接变成孤儿。宁可让他等一下。
    if (state.busy) {
      errorNode.textContent = '图片还在处理，稍等一下再保存';
      return;
    }
    saving = true;
    errorNode.textContent = '';

    try {
      const check = validateInvoice(state);
      if (!check.ok) { errorNode.textContent = check.errors.join('；'); return; }

      // 查重：**只提示、不阻止**（规格第 5 节）。号码为空时不查。
      // 两段式：第一次点「保存」只提示，再点一次才真的存进去。直接用 return 拦住是不对的——
      // 同一张票补扫一次、纸质票号码撞了，都是真会遇到的合法情况，用户必须能强行存。
      // 号码可能是 null（备份恢复进来的老数据完全可能）：直接 .trim() 会抛 TypeError，
      // 而这个 async 函数没人接这个异常——用户点了「保存」什么都不发生，连提示都没有。
      const number = String(state.number ?? '').trim();
      if (number) {
        const dup = await invoiceStore.findByNumber(number);
        if (dup && dup.id !== state.id && !dupWarned) {
          dupWarned = true;
          errorNode.textContent = `这张票已经录过了（${dup.seller || dup.number}，${formatCents(dup.amountCents, { symbol: true })}）。要再存一张就再点一次「保存」。`;
          return;
        }
      }

      await invoiceStore.saveInvoice(state);
      // 成功就锁死：sheet.close() 之后节点还要留 ~180ms 才移除，这期间再点一次「保存」
      // 就是实打实的第二条记录。
      submitted = true;
      // 这张图已经进了发票，不再需要「正在编辑」这道保护。
      setEditingFile(null);
      sheet.close();
      activeSheet = null;
      // 回调必须自己吞掉异常：面板此刻已经收起，把错误写进 errorNode 用户根本看不到
      // （照 ledger-home.js 里那几个重渲染回调的做法，控制台留痕就够了）。
      if (onSaved) {
        try {
          await onSaved();
        } catch (err) {
          console.error('发票保存后的回调失败', err);
        }
      }
    } catch (err) {
      errorNode.textContent = String(err?.message || err);
    } finally {
      // 校验不过、查重提示、保存失败都要放开这道锁，否则用户再点「保存」就永远进不来了
      // （查重本来就是两段式的，它必须能再点一次）。成功那一路有 submitted 兜着，放开也无妨。
      saving = false;
    }
  }

  async function load() {
    if (!id) return;
    const inv = await invoiceStore.getInvoice(id);
    if (!inv) {
      // 记录已经不在了（在别处被删、或备份恢复整个换了一份数据）。必须连 state.id 一起清掉：
      // 留着这个旧 id 再点「保存」，saveInvoice 找不到 existing 就会拿它插一条新的空票——
      // 用户以为在编辑，实际是「复活」出一张什么都没有的发票。而且要说出来，不能静默返回。
      state.id = null;
      errorNode.textContent = '这张发票已经不在了（可能已在别处删除）；现在保存会新建一张。';
      return;
    }
    Object.assign(state, inv);
    // 逐个写回控件：少这几行，编辑已有发票时所有字段都是空白，
    // 用户随便改一个字段再保存，就把原来的号码/销售方/抬头全清了。
    numberInput.value = inv.number ?? '';
    typeSelect.value = inv.type ?? 'other';
    sellerInput.value = inv.seller ?? '';
    buyerTitleInput.value = inv.buyerTitle ?? '';
    buyerTaxIdInput.value = inv.buyerTaxId ?? '';
    noteInput.value = inv.note ?? '';
    archivedCheck.checked = inv.archived === true;
    // 金额只能走 setFromCents（纪律 3）：formatCents 的输出带 ¥，键盘解析不了会变空。
    keypad.setFromCents(inv.amountCents ?? 0);
    amountText.textContent = formatCents(inv.amountCents ?? 0, { symbol: true });
  }

  // —— 关联账目 ——

  // 分类名：转账本来就没有分类（categoryId 是 null），单独说「转账」；分类在设置里被删过
  // 就退回「未分类」——留一段空白会让人以为是渲染坏了。
  function txnNameOf(t) {
    if (t.kind === 'transfer') return '⇄ 转账';
    const cat = catOf.get(t.categoryId);
    return `${cat?.icon || '📦'} ${cat?.name || '未分类'}`;
  }

  // 日期用 formatDayLabel：最近两天说「今天 / 昨天」，再往前是「M月D日」，
  // 与首页流水行、发票列表是同一套说法。
  function txnDateOf(t) {
    return formatDayLabel(t.occurredAt, Date.now());
  }

  function txnCentsOf(t) {
    // 金额坏掉时按 0 显示：formatCents(undefined) 会打出 ¥NaN，比一个 0 难看得多。
    return formatCents(Number.isSafeInteger(t.amountCents) ? t.amountCents : 0, { symbol: true });
  }

  function renderPicker() {
    if (txnsFailed) {
      return el('div', { class: 'muted tiny', text: '账目列表读取失败，关掉面板重开一次再试' });
    }
    if (txnByDate.length === 0) {
      return el('div', { class: 'muted tiny', text: '最近 6 个月还没有记账' });
    }
    return el('div', { class: 'inv-link-list' }, txnByDate.map(t => el('button', {
      class: 'inv-link-row', type: 'button',
      onclick: () => {
        state.txnId = t.id;
        // 选完就收起：留着列表只会把面板撑长，而这一次选择已经做完了。
        pickerOpen = false;
        paintTxnField();
      }
    }, [
      el('span', { text: `${txnDateOf(t)} · ${txnNameOf(t)}` }),
      el('span', { class: 'num', text: txnCentsOf(t) })
    ])));
  }

  function paintTxnField() {
    const linked = state.txnId ? txns.find(t => t.id === state.txnId) : null;

    if (!txnsLoaded) {
      txnStatus.className = 'inv-link-status';
      txnStatus.textContent = '账目读取中…';
    } else if (!state.txnId) {
      txnStatus.className = 'inv-link-status';
      txnStatus.textContent = '未关联';
    } else if (linked) {
      txnStatus.className = 'inv-link-status';
      txnStatus.textContent = `${txnDateOf(linked)} · ${txnNameOf(linked)} · ${txnCentsOf(linked)}`;
    } else {
      // 账确实找不到了（被删掉，或这台设备上本来就没有它）。如实说出来，不留空白也不抛错。
      // 这里**不**动 state.txnId：用户可能只是记错了，重新选一笔就好；真要清掉得他自己点
      // 「取消关联」。面板里的改动一律以「保存」为准，所以此刻它还没有落库。
      txnStatus.className = 'inv-link-missing';
      txnStatus.textContent = '已关联的账目已不存在';
    }

    const actions = [el('button', {
      class: 'btn', type: 'button', text: '选一笔账',
      onclick: () => { pickerOpen = !pickerOpen; paintTxnField(); }
    })];
    if (state.txnId) {
      actions.push(el('button', {
        class: 'btn', type: 'button', text: '取消关联',
        // 只把 state.txnId 置 null，不碰库：这个面板里所有改动都等「保存」才落盘
        // （与改号码、改销售方一样），所以反悔的成本是零——关掉面板就行。
        onclick: () => { state.txnId = null; pickerOpen = false; paintTxnField(); }
      }));
    }
    mount(txnActions, actions);
    mount(txnPicker, pickerOpen ? [renderPicker()] : []);
  }

  async function loadTxns() {
    try {
      // 两份数据一起取：分类只用来把 categoryId 翻成名字，串行 await 只是白等一个事务。
      const [list, categories] = await Promise.all([
        store.listTransactionsInMonths(6),
        store.listAllCategories()
      ]);
      catOf = new Map(categories.map(c => [c.id, c]));
      txns = list;
      // 候选列表在副本上倒序（仓库层是按时间正序返回的），再截到最近 50 笔。
      txnByDate = list.slice().sort((a, b) => b.occurredAt - a.occurredAt).slice(0, MAX_TXN_OPTIONS);

      // 已经挂着的那笔可能比 6 个月还早（票是过后才挂上去的，也可能是备份恢复进来的）：
      // 只看这 6 个月会把它当成「已删除」，报一句会吓到人的错话。仓库层没有按 id 查单笔交易的
      // 接口，只能用一次更宽的时间窗确认它到底还在不在——只在「这 6 个月里找不到」时才多查一次。
      if (state.txnId && !list.some(t => t.id === state.txnId)) {
        const wider = await store.listTransactionsInMonths(LINKED_LOOKBACK_MONTHS);
        const older = wider.find(t => t.id === state.txnId);
        if (older) txns = list.concat([older]);
      }
    } catch (err) {
      // 取不到不挡着存票：这一行退化成一句说明，发票本身照常能存能改。
      txnsFailed = true;
      console.error('关联账目的候选流水读取失败', err);
    }
    txnsLoaded = true;
    paintTxnField();
  }

  // —— 删除这张发票 ——

  // 复原确认态：按钮文字回到原样。超时与「点完第二次」都走这里，只此一份。
  function disarmDelete() {
    delArmed = false;
    if (delTimer) { clearTimeout(delTimer); delTimer = null; }
    if (deleteBtn) deleteBtn.textContent = '删除这张发票';
  }

  async function removeInvoice() {
    // 与 submit 同一套两道锁：保存/删除还没走完、或已经存过/删过，都不许再进来。
    if (saving || submitted || deleting) return;
    if (!state.id) {
      // 记录已经不在了（load 里刚把 state.id 清掉）。别去调仓库层——deleteInvoice(null)
      // 会拿 null 当主键查库，抛出来的是一个英文的 IndexedDB 异常。
      errorNode.textContent = '这张发票已经不在了，不必删除';
      return;
    }
    // 图片还在 prepareFile / saveFile 里（手机上几百毫秒到数秒）时不许删，与 submit 同一道门槛。
    // 放过去的话，那次选图会在面板关掉之后回来写 state.fileId、并挂上 setEditingFile 的
    // 「正在编辑」标记——那个标记一走神就再没人摘，孤儿图清理会一直跳过这张图。
    if (state.busy) {
      errorNode.textContent = '图片还在处理，稍等一下再删除';
      return;
    }
    // 两段式：第一次点只进入确认态，再点一次才真的删。刻意不用 window.confirm——
    // 那是同步阻塞的系统弹窗，样式不可控、在 PWA 里还会打断整页，而这个项目所有交互
    // 都不用系统弹窗（查重提示、密码箱的「确认删除？」都是改按钮文字），
    // 按钮就长在手指底下，改文字是最轻的确认方式。
    if (!delArmed) {
      delArmed = true;
      deleteBtn.textContent = '再点一次就删除';
      // 几秒后自动复原：用户点了第一次又去改别的字段、然后顺手点「保存」是常见路径，
      // 一个一直亮着「再点一次就删除」的按钮会让下一次误触直接删掉发票。
      delTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    disarmDelete();
    deleting = true;
    deleteBtn.disabled = true;
    errorNode.textContent = '';

    try {
      await invoiceStore.deleteInvoice(state.id);
    } catch (err) {
      // 删除失败绝不关面板：用户得知道为什么没删掉（配额、库被占用…）。
      // 关掉面板会让他以为删成功了，下次进来发现票还在。
      deleting = false;
      deleteBtn.disabled = false;
      errorNode.textContent = '删除失败：' + (err?.message || err);
      console.error(err);
      return;
    }

    // 删除**不可逆**：库里的记录连同它的图片一起没了（deleteInvoice 里连着删图），没有回收站。
    // 所以成功之后用 submitted 把整块面板锁死——sheet.close() 之后节点还要留 ~180ms，
    // 这期间再点「保存」会把这张刚删掉的发票原样写回去（state.id 还在）。
    submitted = true;
    // 那张图已经被删掉了，编辑器不再「正在编辑」任何东西，把孤儿图清理的保护摘掉。
    setEditingFile(null);
    sheet.close();
    activeSheet = null;
    // 回调必须自己吞异常：面板已经收起，把错误写进 errorNode 用户根本看不到
    // （与保存成功后那段同一套约定）。
    if (onSaved) {
      try {
        await onSaved();
      } catch (err) {
        console.error('发票删除后的回调失败', err);
      }
    }
  }

  // mount(parent, ...nodes) 是变参（内部还会 flat），这里按项目其它视图的写法传变参。
  mount(body,
    errorNode,
    previewBox,
    exportRow,
    el('div', { class: 'stack', style: 'gap:6px' }, [
      el('button', { class: 'btn', type: 'button', text: '拍照', onclick: () => cameraInput.click() }),
      el('button', { class: 'btn', type: 'button', text: '选图片 / PDF / OFD', onclick: () => albumInput.click() })
    ]),
    cameraInput, albumInput,
    field('发票号码', numberInput),
    field('价税合计', amountText),
    keypad.node,
    field('销售方', sellerInput),
    field('发票类型', typeSelect),
    field('购买方抬头', buyerTitleInput),
    field('纳税人识别号', buyerTaxIdInput),
    el('label', { class: 'vault-check' }, [
      archivedCheck,
      el('span', { text: '仅存档（不参与报销追踪）' })
    ]),
    field('备注', noteInput),
    // 关联账目：先有票、再决定挂到哪笔账上，这是更贴近真实使用顺序的入口。
    // 记账首页那个「🧾N」标记只在某笔账**已经有票**时才出现（见 ledger-home.js），
    // 所以「给一笔还没挂票的账挂上第一张票」这条路只有这里能走通。
    // 这里不用 field()：它返回的是 <label>，包住按钮之后连点「关联账目」这几个字都会触发
    // 第一个按钮（label 会把点击转给第一个可标记的后代），出现「点标题却打开了列表」。
    el('div', { class: 'stack', style: 'gap:4px' }, [
      el('span', { class: 'k', text: '关联账目' }),
      txnBox
    ]),
    el('button', { class: 'btn btn-primary', type: 'button', text: '保存', onclick: submit }),
    deleteBtn
  );

  // 启动顺序是刻意的：先回填发票（load 会写 state.txnId），再取流水——「已关联的那笔账还在不在」
  // 必须按回填后的 txnId 判断，顺序反了，编辑一张挂了老账的票会得出一句错的结论。
  // 两份数据各兜各的异常：发票读不出来时不该再画预览（那会显示成「还没有图片」，是错的信息），
  // 而流水仍然要取，否则「关联账目」那一行会永远停在「账目读取中…」。
  (async () => {
    let loaded = false;
    try {
      await load();
      loaded = true;
    } catch (err) {
      errorNode.textContent = String(err?.message || err);
    }
    await loadTxns();
    if (loaded) await paintPreview();
  })().catch(err => { errorNode.textContent = String(err?.message || err); });
}
