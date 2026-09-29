// 「标记到账」面板：到账金额 / 账户 / 分类 + 一个「只标记到账，不记收入」。
//
// 三个默认值来自 reimburse-model 的 settleDefaults（纯函数、已单测）——尤其是
// 「上次用的账户已经不在了」那条分支，它只在用户删/归档过账户之后才出现，靠手点是撞不上的。
//
// 四条纪律（都是这个文件里踩得着的那种）：
// 1. **busy 是一次性闸门**：面板收起有 180ms 动画，这期间按钮还在屏幕上、还能点第二下，
//    于是记出两笔收入。所以 busy 置上之后**一律不恢复**（成功路径尤其不能恢复）；
//    失败路径必须恢复，否则用户改完金额再点就没反应了。
//    同一条理由还管着确认回调的形状：`sheet.close()` 与调用方的 `onSettled()` 必须在 try **之外**
//    （见下面那段注释）——留在里面的话，调用方重绘时抛的错会被自己的 catch 收走。
// 2. `settledCents === null` 表示「输入框是空的」，0 是合法金额（公司拒报、一分没报回来）。
//    两者在屏幕上长得一样，所以 0 要 window.confirm 确认一次。
// 3. 错误走既有样式 `.form-error`，写法与 entry-panel.js:199 **逐字同一套**（建出来就 hidden、
//    之后只改 textContent 与 hidden），**不要新造、也不要 mount 整块 body**——后者会把
//    keypad.node 摘掉重建、用户刚输的金额一起消失。
//    （早先这里写的理由是「.form-error 有 min-height，不藏起来会留一条空白带」——那是错的：
//    styles/ledger.css:52 给它的只有 color 与 font-size，没有 min-height。留 hidden 的真正理由
//    是不留一个空盒子，与记账面板一致。）
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
    //
    // 初值写 null 而不是 totalCents：**默认金额不是靠这个变量生效的**——createKeypad 创建时会先
    // 同步首调一次 onChange(null)，那一刻这个变量就被覆盖成 null；真正把默认值放到屏幕上的是
    // 下面的 keypad.setFromCents(totalCents)，它写进键盘、再由 onChange 把发票合计回填回来。
    // 写 totalCents 只是一次**读不到的**赋值（一个看着像保证、实际不起作用的默认值）。
    let settledCents = null;
    let accountId = d.accountId;
    let createTxn = true;
    // 默认分类可能不在收入分类列表里（用户把「退款」归档了，或列表为空）。
    // 这时**回退到 null（无分类）**，不要退到 categories[0]：收入分类的第一个是「工资」，
    // 于是到账会静默记成一笔工资收入——那是一个比「无分类」更错误的断言（用户没说过这是工资）。
    // 下面那个下拉里也配了一个 value="" 的「（不选分类）」，好让显示与这个 null 对得上。
    let categoryId = categories.some(c => c.id === d.categoryId) ? d.categoryId : null;

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
      { onchange: e => { categoryId = e.target.value || null; } },
      // 第一个是空值项：分类回退到 null 时，下拉必须**显示得出来**这件事。
      // 少了它，浏览器会默认选中第一项（工资），而后台变量还是 null——用户看到的与落库的不一致。
      [el('option', { value: '', text: '（不选分类）', selected: categoryId === null })]
        .concat(categories.map(c => el('option', { value: c.id, text: c.name, selected: c.id === categoryId }))));
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

        // 空金额 + 记账：**本地就拦住**（规格 §8 的原文要求）。不拦也能被 store 的金额校验挡下
        // （createTxn:true 时缺失一律 BAD_INPUT），但那样是一次注定失败的写入，而且给用户的文案
        // 是「到账金额不对，这次没记上」——那句话说的是存储层的事，不是「你还没填金额」。
        // 只标记到账那条路（createTxn:false）**不校验金额**：那条路不产生交易，本来就没有金额。
        if (createTxn && settledCents === null) {
          busy = false;
          syncButton();
          showError('请输入到账金额');
          return;
        }

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
        } catch (err) {
          // 失败必须恢复闸门，否则用户改完金额再点就没反应了（错误文字在，按钮却点不动）。
          busy = false;
          syncButton();
          showError(String(err?.message || err));
          return;
        }

        // 走到这里钱已经记上了、单子也到账了。**收起面板与通知调用方都不属于「这次操作成不成功」**，
        // 所以它们必须在 try 之外：留在 try 里的话，调用方重绘时抛的错会被上面那个 catch 收走——
        // 那一刻 busy 被放回 false（文件头纪律 1 明说不该恢复），并且往一个**已经收起**的面板上写
        // 一句错误。实测后果：单子已 settled、一笔收入已入账，屏幕上却显示「重绘炸了」、按钮还重新可点。
        sheet.close();
        if (onSettled) {
          try {
            onSettled();
          } catch (err) {
            // 回调自己抛错时不走上面的 catch（见上）：面板此刻已经收起，把错误写进 errorNode
            // 用户根本看不到——照 invoice-editor.js:356-361 对同类「收起之后的回调」的做法，
            // 控制台留痕就够了。到账本身已经成功，这里也不该有任何界面反馈。
            console.error('到账后的刷新回调失败（到账本身已经成功）', err);
          }
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
