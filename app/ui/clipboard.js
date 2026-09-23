// 复制到剪贴板，并在若干秒后自动清空（任务 8）。
//
// 为什么要自动清空：剪贴板是密码箱之外唯一一个「留在系统里、任何 App 都读得到」的位置，
// 而密码恰恰是最不该长时间躺在那里的一种内容。30 秒足够完成一次粘贴，又不至于让密码挂一整天。
//
// 清空前必须先读一次：30 秒里用户完全可能复制了别的东西（拿去搜索、发给别人）。
// 只有内容仍是自己刚写进去的那串时才清，否则会把用户后来的内容一起抹掉——那是比不清空更糟的结果。
export async function copyWithAutoClear(text, seconds = 30) {
  await navigator.clipboard.writeText(text);
  setTimeout(async () => {
    try {
      const now = await navigator.clipboard.readText();
      if (now === text) await navigator.clipboard.writeText('');
    } catch {
      // 读不到剪贴板（权限/不支持）时不动它，免得清掉用户后来复制的东西
    }
  }, seconds * 1000);
}
