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
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import * as store from '../store.js';
import {
  exportBackup, parseBackupFile, decryptBackupFile, importBackup,
  getLastBackupAt, markBackedUp
} from '../backup-store.js';

// 备份密码下限。与主密码一致取 8 位：同一个派生的密码学约束，没必要给两条路径两套规矩。
const MIN_PASSWORD = 8;
const MS_PER_DAY = 86400000;

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

  async function doExport() {
    if (exporting || exportBtn.disabled) return;
    exporting = true;
    placeError('');
    const original = exportBtn.textContent;
    exportBtn.textContent = '正在导出…';
    refreshExport();
    try {
      // 导出耗时不短（PBKDF2 600000 轮 + 整包加密），期间按钮锁死，避免双击导出两份。
      const { filename, text } = await exportBackup(pw);
      download(filename, text);
      await markBackedUp();
      // 「文件真的落盘了吗」网页里无从得知：浏览器拦截下载、用户在另存为里点了取消、
      // 系统存储权限有问题，这些都不会抛错。所以我们照旧记下这次导出（用户确实点过导出，
      // 该事实要落盘），但必须紧跟一句「请自己去确认文件在不在」——否则面板上写着
      // 「上次备份：今天」，用户以为有备份，真到要恢复那天才发现什么都没有。
      mount(exportNoteArea, [
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

  // 触发浏览器下载。步骤照实现计划写死：createObjectURL → 隐藏 <a download> → click → remove。
  // 为什么必须 append 到 document 再点：Firefox 里游离（不在文档中）的 <a> 点击不会触发下载。
  // revokeObjectURL 延后 1 秒：立刻撤销会让部分浏览器在下载真正开始前就拿到一个失效 URL。
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
          el('span', { class: 'muted tiny', text: '密码箱' }),
          el('span', { text: summary.hasVault ? '包含' : '不包含（保留本机现有密码箱）' })
        ])
      ]),
      el('div', { class: 'vault-warn', text: '导入会替换手机上现有的全部数据。' }),
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
  refreshExport();

  // 打开备份面板本身不算「有改动」，但导入成功后调用了 onChanged 会让首页重渲染，
  // 这与 settings-sheet 里「关掉子面板也通知一次」的既有行为一致（多刷一次无害）。
  return sheet;
}
