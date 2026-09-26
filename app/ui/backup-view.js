// 备份与恢复界面（任务 10）：把整台设备的数据导出成一个加密文件，以及从该文件恢复。
//
// 为什么这个界面比别的面板啰嗦：备份是**唯一**会把「全部数据」一次性覆盖掉的操作，
// 而它的两个错误方向代价完全不同——导出失败只是白忙一趟，导入出错是用户几十上百笔账
// 连同密码箱一起没了。所以这里的纪律都偏保守：
//
// 1. **两层密码，互不相通**：备份密码只用于打开这个文件，与主密码无关（可以不同、也可以
//    相同）。这句话必须写在界面上——否则用户会以为「主密码能解开备份文件」，
//    等到换手机那天才发现打不开。
// 2. **确认之前绝不写库**：导入分两步走完——先 parse + decrypt（纯读，不碰任何数据），
//    把摘要摆给用户看；用户点了「确认覆盖并恢复」才调 importBackup()。
//    界面里 importBackup 只出现在那一个点击处理里，这是可以被探针直接断言的结构。
// 3. **任何一步失败都在面板里说人话**：BackupFileError 的 code 映射成固定中文，
//    密码错、文件选错、文件损坏三种情况的处置方式完全不同，不能都糊成「导入失败」。
// 4. 不引依赖、不碰 crypto.subtle：加解密全在 backup-store 里，本文件只管界面与流程。
// 5. **导出前把体积说清楚，并给一条退路**：图片要转成 base64 才进得了 JSON，体积比原图还大
//    三分之一，几百张图就是几十上百 MB，而手机上的下载被拦截是**不报错**的。所以这里既报数字，
//    也给出「不含图片」的选项：账目先安全落地，比追一份完整但下不来的文件重要得多。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { downloadBlob } from './download.js';
import * as store from '../store.js';
import {
  exportBackup, parseBackupFile, decryptBackupFile, importBackup,
  getLastBackupAt, markBackedUp, estimateExportSize
} from '../backup-store.js';

// 备份密码下限。与主密码一致取 8 位：同一个派生的密码学约束，没必要给两条路径两套规矩。
const MIN_PASSWORD = 8;
const MS_PER_DAY = 86400000;

// 超过这个体积就在导出前把话说死。20 MB 是手机上一次下载开始被浏览器或系统拦掉、
// 或者用户自己在「另存为」里点取消的量级——而含图备份很容易到这一步（图片要转 base64，
// 比原图还大三分之一，几百张图就是几十上百 MB）。拦下载是**不报错**的，所以只能提前提醒。
const BIG_EXPORT_MB = 20;

// 超过这个天数没备份就把提醒染成警示色。默认 14 天：一次备份的「保鲜期」大约两周——
// 更久不备份，一旦清掉浏览器数据，丢的就是半个月的账。
// 放在这里（而不是首页）是为了让首页那行小字与备份面板里那行状态**共用同一个判据**：
// 同一个时间点在两处显示成两种颜色，用户会开始怀疑到底哪个是真的。
export const DEFAULT_BACKUP_REMINDER_DAYS = 14;

// 时间戳 → 「今天 / N 天前」，以及是否需要打警示色。
// 天数用 floor（不满一天不算一天）：昨天傍晚备份的、今天早上打开时显示「今天」会让人
// 以为刚备份过，而实际上已经过了一夜。future 是时钟回拨或跨设备导入带来的，夹到 0。
// 导出给 ledger-home 复用——首页那行小字与这里的显示必须完全一致，否则同一个时间点
// 在两个地方显示成不同的天数，用户会开始怀疑到底哪个是真的。
export function backupAge(ts, now = Date.now()) {
  if (!ts) return { days: null, text: '从未备份', warn: true };
  const days = Math.max(0, Math.floor((Number(now) - Number(ts)) / MS_PER_DAY));
  return { days, text: days === 0 ? '今天' : `${days} 天前`, warn: false };
}

// 「该不该警示」的唯一判据：从未备份永远警示（这是最需要行动的状态，不该等满 14 天），
// 否则看天数有没有够到 backupReminderDays。首页与备份面板都调它。
export function isBackupOverdue(age, reminderDays) {
  const limit = Number(reminderDays ?? DEFAULT_BACKUP_REMINDER_DAYS);
  if (age.days === null) return true;
  // 天数读不出来（NaN）时按默认天数判：宁可提醒得保守一点，也不能永远不提醒。
  return age.days >= (Number.isFinite(limit) ? limit : DEFAULT_BACKUP_REMINDER_DAYS);
}

function formatStamp(ts) {
  if (!ts) return '未知';
  const d = new Date(Number(ts));
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// BackupFileError.code → 人话。错误文案是**处置指南**：密码错就重输，选错文件就换一个。
// 其它类型（含 IndexedDB 写入失败）兜到 message，实在没有就用兜底那句。
export function friendlyError(err) {
  switch (err?.code) {
    case 'BAD_FILE': return '这不是 pvault 的备份文件';
    case 'BAD_PASSWORD_OR_CORRUPT': return '备份密码不正确，或文件已损坏';
    case 'BAD_CONTENT': return '备份文件内容不完整';
    default: return err?.message ? String(err.message) : '操作失败，请重试';
  }
}

export function openBackupSheet({ onChanged } = {}) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '备份与恢复', body });

  // 任何一步失败都落在面板顶部这一行上——不用 alert（同步阻塞、样式不可控、PWA 里会打断整页）。
  const errorNode = el('div', { class: 'vault-error', dataset: { role: 'backup-error' } });
  const placeError = text => { errorNode.textContent = text || ''; };

  // —— 导出 ——

  let pw = '';
  let pw2 = '';
  let exporting = false;

  const statusNode = el('div', { class: 'vault-hint', dataset: { role: 'backup-status' } });
  const exportBtn = el('button', {
    class: 'btn btn-primary', type: 'button', text: '导出备份', disabled: true,
    onclick: () => { doExport(); }
  });

  // 「不含图片」选项：默认不勾，也就是默认含图片导出。
  // 为什么要给这个选项：图片必须转成 base64 才进得了 JSON（见 backup-store 的 encodeFiles），
  // 体积比原图还大三分之一，几百张图就是几十上百 MB——而手机上的下载**会**被浏览器或系统
  // 静默拦掉，界面上看不出来。那种情况下用户至少还能先导一份不含图片的，把账目保住。
  const noFilesCheck = el('input', { type: 'checkbox' });
  const noFilesLabel = el('label', { class: 'vault-check', dataset: { role: 'export-no-files' } }, [
    noFilesCheck,
    el('span', { text: '这次导出不含图片（文件小很多）' })
  ]);
  // 体积提示那一行。文案与颜色都由 refreshSize() 决定：算得出具体数字才说得清「多大」，
  // 说「可能比较大」等于没说。
  const sizeHint = el('div', { class: 'vault-hint', dataset: { role: 'export-size-hint' } });

  // 只切按钮禁用态，不整页重渲染：重建 input 会让正在输入的那个框丢焦点。
  // 两个条件都必要——「至少 8 位」是密码强度，「两次一致」是防手误打错（打错的备份密码
  // 意味着文件永远打不开，而此刻没有任何办法验证它）。
  function refreshExport() {
    exportBtn.disabled = exporting || !(pw.length >= MIN_PASSWORD && pw === pw2);
  }

  async function refreshStatus() {
    // 提醒天数与首页读的是同一个设置项；读失败（老库没有这一行、存储报错）就落到默认 14，
    // 不能因为没有设置项就把警示色关掉。
    const [ts, reminderDays] = await Promise.all([
      getLastBackupAt(),
      store.getSetting('backupReminderDays', DEFAULT_BACKUP_REMINDER_DAYS)
        .catch(() => DEFAULT_BACKUP_REMINDER_DAYS)
    ]);
    const age = backupAge(ts);
    statusNode.textContent = `上次备份：${age.text}`;
    // 与首页同一判据：超期也要变色。之前这里只认「从未备份」，于是同一个时间点
    // 首页是黄的、面板里是灰的，用户会以为是两个不同的东西。
    statusNode.className = isBackupOverdue(age, reminderDays) ? 'vault-warn' : 'vault-hint';
    return age;
  }

  // 导出前的体积提示 + 决定要不要给出「不含图片」这个选项。
  // 读不出图片数不该拦住导出：那只是「体积说不准」，功能本身照旧。
  async function refreshSize() {
    try {
      const { count, mb } = await estimateExportSize();
      if (count === 0) {
        // 一张图都没有就别放这个复选框：一个勾了也没区别的开关只会让人多点一下。
        noFilesLabel.style.display = 'none';
        sizeHint.className = 'vault-hint';
        sizeHint.textContent = '本机还没有发票图片，导出的备份文件很小。';
        return;
      }
      noFilesLabel.style.display = '';
      if (mb >= BIG_EXPORT_MB) {
        sizeHint.className = 'vault-warn';
        sizeHint.textContent = `本机有 ${count} 张发票图片，含图片导出预计约 ${mb} MB：文件很大，`
          + '浏览器或系统可能直接拦掉下载（这里不会有任何提示）。建议先用「不含图片」导一份保住账目，'
          + '图片另找时间单独导一份。';
      } else {
        sizeHint.className = 'vault-hint';
        sizeHint.textContent = `本机有 ${count} 张发票图片，含图片导出预计约 ${mb} MB`
          + '（图片转成文字编码后比原图大约三分之一）。';
      }
    } catch (err) {
      sizeHint.className = 'vault-hint';
      sizeHint.textContent = '（暂时读不出发票图片的数量，导出仍可继续。）';
      console.error('读取发票图片数量失败', err);
    }
  }

  async function doExport() {
    if (exporting || exportBtn.disabled) return;
    exporting = true;
    placeError('');
    const original = exportBtn.textContent;
    exportBtn.textContent = '正在导出…';
    refreshExport();
    try {
      // 导出耗时不短（PBKDF2 600000 轮 + 整包加密 + 含图时逐张转 base64），期间按钮锁死，避免双击导出两份。
      // includeFiles 默认 true（未勾选就是含图）：图片是这台设备上唯一的一份，
      // 只有用户明确选了「不含图片」才省掉它。
      const includeFiles = !noFilesCheck.checked;
      const { filename, text, skipped } = await exportBackup(pw, Date.now(), { includeFiles });
      download(filename, text);
      await markBackedUp();
      // 「文件真的落盘了吗」网页里无从得知：浏览器拦截下载、用户在另存为里点了取消、
      // 系统存储权限有问题，这些都不会抛错。所以我们照旧记下这次导出（用户确实点过导出，
      // 该事实要落盘），但必须紧跟一句「请自己去确认文件在不在」——否则面板上写着
      // 「上次备份：今天」，用户以为有备份，真到要恢复那天才发现什么都没有。
      mount(exportNoteArea, [
        // 这一条最要紧：不含图片是有代价的，而且代价要到换手机那天才看得见，必须在导出的当下说。
        includeFiles ? null : el('div', {
          class: 'vault-warn', dataset: { role: 'export-no-files-note' },
          text: '这一份不含图片：换手机或重装后恢复，发票只剩条目，拍照存下的原图看不到。'
        }),
        // skipped 是「没能写进备份的图片数」（图片数据本身坏了、或记录里没有内容）。
        // 不说出来的话，这份备份看起来一切正常，直到需要恢复时才发现少了几张。
        skipped > 0 ? el('div', {
          class: 'vault-warn', dataset: { role: 'export-skipped' },
          text: `有 ${skipped} 张发票图片没能写进这份备份（图片数据本身有问题）。账目都在，但这几张图恢复后看不到。`
        }) : null,
        el('div', {
          class: 'vault-warn', dataset: { role: 'export-note' },
          text: '导出后请到「下载」目录确认文件真的在——浏览器或系统拦截下载时这里不会有任何提示。'
        }),
        // 面板底部的说明只讲了「打开文件看不到明文」，那句话容易读成「所以我很安全」，
        // 于是有人把密码写在文件名里、或和文件存在同一个文件夹里。把它补全：文件安全，
        // **配对**存放不安全——备份密码是这台设备之外唯一的入口，它也怕被一起拿走。
        el('div', {
          class: 'vault-warn', dataset: { role: 'export-pw-note' },
          text: '这个文件本身是安全的（打开只有密文），但请把密码记在别处——密码和文件放在一起，等于没加密。'
        })
      ]);
      await refreshStatus();
      // 密码用完就清空：这两个输入框没有任何留在内存里的理由。
      pw = '';
      pw2 = '';
      pwInput.value = '';
      pw2Input.value = '';
      exportBtn.textContent = '已导出';
      setTimeout(() => { exportBtn.textContent = original; }, 1500);
    } catch (err) {
      exportBtn.textContent = original;
      // 导出失败的原文（例如 IndexedDB 配额满）对用户没有指导意义，但也比「失败」两个字强，
      // 所以保留原 message；只有备份密码那样「其实不该发生」的路径才不会走到这里。
      placeError('导出失败：' + (err?.message || err));
      console.error('备份导出失败', err);
    } finally {
      exporting = false;
      refreshExport();
    }
  }

  // blob 与 mime 是业务决定（备份文件是 JSON），留在这里；下载动作本身走 app/ui/download.js。
  function download(filename, text) {
    downloadBlob(new Blob([text], { type: 'application/json' }), filename);
  }

  const pwInput = el('input', {
    type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位',
    oninput: e => { pw = e.target.value; refreshExport(); }
  });
  const pw2Input = el('input', {
    type: 'password', autocomplete: 'new-password', placeholder: '两次要一致',
    oninput: e => { pw2 = e.target.value; refreshExport(); }
  });

  // 导出成功后在这里落一句「去确认文件真的在」。刻意做成空容器而不是一个预先存在的提示框：
  // .vault-warn 自带底色与内边距，空着也会在界面上留一个黄块。
  const exportNoteArea = el('div', { class: 'stack', dataset: { role: 'export-note-area' } });

  const exportSection = el('section', { class: 'card stack' }, [
    el('div', { class: 'vault-hint', text: '这个密码只用于打开备份文件，可以和主密码不同。' }),
    el('div', { class: 'field' }, [el('label', { text: '备份密码（至少 8 位）' }), pwInput]),
    // 「忘了它，备份文件同样打不开」原本混在上面那句说明里、同样是小字灰色——而它描述的
    // 是一件**不可逆**的事：备份文件是这台设备之外唯一的数据副本，密码忘了就是永久打不开。
    // 所以把它从说明段里提出来，独立成块放在**第一个密码输入框正下方**：手指正在打字的位置，
    // 视线必然经过，且用警示色（.vault-warn）而不是普通说明色。
    el('div', {
      class: 'vault-warn', dataset: { role: 'backup-pw-warn' },
      text: '忘了这个密码，备份文件同样打不开——没有任何找回方式。请现在就把它记在别处。'
    }),
    el('div', { class: 'field' }, [el('label', { text: '再输一次' }), pw2Input]),
    // 体积提示放在按钮上方、复选框之前：先让用户看到「这份会多大」，再给出「小很多」的那条路。
    sizeHint,
    noFilesLabel,
    exportBtn,
    exportNoteArea
  ]);

  // —— 导入 ——

  let importing = false;
  let picked = null;      // { text }
  let importPw = '';

  const importArea = el('div', { class: 'stack' });
  const fileInput = el('input', {
    // 隐藏但仍在 DOM 里：display:none 的 input 依然能被 .click() 唤起文件选择器
    // （只要这次点击是从用户手势里发起的，见导入按钮的 onclick）。
    class: 'vault-file-input', type: 'file', accept: '.pvault,.json,application/json',
    onchange: e => {
      const file = e.target?.files?.[0];
      // 取消选择时 files 为空：保持原视图不动，不能把已经解出来的摘要清掉。
      if (file) pickFile(file);
    }
  });

  const importBtn = el('button', {
    class: 'btn', type: 'button', text: '选择备份文件',
    onclick: () => { fileInput.click(); }
  });

  // 把「已解密的摘要」交给确认页。注意这一路全是读操作：
  // parseBackupFile / decryptBackupFile 都不写库，所以走到这里为止用户的数据毫发无损。
  async function pickFile(file) {
    placeError('');
    let text;
    try {
      text = await file.text();
    } catch (err) {
      paintImport([el('div', { class: 'vault-error', text: '读取文件失败：' + (err?.message || err) })]);
      return;
    }
    picked = { text };
    paintImport([passwordForm()]);
  }

  function passwordForm() {
    const input = el('input', {
      type: 'password', autocomplete: 'current-password', placeholder: '这个备份文件的密码',
      value: importPw,
      oninput: e => { importPw = e.target.value; }
    });
    const btn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '打开备份文件',
      onclick: () => { decrypt(btn, input.value); }
    });
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'vault-hint', text: '输入这个备份文件当初导出时设置的密码。它和你现在的主密码可能不一样。' }),
      el('div', { class: 'field' }, [el('label', { text: '备份密码' }), input]),
      btn
    ]);
  }

  async function decrypt(btn, password) {
    if (importing) return;
    importing = true;
    placeError('');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在解密…';
    try {
      const parsed = parseBackupFile(picked.text);
      const { summary } = await decryptBackupFile(parsed, password);
      importPw = password;
      paintImport([summaryView(summary)]);
    } catch (err) {      btn.disabled = false;
      btn.textContent = original;
      placeError(friendlyError(err));
      // 只打 code 与 message：备份包里是全部账目与密码箱，err 本身不含内容。
      console.error('备份解密失败', err?.code || '', err?.message || err);
      return;
    } finally {
      importing = false;
    }
  }

  // 摘要页：只展示，不写入。确认按钮的文案必须是「确认覆盖并恢复」这个完整动作，
  // 而不是「确定」——用户点下去之前得知道自己失去了什么。
  function summaryView(summary) {
    const confirmBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '确认覆盖并恢复',
      onclick: () => { doImport(confirmBtn); }
    });
    // 发票那一行的文案。「0 张」有两种意思，处置完全相反，所以必须分开说：
    // 文件里压根没有这一项（加发票之前导出的老备份）→ 恢复时本机发票原样保留；
    // 文件里有这一项但是空的 → 本机发票会被清空。与下面密码箱那一行是同一种写法。
    const invoicesText = summary.hasInvoices
      ? String(summary.invoices)
      : '不包含（保留本机现有发票）';
    // 图片这一行的判据必须与 backup-store 的 clears 严丝合缝地一致：
    //   clears 里加 invoiceFiles 的条件是 `arrayOrEmpty(data.invoiceFiles).length > 0`，
    //   也就是「没有**可恢复的**图片就一个字都不动本机」。
    // 所以判据是 hasInvoiceFiles **且** invoiceFiles > 0，而不是只看「键在不在」：
    //   · 键不在（老备份）                        → 保留本机
    //   · 键在但是空数组（用「不含图片」导出的）  → 也保留本机
    //   · 键在且有条目                            → 清空本机后写进备份里的这些
    // 只按 hasInvoiceFiles 分辨（原来的写法）会把第二种说成「0（这份备份不带图片）」，
    // 那句话读起来是「本机那几张没了」，而真实行为是原样保留——用户在确认页上没法判断
    // 恢复之后自己的原图还在不在，两个方向都会读错。写反的代价是不可逆的：他可能因此
    // 不敢用那份备份，或者反过来以为原图还在而被清掉。
    // 反过来也绝不允许把实现改成「有键就清」去迁就文案：那是在删本机唯一一份原图（见文件头第 6 条）。
    const filesText = summary.invoiceFiles > 0
      ? String(summary.invoiceFiles)
      : '不包含（保留本机现有的图片）';
    return el('section', { class: 'card stack' }, [
      el('div', { class: 'group-title', text: '备份文件内容' }),
      el('div', { class: 'stack' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '备份时间' }),
          el('span', { class: 'num', text: formatStamp(summary.createdAt) })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '交易' }),
          el('span', { class: 'num', text: String(summary.txns) })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '账户' }),
          el('span', { class: 'num', text: String(summary.accounts) })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '分类' }),
          el('span', { class: 'num', text: String(summary.categories) })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '发票' }),
          el('span', { class: summary.hasInvoices ? 'num' : '', text: invoicesText })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '发票图片' }),
          el('span', { class: summary.invoiceFiles > 0 ? 'num' : '', text: filesText })
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'muted tiny', text: '密码箱' }),
          // 「包含」判据与导入侧的取值是同一件事：data.vault 是真值就用它覆盖本机，
          // 是 null / 缺失就保留本机那一行（见 importBackup 的 vaultToWrite）。buildBackup 只可能
          // 写出「对象」或「null」两种，所以这个判据在真实备份上不会有第三种情形。
          el('span', { text: summary.hasVault ? '包含' : '不包含（保留本机现有密码箱）' })
        ])
      ]),
      // 这句话原来写的是「导入会替换手机上现有的全部数据」，而加了发票之后它不再准确：
      // 老备份里没有发票这一项，恢复它并不会动本机发票。说错方向是有代价的——用户可能因此
      // 不敢用老备份救急，或者反过来以为「不包含」的东西也会被清掉。所以按住上面那几行摘要来说。
      el('div', {
        class: 'vault-warn',
        text: '导入会替换手机上现有的账目、账户、分类与设置，这一步不能撤销。'
          + '上面写着「不包含」的那几项，本机现有的数据会保留。'
      }),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn', type: 'button', text: '取消', onclick: () => { sheet.close(); } }),
        confirmBtn
      ])
    ]);
  }

  async function doImport(btn) {
    if (importing) return;
    importing = true;
    placeError('');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在恢复…';
    try {
      // 整个流程里唯一一次写入。走到这一行，用户已经在摘要页上点过一次确认。
      await importBackup(picked.text, importPw);
      // 数据真的换了才通知外面。**这一步必须自己吞掉异常**：onChanged 是调用方注入的
      // （首页会拿它重渲染整页），它一旦抛错就会把后面的「已恢复 + 重新加载」一起带走——
      // 那时数据已经覆盖完了，用户却卡在一个显示旧摘要的面板上，并且永远不会自动刷新。
      // 通知失败只该丢一条日志，绝不能改变「数据已经换过了」这个事实的呈现。
      try {
        if (onChanged) onChanged();
      } catch (err) {
        console.error('导入成功后的界面刷新失败', err);
      }
      paintImport([el('div', { class: 'vault-hint', text: '已恢复，正在重新加载' })]);
      // 覆盖之后页面里的模块状态（store 的缓存、已经渲染的列表）全部作废，
      // 重新加载是唯一可靠的收敛方式；1 秒的延迟是留给那句提示被看见的时间。
      setTimeout(() => { location.reload(); }, 1000);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      placeError(friendlyError(err));
      console.error('备份导入失败', err?.code || '', err?.message || err);
    } finally {
      importing = false;
    }
  }

  // 只重画导入区，不整块重渲染面板：重建会让已经解出来的摘要连同输入到一半的密码一起消失。
  // **刻意不在这里通知 onChanged**：如果每次重画都通知，用户刚选完文件就会触发一次首页重渲染，
  // 而那时什么数据都还没变；通知只发生在真正写完库之后（见 doImport）。
  function paintImport(nodes) {
    mount(importArea, nodes);
  }

  const importSection = el('section', { class: 'card stack' }, [
    el('div', { class: 'group-title', text: '恢复' }),
    el('div', { class: 'vault-hint', text: '用备份文件覆盖本机数据。这一步不会上传任何内容，全部在本地完成。' }),
    fileInput,
    importBtn,
    importArea
  ]);

  mount(body, [
    el('div', { class: 'stack' }, [statusNode, errorNode]),
    exportSection,
    importSection,
    el('div', { class: 'vault-hint', text: '备份文件是整体加密的：用记事本打开只能看到密文，看不到任何账目或密码。' })
  ]);

  // 先把状态画出来（异步读 lastBackupAt），失败兜成「从未备份」——
  // 一行状态显示不出来，不该让整个面板打不开。
  refreshStatus().catch(err => {
    statusNode.textContent = '上次备份：读取失败';
    console.error('读取上次备份时间失败', err);
  });
  // 体积提示同样是异步读出来的，失败也不该让面板打不开（refreshSize 自己会兜成一句说明）。
  refreshSize();
  refreshExport();

  // 打开备份面板本身不算「有改动」，但导入成功后调用了 onChanged 会让首页重渲染，
  // 这与 settings-sheet 里「关掉子面板也通知一次」的既有行为一致（多刷一次无害）。
  return sheet;
}
