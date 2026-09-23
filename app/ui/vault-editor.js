// 密码箱条目编辑器（新增 / 编辑）。**任务 9 才填真实实现，这里先是骨架。**
//
// 为什么骨架要提前建：列表的「＋ 新建」与详情页的「编辑」都要接上这个调用口。
// 接口一旦定成 { item, onSaved }（item 为 null 表示新建，onSaved 在保存成功后回调），
// 任务 9 换掉函数体时，两处调用方一行都不用改。
export function openVaultEditor({ item, onSaved }) {
  console.log('vault editor not implemented yet', item, onSaved);
}
