import { parseAmountToCents } from './money.js';

export function createKeypadState() {
  return { text: '' };
}

export function pressKey(state, key) {
  const text = state.text;
  if (key === 'clear') return { text: '' };
  if (key === 'back') return { text: text.slice(0, -1) };
  if (key === '.') {
    if (text.includes('.')) return { text };
    return { text: text === '' ? '0.' : text + '.' };
  }
  if (!/^\d$/.test(key)) return { text };

  const [intPart, decPart] = text.split('.');
  if (decPart !== undefined) {
    if (decPart.length >= 2) return { text };
    return { text: text + key };
  }
  if (intPart === '0') return { text: key };
  if (intPart.length >= 9) return { text };
  return { text: text + key };
}

export function keypadText(state) {
  return state.text;
}

export function keypadCents(state) {
  if (state.text === '' || state.text === '0.') return null;
  return parseAmountToCents(state.text);
}
