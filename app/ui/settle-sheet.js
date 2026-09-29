// 「标记到账」面板：到账金额 / 账户 / 分类 + 一个「只标记到账，不记收入」。
//
// 三个默认值来自 reimburse-model 的 settleDefaults（纯函数、已单测）——尤其是
// 「上次用的账户已经不在了」那条分支，它只在用户删/归档过账户之后才出现，靠手点是撞不上的。
//
// 四条纪律（都是这个文件里踩得着的那种）：
// 1. **busy 是一次性闸门**：面板收起有 180ms 动画，这期间按钮还在屏幕上、还能点第二下，
//    于是记出两笔收入。所以 busy 置上之后**一律不恢复**（成功路径尤其不能恢复）；
//    失败路径必须恢复，否则用户改完金额再点就没反应了。
// 2. `settledCents === null` 表示「输入框是空的」，0 是合法金额（公司拒报、一分没报回来）。
//    两者在屏幕上长得一样，所以 0 要 window.confirm 确认一次。
// 3. 错误走既有样式 `.form-error`（与 entry-panel 同一个），**不要新造**：
//    它的显示由 hidden 属性控制，不要 mount 整块 body——那会把 keypad.node 摘掉重建、
//    用户刚输的金额一起消失。
// 4. 账户下拉只在**一个账户都没有**时才不可用：那种情况下按钮仍然可用（用户多半就是想
//    「只标记到账」），此时强制 createTxn = false——不能记出一笔没有账户的收入（见下面注释）。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { createKeypad } from './keypad.js';
import { formatCents } from '../money.js';
import { settleDefaults } from '../reimburse-model.js';
import { settleReimbursement } from '../reimburse-store.js';
import { listCategories, listAccounts, getSetting } from '../store.js';

export function openSettleSheet({ reimb, invoices, onSettled }) {
  const body = el('div', { class: 'stack' });
  const sheet = openSheet({ title: '标记到账', body });

  // 一次性闸门：见文件头纪律 1。**成功后不回 false**。
  let busy = false;

  // 由 confirm() 直接更新，不重建 DOM——重建会把 keypad.node 连同它的输入状态一起丢掉。
  // 一开始就 hidden：`.form-error` 有 min-height（给文字预留高度防跳动），不藏起来会在面板上
  // 留一条空白带（对照 entry-panel.js 的 errorNode 也是建出来就 hidden）。
  const errorNode = el('div', { class: 'form-error', hidden: true });
  let confirmBtn = null;

  function showError(text) {
    errorNode.textContent = text;
    errorNode.hidden = text === '';
  }

  function syncButton() {
    if (confirmBtn) confirmBtn.disabled = busy;
  }

  async function build() {
    const [accounts, categories, lastAccountId] = await Promise.all([
      listAccounts(),
      listCategories('income'),   // 只列收入分类：到账记的是一笔收入
      // 这个 key 与记账面板写的是同一个（entry-panel.js 的 setSetting('lastAccountId', …)），
      // 写错这个字符串不会报错，只会让默认账户永远静默退到「第一个账户」——
      // 只有在用户有多个账户时才看得出来，所以由 tests 之外的这条注释钉住名字。
      getSetting('lastAccountId', null)
    ]);
    const d = settleDefaults({ invoices, lastAccountId, accounts });
    const totalCents = d.settledCents;

    // cents 为 null 表示「输入框空了」；0 是合法金额，两者必须分开。
    let settledCents = totalCents;
    let accountId = d.accountId;
    let createTxn = true;
    // 默认分类可能不在收入分类列表里（用户把「退款」归档了，或列表为空）。
    // 那样预选会落空、下拉显示的是第一个选项，而后台变量还停在一个不可选的 id 上——
    // 记出来就是一笔分类对不上的收入。这里按**实际能选到的**回写。
    let categoryId = categories.some(c => c.id === d.categoryId)
      ? d.categoryId
      : (categories[0]?.id ?? null);

    // 一个账户都没有：createTxn 必须为 false（见纪律 4）。settleReimbursement 的
    // settledCents 在 createTxn:false 时允许缺失，所以这条路能走通。
    if (!accountId) createTxn = false;

    const keypad = createKeypad({
      // 纪律：创建时会同步首调一次 onChange，那时 keypad 还在 TDZ，这里只能用回调参数。
      onChange: ({ cents }) => { settledCents = cents; }
    });
    keypad.setFromCents(totalCents);

    const accountSel = el('select',
      { onchange: e => { accountId = e.target.value; } },
      accounts.map(a => el('option', { value: a.id, text: a.name, selected: a.id === accountId })));
    // 一个账户都没有时列表是空的，select.value 会是空串——那是个**不存在的 id**，
    // 传下去会让收入交易指向一个幽灵账户（列表里看得见、点不开）。这里显式回到 null。
    accountSel.value = accountId ?? '';

    const catSel = el('select',
      { onchange: e => { categoryId = e.target.value; } },
      categories.map(c => el('option', { value: c.id, text: c.name, selected: c.id === categoryId })));
    catSel.value = categoryId ?? '';

    const noTxnCheck = el('input', {
      type: 'checkbox',
      checked: createTxn === false,   // 没有账户时本来就是「不记账」，勾选框要如实反映
      onchange: e => { createTxn = !e.target.checked; }
    });
    // 没有账户时禁用勾选框：解开它会得到一笔没有账户的收入，那正是上面要避免的。
    if (!accountId) noTxnCheck.disabled = true;

    confirmBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '确认到账',
      onclick: async () => {
        if (busy) return;   // 连点两次会记出两笔收入（面板收起有动画）
        busy = true;
        syncButton();
        showError('');
        try {
          // 0 是合法值（公司拒报、一分没报回来），但要确认一次——手滑清空输入框同样会得到 0，
          // 两者在屏幕上长得一样。取消就把闸门放回去，让用户接着改。
          if (createTxn && settledCents === 0
              && !window.confirm('到账金额是 ¥0.00，确定吗？')) {
            busy = false;
            syncButton();
            return;
          }
          await settleReimbursement(reimb.id, { settledCents, accountId, categoryId, createTxn });
          sheet.close();
          // 可选回调：调用方（报销单详情）用它在面板关掉后重绘那一页。
          if (onSettled) onSettled();
        } catch (err) {
          // 失败必须恢复闸门，否则用户改完金额再点就没反应了（错误文字在，按钮却点不动）。
          busy = false;
          syncButton();
          showError(String(err?.message || err));
        }
      }
    });

    mount(body,
      el('div', { class: 'muted tiny', text: `「${reimb.title}」共 ${invoices.length} 张，发票合计 ${formatCents(totalCents, { symbol: true })}` }),
      // 键盘的 display 已经显示金额了，这里不再重复一个只读输入框：那会让用户以为要手输。
      keypad.node,
      el('div', { class: 'field' }, [
        el('label', { text: '到账金额' }),
        el('div', { class: 'muted tiny', text: '与发票合计不一致时会记成差额，差额在报销单详情里能看到' })
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '账户' }),
        accounts.length === 0
          ? el('div', { class: 'muted tiny', text: '还没有可用账户，这次只会标记到账、不记收入' })
          : accountSel
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '分类' }),
        categories.length === 0
          ? el('div', { class: 'muted tiny', text: '没有可用的收入分类，记出来的这笔会是「无分类」' })
          : catSel
      ]),
      el('label', { class: 'row' }, [noTxnCheck, el('span', { text: '只标记到账，不记收入' })]),
      errorNode,
      confirmBtn
    );
  }

  build().catch(err => {
    mount(body, el('div', { class: 'form-error', text: String(err?.message || err) }));
  });
}
