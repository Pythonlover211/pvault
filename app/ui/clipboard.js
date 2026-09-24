// 复制到剪贴板，并在若干秒后自动清空（任务 8）。
//
// 为什么要自动清空：剪贴板是密码箱之外唯一一个「留在系统里、任何 App 都读得到」的位置，
// 而密码恰恰是最不该长时间躺在那里的一种内容。30 秒足够完成一次粘贴，又不至于让密码挂一整天。
//
// 清空前必须先读一次：30 秒里用户完全可能复制了别的东西（拿去搜索、发给别人）。
// 只有内容仍是自己刚写进去的那串时才清，否则会把用户后来的内容一起抹掉——那是比不清空更糟的结果。
//
// —— 为什么写剪贴板要分三条路 ——
// 只用 navigator.clipboard 是不够的：安卓 WebView 没有浏览器那套剪贴板权限模型，
// writeText 会直接 reject，真机上表现为按钮显示「复制失败」（恢复码页尤其致命——
// 那串码只显示一次，复制不出来就只能手抄）。所以按可靠性从高到低依次尝试：
//   ① 安卓壳里的 Java 桥：直接调系统 ClipboardManager，最可靠
//   ② 浏览器里的 navigator.clipboard.writeText：需要安全上下文 + 用户手势
//   ③ document.execCommand('copy')：早已废弃，但在旧 WebView 里反而是唯一能用的那条

function shell() {
  const s = globalThis.PvaultShell;
  return s && typeof s.copyText === 'function' ? s : null;
}

function viaShell(text) {
  const s = shell();
  if (!s) return false;
  try {
    return s.copyText(text) === true;
  } catch {
    return false;
  }
}

function viaExecCommand(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // readonly 防止移动端弹起软键盘；移出视口而不是 display:none，
    // 因为后者会让 select() 选不中内容。
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok === true;
  } catch {
    return false;
  }
}

/** 写入剪贴板。成功返回 true，三条路都失败返回 false。 */
export async function writeClipboard(text) {
  if (viaShell(text)) return true;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或 WebView 不支持，继续往下退
    }
  }
  return viaExecCommand(text);
}

/** 读剪贴板用于「清空前先确认是不是自己写的」。读不到返回 null（一律不清）。 */
async function readClipboard() {
  const s = shell();
  if (s && typeof s.readClipboardText === 'function') {
    try {
      const v = s.readClipboardText();
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
  return null;
}

export async function copyWithAutoClear(text, seconds = 30) {
  const ok = await writeClipboard(text);
  if (!ok) return false;
  setTimeout(async () => {
    try {
      const now = await readClipboard();
      // 读不到时 now 为 null，不等于 text，所以不动它——与原来的保守策略一致。
      if (now === text) await writeClipboard('');
    } catch {
      // 读不到剪贴板（权限/不支持）时不动它，免得清掉用户后来复制的东西
    }
  }, seconds * 1000);
  return true;
}
