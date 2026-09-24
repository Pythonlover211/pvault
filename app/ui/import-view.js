// 账单导入向导（计划 3 · 任务 5）：选文件 → 认表头 → 指定列 → 预览确认 → 撤销浮层。
//
// 为什么五步都在**同一层** sheet 里切换：sheet.js 每开一层都会把 body.style.overflow 设成
// 'hidden'，而 close() 一律把它清空——两层同时挂着时，关掉任意一层就把另一层的滚动锁拆了
// （settings-sheet.js 顶部那段注释记的就是这个坑）。向导不但有四个步骤，还要能来回退，
// 嵌套第二层只会把这个问题放大，所以这里只重画 sheet body 的内容，绝不 openSheet 第二次。
//
// 另外三条纪律：
// 1. **解析文件只跑一次**：parseCsv 在选文件时跑；mapRows 在第一次进预览步时跑，结果缓存在
//    state.mapped。之后改默认分类/账户只重跑 prepareImport（只有它需要往 fresh 记录里写
//    分类与账户），不重新解析整份文件——几千行的账单来回改分类不该变成几秒钟的卡顿。
// 2. **预览表只渲染前 20 条**：几千行的文件全塞进 DOM 会把面板顶成几十万个节点，
//    手机上直接卡死。显示多少条与库里写入多少条无关。
// 3. **确认之前一次写入都没有**：commitImport 只出现在「确认导入」那一个点击处理里，
//    这是可以被探针直接断言的结构（与 backup-view 同一套纪律）。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import * as store from '../store.js';
import { decodeBytes, parseCsv, UNCLOSED_QUOTE_CODE, UTF16_CODE } from '../csv.js';
import {
  FIELDS, DETECT_SCAN_LIMIT, detectPreset, buildColumnIndex, autoMapping, mapRows,
  UNRESOLVED_DIRECTION_REASON
} from '../import-schema.js';
import { prepareImport, commitImport, undoImport, listProfiles, saveProfile } from '../import-store.js';
import { formatCents } from '../money.js';

const FIELD_LABELS = { time: '时间', amount: '金额', direction: '收支方向', merchant: '商户', note: '备注' };
// 时间与金额必选：没有它们的「记录」连一笔账都算不上。其余三个可以为空。
const REQUIRED_FIELDS = new Set(['time', 'amount']);

const HEAD_ROW_PREVIEW = 5;    // 让用户指认表头时，最多看前 5 行
const RECORD_PREVIEW = 20;     // 待导入记录的预览条数（只影响渲染，不影响写入）
const ERROR_PREVIEW = 5;       // 解析失败明细的显示条数

// 20MB 上限：手机上一次读进内存在这个量级还稳，再大就开始出事。实测 26MB / 30 万行的纯解析
// 时间是 ≈2.5 秒（parseCsv 1.2s + detectPreset 0.5s + mapRows 0.7s），期间界面完全无响应；
// 2GB 的文件会直接把标签页 OOM 掉（白屏，什么都没了）。所以超限就在这里拒绝，根本不读文件。
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// 撤销窗口。5 分钟是「刚导完发现选错了分类/账户」这类后悔的合理时长：
// 再长用户已经去干别的了，浮层会一直赖在屏幕上（它盖在首页底部）。
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

const STEP_TITLES = {
  1: '第 1 步 · 选择文件',
  2: '第 2 步 · 哪一行是表头',
  3: '第 3 步 · 每一列是什么',
  4: '第 4 步 · 预览与确认',
  5: '完成'
};

const KIND_LABELS = { expense: '支出', income: '收入', transfer: '转账' };

const blankMapping = () => ({ time: null, amount: null, direction: null, merchant: null, note: null });

// 时间戳 → 「2026-09-23 14:05」。不能走 toISOString：它转 UTC，东八区晚上 8 点会显示成中午。
function formatTime(ts) {
  const d = new Date(Number(ts));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 让出一帧再干重活：解析 30 万行要 2 秒多，不让出这一帧的话「正在读取…」根本没机会画出来，
// 用户面对的是一段完全无反馈的卡顿。
function nextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

// 两类「文件本身有问题」的错误要给出可执行的处置办法。剩下的才是意外，照实说。
function fileErrorMessage(err) {
  if (err?.code === UTF16_CODE) return err.message;
  if (err?.code === UNCLOSED_QUOTE_CODE) return '文件里有未闭合的引号，请用 Excel 重新另存为 CSV。';
  return '读取文件失败：' + (err?.message || err);
}

// detectPreset 只回答「这份文件像哪种账单」，不告诉你是哪一行命中的，而后面
// buildColumnIndex / mapRows 都要那一行。判据与 import-schema.js 里的 headerMatches 完全一致
// （时间列与金额列都在），故意重复这两行而不是去改动已交付的模块签名。
function presetHeaderIndex(rows, preset) {
  const { time, amount } = preset.columns;
  // 与 detectPreset 同一个扫描窗口：命中既然在前 50 行内，就没理由为了「更完整」再扫几十万行。
  const limit = Math.min(rows.length, DETECT_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const idx = buildColumnIndex(rows[i]);
    if (idx.has(time) && idx.has(amount)) return i;
  }
  return null;
}

// 同一时刻只留一个撤销浮层（与 entry-panel.js 里那套同理：位置完全重合，叠起来既看不见
// 也点不到）。两个模块各自持有一份引用是有意的——抽公共组件要动已交付的录入面板，
// 而这里多出来的只是一次赋值。代价：记账后立刻导入会短暂并存两个浮层，互不干扰。
let activeToast = null;

function showUndoToast({ count, ids, onUndone }) {
  if (activeToast) {
    activeToast.remove();
    activeToast = null;
  }

  // 撤销只能生效一次：await undoImport 期间浮层还在页面上，双击会发出两次删除。
  let settled = false;
  let confirming = false;
  let timer = null;
  let labelText = `已导入 ${count} 条`;

  const slot = el('div', { class: 'import-toast-slot' });
  const toast = el('div', { class: 'toast', dataset: { role: 'import-toast' } }, [slot]);

  function paint() {
    if (!confirming) {
      mount(slot, [
        el('span', { dataset: { role: 'import-toast-label' }, text: labelText }),
        el('button', {
          type: 'button', text: '撤销', dataset: { role: 'import-undo' },
          onclick: () => {
            // 二次确认不是客套：撤销删的是**本次导入的 id**，这些 id 上后来被用户改过的
            // 分类、备注、金额都会一起没掉。少这一次点击，误触的代价是一批账。
            confirming = true;
            toast.classList.add('import-confirming');
            paint();
          }
        })
      ]);
      return;
    }
    const confirmBtn = el('button', {
      type: 'button', text: '确定删除', dataset: { role: 'import-undo-confirm-btn' },
      onclick: () => { doUndo(confirmBtn); }
    });
    mount(slot, [
      el('div', {
        class: 'import-toast-text', dataset: { role: 'import-undo-confirm' },
        text: `将删除本次导入的 ${count} 条记录，包含你之后修改过的。确定吗？`
      }),
      el('div', { class: 'import-toast-actions' }, [
        el('button', {
          type: 'button', text: '取消', dataset: { role: 'import-undo-cancel' },
          onclick: () => { confirming = false; toast.classList.remove('import-confirming'); paint(); }
        }),
        confirmBtn
      ])
    ]);
  }

  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (activeToast === toast) activeToast = null;
    toast.classList.remove('open');
    // 等 .18s 的退场过渡走完再摘节点，否则浮层会瞬间消失、没有动画。
    setTimeout(() => toast.remove(), 200);
  }

  async function doUndo(btn) {
    if (settled) return;
    // 先置位、再 await：第二次点击（包括 await 期间的那次）会被这一行挡住。
    settled = true;
    btn.disabled = true;
    try {
      await undoImport(ids);
    } catch (err) {
      // 撤销失败就把浮层留在原地并恢复可点：否则用户看到「已导入」消失，
      // 会以为删干净了，实际那些记录还在库里。
      settled = false;
      confirming = false;
      toast.classList.remove('import-confirming');
      labelText = '撤销失败，请重试';
      paint();
      console.error('撤销导入失败', err);
      return;
    }
    dismiss();
    if (onUndone) onUndone();
  }

  paint();
  activeToast = toast;
  document.body.append(toast);
  // 先挂 DOM 再在下一帧加 .open：同一帧里做，浏览器会把「初始 opacity:0」和 .open
  // 合并成一次样式计算，过渡不会播放（和 sheet.js / entry-panel.js 同理）。
  requestAnimationFrame(() => toast.classList.add('open'));
  timer = setTimeout(dismiss, UNDO_WINDOW_MS);
  return toast;
}

export function openImportSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '账单导入', body });

  const state = {
    step: 1,
    stepError: '',
    fileName: '',
    rows: null,          // parseCsv 的结果：只在选文件时算一次
    preset: null,
    headerIndex: null,
    mapping: blankMapping(),
    // 「这批金额全部算作支出/收入」：只在收支方向列没被映射时才用得上。
    // 故意不预选——见 import-schema.js 的 mapRows。
    defaultKind: null,
    mapped: null,        // { records, errors, skipped }：mapRows 的缓存，配置变一次才重算一次
    prepared: null,      // { fresh, duplicates }
    loading: false,
    reading: false,
    committing: false,
    committed: null,     // { ids, count, skipped }
    reverted: false,
    expenseCategories: null,
    incomeCategories: null,
    accounts: null,
    profiles: null,
    profileId: '',
    profileName: ''
  };

  // 改动过就通知外面重画（首页的今日流水、统计页的月度数字都会变）。
  // onChanged 是调用方注入的，它一抛错不能连累「已经写入」这件事的呈现，所以单独吞掉。
  function notify() {
    try {
      if (onChanged) onChanged();
    } catch (err) {
      console.error('导入后的界面刷新失败', err);
    }
  }

  // ── 数据加载（都幂等缓存，失败兜成空列表，不让一次读失败把整个向导挡住） ──

  async function ensureProfiles() {
    if (state.profiles) return state.profiles;
    try {
      state.profiles = await listProfiles();
    } catch (err) {
      console.error('读取导入格式配置失败', err);
      state.profiles = [];
    }
    return state.profiles;
  }

  async function ensureOptions() {
    if (!state.expenseCategories) {
      try {
        state.expenseCategories = await store.listCategories('expense');
      } catch (err) {
        console.error('读取支出分类失败', err);
        state.expenseCategories = [];
      }
    }
    if (!state.incomeCategories) {
      try {
        state.incomeCategories = await store.listCategories('income');
      } catch (err) {
        console.error('读取收入分类失败', err);
        state.incomeCategories = [];
      }
    }
    if (!state.accounts) {
      try {
        state.accounts = await store.listAccounts();
      } catch (err) {
        console.error('读取账户失败', err);
        state.accounts = [];
      }
    }
    // 默认分类/账户取第一个：绝大多数导入都是「一律算作餐饮、一律走微信」，
    // 先给一个能直接用的值，比让用户先面对一个空下拉强。
    // 支出与收入各一份：收入记录套用支出分类会让首页工资显示成「🍜 餐饮 +12000」。
    if (state.defaultCategoryId == null) state.defaultCategoryId = state.expenseCategories[0]?.id ?? null;
    if (state.defaultIncomeCategoryId == null) state.defaultIncomeCategoryId = state.incomeCategories[0]?.id ?? null;
    if (state.defaultAccountId == null) state.defaultAccountId = state.accounts[0]?.id ?? null;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  function render() {
    let view;
    if (state.step === 5 || state.committed) view = stepDone();
    else if (state.step === 1) view = stepFile();
    else if (state.step === 2) view = stepHeader();
    else if (state.step === 3) view = stepMapping();
    else view = state.loading ? stepLoading() : stepPreview();

    mount(body, [
      el('div', { class: 'group-title', dataset: { role: 'import-step' }, text: STEP_TITLES[state.step] }),
      view
    ]);
    // 换步之后回到顶部：面板只有 78vh，停在上一屏的滚动位置会让人以为按钮没了。
    const scroller = body.parentNode;
    if (scroller) scroller.scrollTop = 0;
  }

  const errorLine = () => el('div', { class: 'vault-error', dataset: { role: 'import-error' }, text: state.stepError });

  // ── 第 1 步 · 选择文件 ────────────────────────────────────────────────────

  function stepFile() {
    const fileInput = el('input', {
      // 隐藏但留在 DOM 里：display:none 的 input 依然能被 .click() 唤起文件选择器
      // （前提是这次点击来自用户手势，见下面按钮的 onclick）。
      class: 'vault-file-input', type: 'file', accept: '.csv,text/csv',
      onchange: e => {
        const file = e.target?.files?.[0];
        // 取消选择时 files 为空：停在原地，不要把已经读进来的文件清掉。
        if (file) pickFile(file);
      }
    });
    return el('section', { class: 'card stack' }, [
      // 这句话必须在第一步就一眼看见：拿着 .xlsx 来试是这里最常见的一次失败，
      // 而 .xlsx 要解压 + 解析 XML，与「零依赖」冲突，V1 不做。
      el('div', {
        class: 'vault-warn', dataset: { role: 'import-scope' },
        text: '只支持 CSV。Excel 文件请先在 Excel / WPS 里「另存为 CSV」。'
      }),
      el('div', { class: 'vault-hint', text: '文件只在这台设备的浏览器里解析，不会上传到任何地方。' }),
      fileInput,
      state.reading
        ? el('div', { class: 'vault-hint', dataset: { role: 'import-reading' }, text: '正在读取并解析文件…' })
        : null,
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '选择账单文件',
        dataset: { role: 'import-file' },
        disabled: state.reading,
        // .click() 必须从用户手势里发起：iOS Safari 与部分安卓浏览器会吞掉
        // 「非手势上下文打开的文件选择器」——点了没反应，且没有任何报错。
        onclick: () => { fileInput.click(); }
      }),
      state.stepError ? errorLine() : null
    ]);
  }

  function resetParsed() {
    state.rows = null;
    state.preset = null;
    state.headerIndex = null;
    state.mapping = blankMapping();
    state.defaultKind = null;
    state.mapped = null;
    state.prepared = null;
  }

  async function pickFile(file) {
    state.stepError = '';
    // 先看大小，再谈读文件：arrayBuffer() 面对 2GB 的文件会直接把标签页 OOM 掉（白屏），
    // 而 26MB / 30 万行也要 2 秒多。这个上限必须在读之前挡住，读完了拦就晚了。
    if (Number(file?.size) > MAX_FILE_BYTES) {
      state.stepError = '文件超过 20MB，请先按月拆分后再导入';
      render();
      return;
    }
    // 先画出「正在读取…」再让出一帧，然后才开始解析：解析是同步的，不让出这一帧的话
    // 这句话要等解析结束才可能被画出来，用户看到的只有卡顿。
    state.reading = true;
    render();
    await nextFrame();
    let rows;
    try {
      const buf = await file.arrayBuffer();
      // 微信导出的账单是 GBK，支付宝是 UTF-8：decodeBytes 先按 UTF-8 严格解码，
      // 失败再回落 GBK——所以这里的解码顺序不能换。（UTF-16 的文件会在这一步被拦下并给出
      // 「另存为 CSV UTF-8」的指引，而不是回落 GBK 解出一串乱码。）
      rows = parseCsv(decodeBytes(new Uint8Array(buf)));
    } catch (err) {
      state.reading = false;
      state.stepError = fileErrorMessage(err);
      render();
      return;
    }
    state.reading = false;
    if (!rows || rows.length === 0) {
      // 空文件：留在第 1 步。往后走只会得到一个「0 条记录」的预览页，白让用户点两次。
      state.stepError = '这个文件里没有读到任何行';
      render();
      return;
    }
    resetParsed();
    state.rows = rows;
    state.fileName = file.name || '';
    const preset = detectPreset(rows);
    if (preset) {
      state.preset = preset;
      state.headerIndex = presetHeaderIndex(rows, preset) ?? 0;
      state.mapping = autoMapping(preset, buildColumnIndex(rows[state.headerIndex]));
      await gotoMapping();
      return;
    }
    state.step = 2;
    render();
  }

  // 进第 3 步之前一定要把已保存的格式配置读出来：两条路径（预设命中、手动选表头）
  // 都要落到这一步，只让其中一条加载就会让另一条看不到自己的配置。
  async function gotoMapping() {
    state.step = 3;
    state.stepError = '';
    await ensureProfiles();
    render();
  }

  // ── 第 2 步 · 认表头 ─────────────────────────────────────────────────────

  function stepHeader() {
    const head = state.rows.slice(0, HEAD_ROW_PREVIEW);
    const columns = Math.max(...head.map(r => Math.min(r.length, 6)), 1);
    const nextBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '下一步：指定列',
      dataset: { role: 'import-header-next' },
      disabled: state.headerIndex === null,
      onclick: () => { gotoMapping(); }
    });

    const rows = head.map((row, i) => el('tr', {}, [
      el('td', {}, [el('input', {
        type: 'radio', name: 'import-header-row',
        dataset: { role: `import-head-row-${i}` },
        // 从第 3 步退回来时保持上一次的选择：radio 是重建的，不显式回填就会看起来没选过。
        checked: state.headerIndex === i,
        onchange: () => {
          if (state.headerIndex !== i) {
            state.headerIndex = i;
            // 表头换了，旧的列对应关系与解析结果一律作废。
            state.mapping = blankMapping();
            state.defaultKind = null;
            state.mapped = null;
          }
          // 只切这一个按钮的禁用态，不整页重渲染：重建 radio 会让刚点的那一行跳回未选中。
          nextBtn.disabled = false;
        }
      })]),
      ...Array.from({ length: columns }, (_, c) => el('td', { class: 'import-cell', text: row[c] ?? '' }))
    ]));

    return el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', text: '这份账单没被自动认出来。请在下面点出哪一行是表头（写着「交易时间」「金额」这些字的那一行）。' }),
      el('div', { class: 'vault-hint', text: `文件名：${state.fileName || '（未命名）'}` }),
      el('table', { class: 'import-table', dataset: { role: 'import-head-table' } }, rows),
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '返回上一步', dataset: { role: 'import-back' },
          onclick: () => { resetParsed(); state.step = 1; state.stepError = ''; render(); }
        }),
        nextBtn
      ])
    ]);
  }

  // ── 第 3 步 · 指定列 ─────────────────────────────────────────────────────

  // 下拉选项＝该表头行里的列名。用 buildColumnIndex 而不是直接遍历行数组：
  // 重名列只保留第一次出现的那一列，与 mapRows 取列的口径保持一致。
  function columnSelect(role, values, current, onChange) {
    const node = el('select', {
      dataset: { role },
      onchange: e => { onChange(e.target.value); }
    }, values.map(v => el('option', { value: v.value, text: v.text })));
    // el() 把 value 走的是 setAttribute，对 <select> 不生效，所以构造完再显式赋值。
    node.value = current == null ? '' : String(current);
    return node;
  }

  function stepMapping() {
    const idx = buildColumnIndex(state.rows[state.headerIndex] ?? []);
    const columns = [...idx].map(([name, i]) => ({ value: String(i), text: name }));
    const withEmpty = [{ value: '', text: '（不使用）' }, ...columns];

    const nextBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '下一步：预览',
      dataset: { role: 'import-to-preview' },
      disabled: !FIELDS.every(f => !REQUIRED_FIELDS.has(f) || state.mapping[f] != null),
      onclick: () => { gotoPreview(); }
    });

    const fields = FIELDS.map(field => {
      const required = REQUIRED_FIELDS.has(field);
      const select = columnSelect(
        `import-map-${field}`,
        required ? columns : withEmpty,
        state.mapping[field],
        value => {
          state.mapping[field] = value === '' ? null : Number(value);
          // 列映射变了，之前那次 mapRows 的结果作废：下次进预览步必须重算。
          state.mapped = null;
          // 「这批金额全部算作支出/收入」也跟着作废：方向列一旦改了，用户上一次的那句
          // 回答就不该被悄悄沿用到新配置上（预选本身就违反「不预选」）。
          state.defaultKind = null;
          nextBtn.disabled = !FIELDS.every(f => !REQUIRED_FIELDS.has(f) || state.mapping[f] != null);
        }
      );
      return el('div', { class: 'field' }, [
        el('label', { text: required ? `${FIELD_LABELS[field]}（必选）` : `${FIELD_LABELS[field]}（可以不选）` }),
        select
      ]);
    });

    let saveBtn;
    const nameInput = el('input', {
      type: 'text', placeholder: '例如：招行 2026', dataset: { role: 'import-profile-name' },
      value: state.profileName,
      oninput: e => {
        state.profileName = e.target.value;
        saveBtn.disabled = !state.profileName.trim();
      }
    });
    saveBtn = el('button', {
      class: 'btn', type: 'button', text: '保存为格式配置',
      dataset: { role: 'import-profile-save' },
      disabled: !state.profileName.trim(),
      onclick: () => { saveCurrentProfile(); }
    });

    const profileSelect = state.profiles && state.profiles.length
      ? columnSelect(
        'import-profile-select',
        [{ value: '', text: '（选择已保存的配置）' }, ...state.profiles.map(p => ({ value: p.id, text: p.name }))],
        state.profileId,
        id => { applyProfile(id); }
      )
      : null;

    return el('section', { class: 'card stack' }, [
      state.preset
        ? el('div', {
          class: 'vault-hint', dataset: { role: 'import-preset' },
          text: `已识别为：${state.preset.label}`
        })
        : null,
      el('div', { class: 'vault-hint', text: '下面是自动认出来的列对应关系，可以直接改。' }),
      ...fields,
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '返回上一步', dataset: { role: 'import-back' },
          onclick: () => {
            state.step = state.preset ? 1 : 2;
            state.stepError = '';
            if (state.step === 1) resetParsed();
            render();
          }
        }),
        nextBtn
      ]),
      el('div', { class: 'group-title', text: '格式配置' }),
      el('div', {
        class: 'vault-hint',
        text: '把这一套列对应关系存下来（例如「招行 2026」），下次同格式的账单选中它就能一键套用。'
      }),
      el('div', { class: 'field' }, [el('label', { text: '配置名称' }), nameInput]),
      saveBtn,
      profileSelect ? el('div', { class: 'field' }, [el('label', { text: '已保存的配置' }), profileSelect]) : null,
      state.stepError ? errorLine() : null
    ]);
  }

  async function saveCurrentProfile() {
    const name = state.profileName.trim();
    if (!name) return;
    state.stepError = '';
    try {
      await saveProfile({ name, mapping: { ...state.mapping } });
    } catch (err) {
      state.stepError = '保存格式配置失败：' + (err?.message || err);
      console.error('保存格式配置失败', err);
      render();
      return;
    }
    // 读回一次而不是复用 saveProfile 的返回值：让这条路径与「重新打开面板」读到的
    // 结果完全一致（同一个 settings 键、同一份 listProfiles 排序）。
    state.profiles = null;
    await ensureProfiles();
    state.profileName = '';
    render();
  }

  function applyProfile(id) {
    state.profileId = id;
    const profile = (state.profiles ?? []).find(p => p.id === id);
    if (!profile) return;
    state.mapping = { ...blankMapping(), ...profile.mapping };
    state.mapped = null;
    render();
  }

  // ── 第 4 步 · 预览与确认 ─────────────────────────────────────────────────

  async function gotoPreview() {
    state.step = 4;
    state.stepError = '';
    state.loading = true;
    render();
    await ensureOptions();
    // mapRows 只在「配置刚变过」时跑：state.mapped 非空说明这一套表头 + 列映射已经解析过了。
    if (!state.mapped) {
      state.mapped = mapRows(state.rows, state.headerIndex, state.mapping, { defaultKind: state.defaultKind });
    }
    await refreshPrepared();
    state.loading = false;
    render();
  }

  // 用户在预览页回答了「这批金额全部算作支出还是收入」。kind 既决定落库时用哪个默认分类，
  // 也参与去重指纹，所以整份文件必须重跑一遍 mapRows。
  async function reselectDefaultKind(value) {
    state.defaultKind = value || null;
    if (state.rows) {
      state.mapped = mapRows(state.rows, state.headerIndex, state.mapping, { defaultKind: state.defaultKind });
    }
    await refreshPrepared();
    render();
  }

  // 只重跑 prepareImport，不重跑 mapRows。分类/账户每次都要重新问库：用户可能在别处
  // 刚记过一笔，而 prepareImport 的「疑似重复」是拿库里的现有指纹比出来的。
  async function refreshPrepared() {
    if (!state.mapped) return;
    try {
      state.prepared = await prepareImport(state.mapped.records, {
        defaultCategoryId: state.defaultCategoryId,
        defaultIncomeCategoryId: state.defaultIncomeCategoryId,
        defaultAccountId: state.defaultAccountId
      });
    } catch (err) {
      state.prepared = null;
      state.stepError = '统计待导入记录失败：' + (err?.message || err);
      console.error('统计待导入记录失败', err);
    }
  }

  function stepLoading() {
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', dataset: { role: 'import-loading' }, text: '正在统计待导入的记录…' })
    ]);
  }

  function stepPreview() {
    const fresh = state.prepared?.fresh ?? [];
    const duplicates = state.prepared?.duplicates ?? [];
    const errors = state.mapped?.errors ?? [];
    const skipped = state.mapped?.skipped ?? [];
    // 「未指定收支方向」不是文件读不懂，而是这一步的选择题还没做：把它从红字明细里分出去，
    // 否则用户在没选方向时会看到满屏「无法解析」，以为文件坏了。
    const parseErrors = errors.filter(e => e.reason !== UNRESOLVED_DIRECTION_REASON);
    const needsDirection = state.mapping.direction == null;
    const directionUnresolved = needsDirection && state.defaultKind == null;
    // 这四个数字是这一页的主角：导入是**一次性**的写操作，用户在点确认之前必须知道
    // 有多少条会进来、有多少条被当成重复丢掉、有多少条根本读不懂，以及有多少条是
    // 「不计收支」被跳过的——第四个数字少了，那 50 条就凭空消失，界面一个字都不交代。
    const summary = `将导入 ${fresh.length} 条；跳过 ${duplicates.length} 条疑似重复；`
      + `${parseErrors.length} 条无法解析；${skipped.length} 条不计收支，已跳过`;

    const confirmBtn = el('button', {
      class: 'btn btn-primary', type: 'button',
      text: `确认导入 ${fresh.length} 条`,
      dataset: { role: 'import-confirm' },
      // 一条都没有可导入时按钮不可点：这时候点下去只会写进 0 条并弹一个「已导入 0 条」的浮层。
      // 方向没选定时同样不可点——那时 fresh 必然是 0（每一行都记成「未指定收支方向」），
      // 这里是显式的第二道闸：漏配方向列会让整批金额变成收入，绝不能不选就放行。
      disabled: fresh.length === 0 || directionUnresolved,
      onclick: () => { confirmImport(confirmBtn); }
    });

    const shown = fresh.slice(0, RECORD_PREVIEW);

    return el('section', { class: 'card stack' }, [
      el('div', { class: 'import-summary', dataset: { role: 'import-summary' }, text: summary }),
      // 方向列没被映射时，这一页必须先问清楚「这批金额算支出还是收入」，而且**不预选**：
      // 微信/支付宝的金额列永远是正数，猜错一次就是整批 100% 变收入。
      needsDirection
        ? el('div', { class: 'field' }, [
          el('label', { text: '这批金额全部算作（必选）' }),
          columnSelect(
            'import-default-kind',
            [
              { value: '', text: '（请选择）' },
              { value: 'expense', text: '支出' },
              { value: 'income', text: '收入' }
            ],
            state.defaultKind,
            value => { reselectDefaultKind(value); }
          ),
          el('div', {
            class: 'vault-warn', dataset: { role: 'import-direction-hint' },
            text: '这份账单没有选「收/支」列，金额又都是正数——不选就没法知道每一笔是收还是支。'
          })
        ])
        : null,
      el('div', { class: 'group-title', text: '这些记录统一算作' }),
      el('div', {
        class: 'vault-hint', dataset: { role: 'import-category-note' },
        // 这句必须诚实：统计页只有月份/口径切换与分类高亮，没有任何编辑入口，分类管理也
        // 改不到某一笔交易，store.updateTransaction 至今零调用点。承诺「导入后去统计页改」
        // 会把人引到一个改不了的地方。
        text: '导入的记录统一用下面这个分类和账户。当前版本不支持事后修改单条记录，选错只能撤销重导。'
      }),
      el('div', { class: 'field' }, [
        el('label', { text: '默认支出分类' }),
        columnSelect(
          'import-default-category',
          (state.expenseCategories ?? []).map(c => ({ value: c.id, text: `${c.icon ? c.icon + ' ' : ''}${c.name}` })),
          state.defaultCategoryId,
          value => { state.defaultCategoryId = value || null; reprepare(); }
        )
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '默认收入分类' }),
        columnSelect(
          'import-default-income-category',
          (state.incomeCategories ?? []).map(c => ({ value: c.id, text: `${c.icon ? c.icon + ' ' : ''}${c.name}` })),
          state.defaultIncomeCategoryId,
          value => { state.defaultIncomeCategoryId = value || null; reprepare(); }
        )
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '默认账户' }),
        columnSelect(
          'import-default-account',
          (state.accounts ?? []).map(a => ({ value: a.id, text: a.name })),
          state.defaultAccountId,
          value => { state.defaultAccountId = value || null; reprepare(); }
        )
      ]),
      duplicates.length
        ? el('div', {
          class: 'vault-hint', dataset: { role: 'import-dup-note' },
          text: '疑似重复是指时间、金额、收支方向、商户都一样的记录——同一笔钱重复导入两次、'
            + '或者在微信和支付宝各导出一次，都会命中。宁可少导也不重复导。'
        })
        : null,
      skipped.length
        ? el('div', {
          class: 'vault-hint', dataset: { role: 'import-skipped-note' },
          text: `${skipped.length} 条「不计收支」已跳过：零钱提现、信用卡还款、理财申购这类记录`
            + '不参与收支统计，导入进来只会把支出总额搅乱。'
        })
        : null,
      parseErrors.length ? errorList(parseErrors) : null,
      el('div', {
        class: 'group-title',
        text: showCountLine(shown.length, fresh.length)
      }),
      previewTable(shown),
      state.stepError ? errorLine() : null,
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '返回上一步', dataset: { role: 'import-back' },
          onclick: () => { state.step = 3; state.stepError = ''; render(); }
        }),
        confirmBtn
      ])
    ]);
  }

  const showCountLine = (shown, total) =>
    (total > shown ? `待导入记录（共 ${total} 条，这里只显示前 ${shown} 条）` : `待导入记录（共 ${total} 条）`);

  function previewTable(shown) {
    const header = el('tr', {}, ['时间', '金额', '方向', '备注'].map(h => el('th', { text: h })));
    const rows = shown.map(r => el('tr', {}, [
      el('td', { class: 'import-cell num', text: formatTime(r.occurredAt) }),
      el('td', { class: 'import-cell num', text: formatCents(r.amountCents) }),
      el('td', { class: 'import-cell', text: KIND_LABELS[r.kind] ?? r.kind }),
      el('td', { class: 'import-cell', text: r.note || '—' })
    ]));
    return el('table', { class: 'import-table', dataset: { role: 'import-preview-table' } }, [header, ...rows]);
  }

  function errorList(errors) {
    const shown = errors.slice(0, ERROR_PREVIEW);
    return el('div', { class: 'stack', dataset: { role: 'import-errors' } }, [
      el('div', { class: 'group-title', text: `${errors.length} 条无法解析` }),
      ...shown.map(e => el('div', {
        class: 'vault-error', dataset: { role: 'import-error-row' },
        // 行号用 1 基：用户手里是文本编辑器或 Excel，那里的第一行就是 1。
        text: `第 ${e.row + 1} 行 · 原始值「${e.raw || '（空）'}」· ${e.reason}`
      })),
      errors.length > shown.length
        ? el('div', { class: 'vault-hint', text: `其余 ${errors.length - shown.length} 条省略` })
        : null
    ]);
  }

  async function reprepare() {
    await refreshPrepared();
    render();
  }

  async function confirmImport(btn) {
    if (state.committing) return;
    const fresh = state.prepared?.fresh ?? [];
    if (fresh.length === 0) return;
    state.committing = true;
    state.stepError = '';
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在写入…';
    try {
      // 整个向导里唯一一次写入。走到这一行，用户已经在预览页看到三个数字并点过确认。
      const ids = await commitImport(fresh);
      state.committed = {
        ids,
        count: ids.length,
        skipped: state.prepared?.duplicates?.length ?? 0
      };
      state.step = 5;
      state.committing = false;
      render();
      showUndoToast({
        count: ids.length,
        ids,
        onUndone: () => {
          state.reverted = true;
          render();
          notify();
        }
      });
      notify();
    } catch (err) {
      state.committing = false;
      btn.disabled = false;
      btn.textContent = original;
      state.stepError = '导入失败：' + (err?.message || err);
      console.error('导入失败', err);
      render();
    }
  }

  // ── 第 5 步 · 完成 / 撤销 ────────────────────────────────────────────────

  function stepDone() {
    const c = state.committed ?? { count: 0, skipped: 0 };
    const text = state.reverted
      ? `已撤销本次导入的 ${c.count} 条`
      : `已导入 ${c.count} 条，跳过 ${c.skipped} 条重复`;
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', dataset: { role: 'import-done' }, text }),
      state.reverted
        ? null
        : el('div', {
          class: 'vault-warn', dataset: { role: 'import-undo-hint' },
          text: `5 分钟内可以点屏幕下方的浮层撤销这次导入。`
        }),
      el('div', { class: 'vault-hint', text: '统计页的月度数字已经把这批记录算进去了。' }),
      el('div', { class: 'form-actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: '关闭', dataset: { role: 'import-close' },
          onclick: () => { sheet.close(); }
        })
      ])
    ]);
  }

  render();
  return sheet;
}
