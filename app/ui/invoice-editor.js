// 新建 / 编辑发票的半屏 sheet。
// 复用项目既有的 openSheet 与 createKeypad，不另造一套。

import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import * as invoiceStore from '../invoice-store.js';
import * as store from '../store.js';
import { prepareFile, saveFile, getFullUrl, revokeUrl } from '../image-store.js';
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

  const errorNode = el('div', { class: 'vault-error' });
  const previewBox = el('div', {});
  const body = el('div', { class: 'stack' });

  const sheet = openSheet({ title: id ? '编辑发票' : '新建发票', body });
  activeSheet = sheet;

  async function paintPreview() {
    if (!state.fileId) {
      mount(previewBox, el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '🧾 还没有图片' }));
      return;
    }
    const url = await getFullUrl(state.fileId).catch(() => null);
    if (!url) {
      mount(previewBox, el('div', { class: 'inv-thumb', style: 'width:100%;height:130px', text: '📄 PDF 已保存' }));
      return;
    }
    const img = el('img', { class: 'inv-preview', src: url, alt: '发票' });
    // 图片换成新的之后要释放旧的 object URL，否则每换一次泄漏一份内存
    const old = previewBox.firstChild;
    mount(previewBox, img);
    if (old?.tagName === 'IMG') revokeUrl(old.src);
  }

  async function pickFile(file) {
    if (!file) return;
    state.busy = true;
    errorNode.textContent = '';
    try {
      const prepared = await prepareFile(file);
      const fileId = await saveFile(prepared);
      state.fileId = fileId;
      if (prepared.failed) {
        errorNode.textContent = '图片未能压缩，已按原样保存';
      } else if (prepared.compressed) {
        const saved = Math.round((1 - prepared.size / prepared.originalSize) * 100);
        errorNode.textContent = `已压缩，省了约 ${saved}%`;
      }
      await paintPreview();
    } catch (err) {
      errorNode.textContent = '图片保存失败：' + (err?.message || err);
    } finally {
      state.busy = false;
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
    errorNode.textContent = '';
    const check = validateInvoice(state);
    if (!check.ok) { errorNode.textContent = check.errors.join('；'); return; }

    // 查重：**只提示、不阻止**（规格第 5 节）。号码为空时不查。
    // 两段式：第一次点「保存」只提示，再点一次才真的存进去。直接用 return 拦住是不对的——
    // 同一张票补扫一次、纸质票号码撞了，都是真会遇到的合法情况，用户必须能强行存。
    if (state.number.trim()) {
      const dup = await invoiceStore.findByNumber(state.number);
      if (dup && dup.id !== state.id && !dupWarned) {
        dupWarned = true;
        errorNode.textContent = `这张票已经录过了（${dup.seller || dup.number}，${formatCents(dup.amountCents, { symbol: true })}）。要再存一张就再点一次「保存」。`;
        return;
      }
    }

    try {
      await invoiceStore.saveInvoice(state);
      sheet.close();
      activeSheet = null;
      if (onSaved) await onSaved();
    } catch (err) {
      errorNode.textContent = String(err?.message || err);
    }
  }

  async function load() {
    if (!id) return;
    const inv = await invoiceStore.getInvoice(id);
    if (!inv) return;
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
