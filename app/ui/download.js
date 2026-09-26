// 触发一次浏览器下载。从 backup-view.js 里抽出来共用：
// 导出备份与导出发票原件（PDF / OFD / 图片）走的是同一条路。
//
// 三条都是踩过的坑，搬过来的时候一句都不能改：
// 1. 必须 append 到 document 再 click：Firefox 里游离（不在文档中）的 <a> 点击不触发下载。
// 2. revokeObjectURL 延后 1 秒：立刻撤销会让部分浏览器在下载真正开始前就拿到一个失效 URL。
// 3. click() 必须在用户手势的调用栈里发起：await 之后再点会被浏览器当成非用户操作吞掉。
//    调用方如果是在 async 函数里导出，要先 await 取数据、再同步调这里，别把 click 放在 await 后面。
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
