// 自建数字键盘（设计规格 5.3）。
//
// 为什么不用系统键盘：系统键盘弹出慢、会盖住金额显示区，而且没有「+10」「+50」
// 这类常用额的位置（常用额按钮由任务 15 的录入面板另外提供，这里只做 0-9 . ⌫）。
//
// 本文件只是把 app/keypad-model.js 的纯状态机接到 DOM 上：所有输入规则
// （连点小数点只生效一个、小数位最多两位、整数位最多九位、前导零被替换）
// 都在 model 里，已由 tests/keypad-model.test.js 覆盖，这里不重复实现。
import { el } from './dom.js';
import { createKeypadState, pressKey, keypadText, keypadCents } from '../keypad-model.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];

export function createKeypad({ onChange } = {}) {
  let state = createKeypadState();
  const display = el('div', { class: 'keypad-display num' });
  const grid = el('div', { class: 'keypad-grid' });

  function emit() {
    // 模型里空文本代表「还没输入」，但界面上要显示 0，否则键盘区看起来是坏的。
    display.textContent = keypadText(state) || '0';
    // 注意 cents 为 null 表示「还没有有效金额」，而 0 是合法金额，
    // 调用方判空必须用 `cents === null`，不能用 `!cents`。
    if (onChange) onChange({ text: keypadText(state), cents: keypadCents(state) });
  }

  for (const k of KEYS) {
    grid.append(el('button', {
      class: 'keypad-key', type: 'button',
      text: k === 'back' ? '⌫' : k,
      onclick: () => { state = pressKey(state, k); emit(); }
    }));
  }

  function clearAll() {
    state = pressKey(state, 'clear');
    emit();
  }

  // 用现有金额回填键盘（任务 15 编辑已保存的交易时会用到）。
  // 必须走 (cents / 100).toFixed(2) 生成**纯数字文本**，不能用 formatCents(cents, { symbol: true })：
  // 后者带 ¥ 前缀，而 model 里的 parseAmountToCents 读不回带货币符号的字符串
  // （'¥12.40' → null），回填后金额会变成空。
  function setFromCents(cents) {
    state = createKeypadState();
    for (const ch of (cents / 100).toFixed(2)) state = pressKey(state, ch);
    emit();
  }

  emit();

  return {
    node: el('div', { class: 'keypad' }, [display, grid]),
    clearAll,
    setFromCents,
    get cents() { return keypadCents(state); },
    get text() { return keypadText(state); }
  };
}
