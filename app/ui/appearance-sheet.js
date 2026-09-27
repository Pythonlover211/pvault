// 「外观与背景」面板：皮肤 / 深浅 / 背景照片。
//
// 所有改动**立即生效**，没有「保存」按钮：外观是所见即所得的东西，
// 多一步确认只会让人犹豫「我到底改没改」。关掉面板就是接受当前的样子。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { THEMES, THEME_TOKENS, OVERLAY_MIN, OVERLAY_MAX } from '../theme.js';
import {
  currentTheme, setPreset, setMode, setPhoto, removePhoto, setOverlay
} from '../theme-store.js';

const MODE_OPTIONS = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
];

// 拖动遮罩时两次写库之间的最小间隔（毫秒）。理由写在 queueOverlay 那一段。
const OVERLAY_WRITE_MS = 100;

// 皮肤卡上的小色块：底色用该皮肤的 --bg，中间的圆点用 --accent。
// 这两个颜色就是用户切换时最先感受到的差异，所以拿它们当预览。
function themeChip(themeId) {
  const tokens = THEME_TOKENS[themeId].light;
  const chip = el('span', { class: 'theme-chip' });
  chip.style.background = tokens['--bg'];
  chip.style.borderColor = tokens['--border'];
  const dot = el('span', { class: 'theme-dot' });
  dot.style.background = tokens['--accent'];
  chip.append(dot);
  return chip;
}

export function openAppearanceSheet() {
  const container = el('div', { class: 'stack' });
  // 选图期间用户可能连点两次「选择图片」：第二次进来时第一次的压缩还没写完，
  // 两条流程会各自写一次 assets 并各自建一个 blob URL，先建的那个就漏了。
  let picking = false;

  const sheet = openSheet({ title: '外观与背景', body: container });

  // ── 写库失败的统一出口 ──────────────────────────────────────
  // 这个面板碰到的写库都是「操作已经发生、只是没记住」，而 setPreset / setMode / setPhoto /
  // removePhoto 的 JSDoc 都把 rejection 交给了调用方（也就是这里）。不接住的后果本仓库判过：
  // 未捕获的 rejection 在页面上就是「点了没反应」。这里给一句能照着做的话，而不是把 IndexedDB
  // 的英文异常甩出去——err.message 通常已经是可读的中文（db.js 的 onblocked 就写好了「请关掉
  // 其它 pvault 页面后重试」），与发票图片那条路同一条口径。
  // tail 由调用方给：几种操作失败时界面到底变没变并不一样（见下面两处各自的注释），
  // 一句万能的「界面已经变了」对其中一条就是假话。
  function reportWriteFailure(title, err, tail) {
    console.error(title, err);
    alert(`${title}：${err?.message || err}\n${tail}`);
  }

  // 点皮肤 / 点深浅：这两个函数是「先画后写库」（见 theme-store.js），写库失败时内存与 DOM 已经改了。
  async function applyThemeChange(fn, title) {
    try {
      await fn();
    } catch (err) {
      reportWriteFailure(title, err, '界面已经按你点的换了，但下次打开可能会变回去。');
    } finally {
      // 失败也要重绘：内存里的状态已经变了，不重绘就会留下「按钮高亮与页面颜色对不上」。
      // 成功那条路同样要重绘，否则高亮根本不会跟着走。
      await rerender();
    }
  }

  // 移除背景：removePhoto 是「先删库、成功之后再改内存与 DOM」，所以失败时界面**可能**一点没变
  //（第一步就失败），也可能删了图却没清设置（第二步失败）——对它不能说「界面已经变了」。
  async function removeBackground() {
    try {
      await removePhoto();
    } catch (err) {
      reportWriteFailure('移除背景没能完成', err,
        '照片可能还在，也可能只剩一半——重开一次 app 看看现在是什么样子。');
    } finally {
      await rerender();
    }
  }

  // ── 遮罩滑块的写库节流 ──────────────────────────────────────
  // 每次 setOverlay 要做一次 getSetting + 一次 setSetting（两次 IndexedDB 事务），而 range 的 input
  // 在拖动时按帧触发（触摸屏上一秒几十次）。所以这里做**节流**而不是防抖：
  //   · 画面必须跟手——防抖（等停手再写）会让遮罩在松手之前一动不动，而「所见即所得」正是这个面板
  //     的全部卖点；节流让第一次拖动立刻生效，之后的更新最多滞后 OVERLAY_WRITE_MS。
  //   · **尾部那次补写是必需的**：只做「首帧 + 间隔」会在用户停手时丢掉最后一个值，留下
  //     「面板显示 50%、库里还是 40%」——重启后遮罩自己跳回去。
  //   · **串行（overlayChain）同样是必需的**：两次 setOverlay 并发跑，各自 getSetting 读到旧记录、
  //     各自写回，后完成的那次可能盖掉更新的值，库里最终留哪个值取决于时序。
  // 已知代价：画面上遮罩的实际变化最多每 OVERLAY_WRITE_MS 更新一次，拖动时的平滑度取决于这个值。
  // 本机没有浏览器，这个数只能靠任务 15 的真机验收（清单里有一条：拖动跟手、松手后重启仍是那个值）。
  let overlaySent = null;      // 已经交给写库链路的值
  let overlayQueued = null;    // 最近一次要写的值（可能还没落库）
  let overlayTimer = null;
  let overlayChain = Promise.resolve();
  let overlayAlerted = false;  // 见 writeOverlay：拖动时的失败只提示一次

  function writeOverlay(value) {
    overlaySent = value;
    overlayChain = overlayChain.then(() => setOverlay(value)).catch(err => {
      console.error('背景遮罩没能记住', err);
      // 与上面那条路同一条口径，但**只提示一次**：拖动时每次失败都 alert 会连弹，而 alert 会阻塞
      // 主线程——正在拖的那只手会被卡住，一个提示反而把「跟手」这件事搞坏。
      if (overlayAlerted) return;
      overlayAlerted = true;
      alert(`遮罩没能存进手机：${err?.message || err}\n画面上已经变了，但下次打开可能会变回去。`);
    });
  }

  function queueOverlay(value) {
    overlayQueued = value;
    if (overlayTimer) return;                  // 间隔内：交给下面那次补写
    writeOverlay(value);                       // 首帧立刻应用，遮罩跟着手指走
    overlayTimer = setTimeout(() => {
      overlayTimer = null;
      if (overlayQueued !== overlaySent) writeOverlay(overlayQueued);
    }, OVERLAY_WRITE_MS);
  }

  function renderPresets(state) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '配色' }),
      el('div', { class: 'theme-row' }, THEMES.map(t => {
        const selected = t.id === state.preset;
        return el('button', {
          class: selected ? 'theme-card on' : 'theme-card',
          type: 'button',
          dataset: { theme: t.id },
          'aria-pressed': String(selected),
          onclick: () => applyThemeChange(() => setPreset(t.id), '皮肤没能存进手机')
        }, [themeChip(t.id), el('span', { class: 'theme-name', text: t.name })]);
      }))
    ]);
  }

  function renderModes(state) {
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '深浅' }),
      el('div', { class: 'seg-row' }, MODE_OPTIONS.map(m => {
        const selected = m.id === state.modeChoice;
        return el('button', {
          class: selected ? 'seg on' : 'seg',
          type: 'button',
          dataset: { mode: m.id },
          'aria-pressed': String(selected),
          text: m.label,
          onclick: () => applyThemeChange(() => setMode(m.id), '深浅没能存进手机')
        });
      }))
    ]);
  }

  function renderPhoto(state) {
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', class: 'hide-file',
      onchange: async e => {
        const file = e.target.files?.[0];
        // 先清空 value：同一张图连选两次不会触发 change，用户会觉得按钮坏了。
        e.target.value = '';
        if (!file || picking) return;
        picking = true;
        try {
          await setPhoto(file);
        } catch (err) {
          console.error('背景图设置失败', err);
          // 与发票图片那条路一致：给一句能照着做的话，而不是把 IndexedDB 的英文异常甩出去。
          alert('这张照片没能设成背景：' + (err?.message || err));
        } finally {
          picking = false;
          await rerender();
        }
      }
    });

    const pick = el('button', {
      class: 'btn', type: 'button', dataset: { action: 'pick-photo' },
      text: state.photo ? '换一张' : '选择图片',
      onclick: () => fileInput.click()
    });

    if (!state.photo) {
      return el('div', { class: 'stack' }, [
        el('div', { class: 'field-label', text: '背景照片' }),
        el('div', { class: 'photo-row' }, [pick, fileInput]),
        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片会压到长边 1600 像素后存进手机，并跟着备份一起走。' })
      ]);
    }

    const slider = el('input', {
      type: 'range', class: 'ov-range',
      min: String(OVERLAY_MIN), max: String(OVERLAY_MAX), step: '5',
      'aria-label': '背景遮罩强度',
      oninput: e => {
        // 数字每帧跟手（它就在滑块旁边，滞后一眼就看得出来）；写库走上面的节流。
        valueLabel.textContent = e.target.value + '%';
        queueOverlay(e.target.value);
      }
    });
    // range 的初值用 property 设而不是属性：setAttribute('value') 在部分内核上
    // 只改默认值、不改当前值，滑块会停在最左端。
    slider.value = String(state.overlay);
    const valueLabel = el('span', { class: 'ov-value', text: state.overlay + '%' });

    // 一条已知的降级，本面板**不**替它兜底，这里只把这层写清：若 settings 里那条 backgroundImage
    // 被外部清掉、而内存里的 applied.photo 还是 true（判据与来源见 theme-store.js 的 setOverlay），
    // 拖这个滑块只会改画面、不会重建设置——重启后照片按「没有背景」处理，用户的观感是「我调了遮罩、
    // 照片却没了」。面板看不出这件事：currentTheme() 只给 photo: true / false，没有「设置还在不在」
    // 这一层，要在这里提示就得给 theme-store 加一条新通道；而自愈的正确位置也**不在面板**——能判断
    // 「设置丢了」的只有 theme-store 自己。所以本步保持原行为（任务 8 那段注释已经把这个选择写死），
    // 只留下这段说明。
    return el('div', { class: 'stack' }, [
      el('div', { class: 'field-label', text: '背景照片' }),
      el('div', { class: 'photo-row' }, [pick, fileInput,
        el('button', {
          class: 'btn btn-ghost', type: 'button', dataset: { action: 'remove-photo' },
          text: '移除',
          onclick: () => removeBackground()
        })
      ]),
      el('div', { class: 'ov-row' }, [el('span', { class: 'ov-label', text: '遮罩' }), slider, valueLabel]),
      el('div', { class: 'hint-text', text: '遮罩是压在照片上的一层。数字看不清就把它调大。' })
    ]);
  }

  // 每次状态变化整块重建：面板内容不多，重建比逐节点同步简单得多，
  // 也不会出现「按钮的高亮和实际皮肤不一致」这种两处状态各写一半的问题。
  async function rerender() {
    const state = currentTheme();
    mount(container, [renderPresets(state), renderModes(state), renderPhoto(state)]);
  }

  rerender();
  return sheet;
}
