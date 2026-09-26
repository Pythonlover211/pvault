// 触发一次浏览器下载：把 Blob 存成 filename 命名的文件。
//
// 两条是踩过的坑，搬过来的时候一句都不能改：
// 1. 必须 append 到 document 再 click：Firefox 里游离（不在文档中）的 <a> 点击不触发下载。
// 2. revokeObjectURL 延后 1 秒：立刻撤销会让部分浏览器在下载真正开始前就拿到一个失效 URL。
//
// 这一整段必须同步跑完，中间不要插 await。但**click 本身并不要求用户手势**——
// 备份导出就是先 await 完 exportBackup() 再点这里的，安卓真机验过、能落文件。
// （`<input type="file">` 的 click 才受手势限制，那是另一回事，别把它的约束搬过来。）
// 真在某个浏览器上撞到「点了没反应」，先怀疑这一条，别先去重构调用方。
//
// 约定：filename 由调用方给全——非空、已经过 app/file-info.js 的 sanitizeFilename、
// 带好扩展名。本函数不净化、也不补扩展名：扩展名只认 filename，不看 blob.type
// （createObjectURL 不会把 MIME 变成文件后缀）。
/** 把 blob 存成 filename 命名的文件。同步触发，不报告成败（下载被拦截不会抛错）。 */
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
