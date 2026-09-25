// 新建 / 编辑发票的半屏 sheet。
// 复用项目既有的 openSheet 与 createKeypad，不另造一套。

import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import * as invoiceStore from '../invoice-store.js';
import { prepareFile, saveFile, getFile, getFullUrl, revokeUrl, setEditingFile } from '../image-store.js';
import { INVOICE_TYPES, validateInvoice } from '../invoice-model.js';
import { formatCents } from '../money.js';

let activeSheet = null;

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

  const errorNode = el('div', { class: 'vault-error' });
  const previewBox = el('div', {});
  const body = el('div', { class: 'stack' });

  const sheet = openSheet({ title: id ? '编辑发票' : '新建发票', body });
  activeSheet = sheet;

  // 换预览内容时先记住旧节点：从图片换成 PDF 占位之后，旧图片那个 object URL 再没人持有，
  // 不 revoke 就是每换一次文件泄漏一份内存（原来只在「图换图」那一支做了，漏了「图换 PDF」）。
  function mountPreview(node) {
    const old = previewBox.firstChild;
    mount(previewBox, node);
    if (old?.tagName === 'IMG') revokeUrl(old.src);
  }

  async function paintPreview() {
    const seq = ++previewSeq;
    // 把这次要画的 fileId 固定下来：await 期间它可能被下一次选图换掉，
    // 而那时该由那一次自己来画。
    const fileId = state.fileId;
    if (!fileId) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '🧾 还没有图片' }));
      return;
    }
    // PDF 不能塞进 <img>：getFullUrl 对任何存在的记录都返回一个 blob URL，
    // 只判 `!url` 是拦不住它的——那样 <img src="blob:…pdf"> 加载失败，用户看到的是裂图加
    // 一行浅灰的 alt 文字，比干脆不显示更糟。所以先取一次记录看 mime，只有图片才走 <img>。
    const rec = await getFile(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    if (!rec || !String(rec.mime || '').startsWith('image/')) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '📄 PDF 已保存' }));
      return;
    }
    const url = await getFullUrl(fileId).catch(() => null);
    if (seq !== previewSeq) return;
    if (!url) {
      mountPreview(el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '📄 PDF 已保存' }));
      return;
    }
    mountPreview(el('img', { class: 'inv-preview', src: url, alt: '发票' }));
  }

  async function pickFile(file) {
    if (!file) return;
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
  const albumInput = fileInput('image/*,application/pdf');

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

  // mount(parent, ...nodes) 是变参（内部还会 flat），这里按项目其它视图的写法传变参。
  mount(body,
    errorNode,
    previewBox,
    el('div', { class: 'stack', style: 'gap:6px' }, [
      el('button', { class: 'btn', type: 'button', text: '拍照', onclick: () => cameraInput.click() }),
      el('button', { class: 'btn', type: 'button', text: '选图片或 PDF', onclick: () => albumInput.click() })
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
    el('button', { class: 'btn btn-primary', type: 'button', text: '保存', onclick: submit })
  );

  load().then(paintPreview).catch(err => { errorNode.textContent = String(err?.message || err); });
}
