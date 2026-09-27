// 「外观与背景」面板：皮肤 / 深浅 / 背景照片。
//
// 所有改动**立即生效**，没有「保存」按钮：外观是所见即所得的东西，
// 多一步确认只会让人犹豫「我到底改没改」。关掉面板就是接受当前的样子。
import { el, mount } from './dom.js';
import { openSheet } from './sheet.js';
import { THEMES, THEME_TOKENS, OVERLAY_MIN, OVERLAY_MAX } from '../theme.js';
import {
  currentTheme, currentPhotoUrl, setPreset, setMode, setPhoto, removePhoto, setOverlay
} from '../theme-store.js';

const MODE_OPTIONS = [
  { id: 'auto', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
];

// 拖动遮罩时两次写库之间的最小间隔（毫秒）。理由写在 queueOverlay 那一段。
const OVERLAY_WRITE_MS = 100;

// 皮肤卡上的小色块：底色用该皮肤的 --bg、描边用它的 --border、中间的圆点用 --accent
// ——三处都取**浅色档**那一组（THEME_TOKENS[id].light），与当前深浅档无关。
// 这是刻意的，不是漏考虑深浅：五张卡要横向比「哪套是什么样」，取同一档才比得出来；而深色档那五组
// --bg（#131315 / #1c1712 / #141a14 / #17131f / #0e1a1d）彼此几乎一样，跟着深浅档走反而让这块预览
// 失去分辨力。代价如实说：深色用户看到的预览是浅色档的样子，不是他当前屏幕的样子。
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

  // ── 写库失败与重绘 ──────────────────────────────────────────
  // 这个面板碰到的每一次写库都是「操作已经发生、只是没记住」，而 setPreset / setMode / setPhoto /
  // removePhoto / setOverlay 的 JSDoc 都把 rejection 交给了调用方（也就是这里）。不接住的后果本仓库
  // 判过：未捕获的 rejection 在页面上就是「点了没反应」。这里给一句能照着做的话，再把原始错误接上，
  // 与发票图片那条路同一条口径。**但这句口径里只有前半是硬承诺**：err.message 通常是可读的中文
  //（db.js 的 onblocked 就写好了「请关掉其它 pvault 页面后重试」），实测也有英文的
  //（比如 `Image is not defined`）——那句话别读成「永远是中文」。
  // tail 由调用方给，而且**它必须在这个操作的所有失败点上都为真**：「界面已经变了」这种话只在
  // 「先画后写库」那条路上成立，对「先删库、成功后改内存」以及有两个失败点的 setOverlay 就是假话
  // （这两种各自都判过一次，见下面两处注释）。
  function reportWriteFailure(title, err, tail) {
    console.error(title, err);
    alert(`${title}：${err?.message || err}\n${tail}`);
  }

  // 重绘这一层自己也会抛（构造节点、挂载失败），而它挂在 finally 里——抛出去就是一个**没人接**的
  // rejection（这次点击的业务结果其实已经定了，提示也弹过了）。所以重绘单独兜住，只记一条日志。
  async function safeRerender() {
    try {
      // 先把滑块待写的值交出去：不先交，面板会画回一个旧值（原因见 flushOverlay）。
      await flushOverlay();
      await rerender();
    } catch (err) {
      console.error('外观面板重绘失败', err);
    }
  }

  // 点皮肤 / 点深浅：这两个函数是「先画后写库」（见 theme-store.js），而它们**只有一个 await**（写设置），
  // 并且排在 paint() 之后——所以写库失败时内存与 DOM 一定已经改了，「界面已经按你点的换了」这句话
  // 在这里是真的。（别把它照抄到失败点更多的路上去。）写库失败只影响「下次启动记不记得住」。
  async function applyThemeChange(fn, title) {
    try {
      await fn();
    } catch (err) {
      reportWriteFailure(title, err, '界面已经按你点的换了，但下次打开可能会变回去。');
    } finally {
      // 失败也要重绘：内存里的状态已经变了，不重绘就会留下「按钮高亮与页面颜色对不上」。
      // 成功那条路同样要重绘，否则高亮根本不会跟着走。
      await safeRerender();
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
      await safeRerender();
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
  let overlaySent = null;      // 已经交给写库链路的值（失败时会被回滚，见 writeOverlay）
  let overlayQueued = null;    // 最近一次要写的值（可能还没落库）
  let overlayTimer = null;
  let overlayChain = Promise.resolve();
  let overlayAlerted = false;  // 见 writeOverlay：拖动时的失败只提示一次

  function writeOverlay(value) {
    overlaySent = value;
    overlayChain = overlayChain.then(() => setOverlay(value)).catch(err => {
      // **失败要把它回滚**（只回滚自己那一次，别把后来者的标记抹掉）：不回滚的话，下一次补写会被
      // `overlayQueued !== overlaySent` 判成「这个值已经写过了」而跳过——于是首帧失败一次之后，
      // 就算写库恢复了也永远补不上：库停在旧值、画面上是新值，重启后跳回去。
      //（实测过这条：首帧写失败、50ms 后恢复 → 尾部补写被跳过、put 次数 0、库里还是 30。）
      if (overlaySent === value) overlaySent = null;
      console.error('背景遮罩没能记住', err);
      // 这条尾句**不能照抄上面那两条**：`setOverlay` 的失败点有两个，而它们之间隔着「改内存 / 写 DOM」——
      //   · `await getSetting(...)` 失败：内存与 DOM 都还没改，**画面上一点变化都没有**；
      //   · `await setSetting(...)` 失败：内存与 DOM 已经改了，画面是新值、库里是旧值。
      // 所以说「画面上已经变了」在第一种情况下就是假话。这个坑在皮肤 / 深浅那条路上判过一次
      //（那两条只有一个 await、且排在 paint() 之后），滑块这里是同一件事，别只修一处。
      // 下面这句在两种失败下都为真：来自 getSetting 时 setSetting 根本没跑，来自 setSetting 时写库
      // 没成功——两种情况下库里留着的都是旧值，所以「没记住」与「重开后会退回旧值」都成立。
      // 另外**只提示一次**：拖动时每次失败都 alert 会连弹，而 alert 会阻塞主线程——正在拖的那只手
      // 会被卡住，一个提示反而把「跟手」这件事搞坏。
      if (overlayAlerted) return;
      overlayAlerted = true;
      alert(`遮罩没能存进手机：${err?.message || err}\n这个值没有记住——重开一次 app 会退回上一次存下的那个。`);
    });
  }

  // 把待写的值立刻交出去（不再等 OVERLAY_WRITE_MS），并返回整条写库链。
  // 拖动途中去点皮肤时，rerender 会拿 currentTheme().overlay 重建滑块：不先把 pending 值交出去，
  // 面板会画回「上一次已经写过的那个值」，而库里与画面上都是新值——三处两个真相
  //（实测：面板 35%、库 55、DOM 0.55）。
  function flushOverlay() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
    if (overlayQueued !== null && overlayQueued !== overlaySent) writeOverlay(overlayQueued);
    return overlayChain;
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

  // 规格 §8 第 4 条：面板顶部一行小字说明当前皮肤名——一列色块看不出「我现在是哪套」。
  function renderCurrent(state) {
    const name = THEMES.find(t => t.id === state.preset)?.name ?? state.preset;
    return el('div', { class: 'hint-text', text: '当前皮肤：' + name });
  }

  function renderPresets(state) {
    return el('div', { class: 'field' }, [
      el('label', { text: '配色' }),
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
    return el('div', { class: 'field' }, [
      el('label', { text: '深浅' }),
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
          // 与发票图片那条路一致：给一句能照着做的话，再把原始错误接上。
          // 尾句取中性说法：setPhoto 有四个失败点（编码 → 写 assets → 写设置 → 应用），其中「图和设置
          // 都已经写进去了、只是这一次没画出来」那一种会让重启后背景反而出现——所以不能替它下结论。
          alert('这张照片没能设成背景：' + (err?.message || err) + '\n重开一次 app 看看背景有没有出现。');
        } finally {
          // picking 先复位、再重绘：重绘失败（safeRerender 兜住）也不该把 picking 卡在 true 上，
          // 否则用户此后每次选图都被 `if (!file || picking) return` 挡掉。
          picking = false;
          await safeRerender();
        }
      }
    });

    const pick = el('button', {
      class: 'btn', type: 'button', dataset: { action: 'pick-photo' },
      text: state.photo ? '换一张' : '选择图片',
      onclick: () => fileInput.click()
    });

    if (!state.photo) {
      return el('div', { class: 'field' }, [
        el('label', { text: '背景照片' }),
        el('div', { class: 'photo-row' }, [pick, fileInput]),
        // 只说真做得到的事：照片缩到最长边**最大** 1600 后存在这台手机上（`image-scale.js` 对
        // 最长边已经 ≤1600 的图**不放大**，所以写「压到 1600」是错的——一张 800px 的图进去还是 800px）。
        // **「导出备份时会一起带走」这句是任务 13 之后才加回来的**：它此前被删掉，理由是「导出包现在还不带
        // 背景，面板不该承诺一件这个版本做不到的事」——那个理由随任务 13 消失了（`buildBackup` 的 data
        // 里有 `background`，导出时由 `encodeBackground` 填、导入时写回 `assets`，两侧都有测试钉住）。
        // 边界（别把这句读成全称）：`encodeBackground` 失败时**那一次**导出不带背景，而那条降级是静默的
        // （只有 Console 里一条 warn）。所以这句承诺成立的前提是「读图没出岔子」，它是「会」不是「永远会」。
        el('div', { class: 'hint-text', text: '选一张照片铺在卡片下面。照片的最长边最多留 1600 像素，然后存在这台手机上，导出备份时会一起带走。' })
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

    // 缩略图用 theme-store 正在给背景层用的那个 blob URL（规格 §8 第 3 条）。
    // 为什么复用它、而不是面板自己 createObjectURL 一份：renderPhoto **每次重绘都会跑一遍**（每点一次
    // 皮肤 / 深浅都会重绘），自建就得在每次重绘前先 revoke 上一个，漏一次就多一个 URL 条目；共享这一份
    // 的 revoke 责任只有一处，由 theme-store 的 setPhotoVars 在换图 / 移除时统一释放。
    // **注意**：「不要 revoke 它」只是注释约定，没有机制拦着——面板若去 revoke，背景层会当场没掉。
    const thumbUrl = currentPhotoUrl();

    // 一条已知的降级，本面板**不**替它兜底，这里只把这层写清：若 settings 里那条 backgroundImage
    // 被外部清掉、而内存里的 applied.photo 还是 true（判据与来源见 theme-store.js 的 setOverlay），
    // 拖这个滑块只会改画面、不会重建设置——重启后照片按「没有背景」处理，用户的观感是「我调了遮罩、
    // 照片却没了」。面板看不出这件事：currentTheme() 只给 photo: true / false，没有「设置还在不在」
    // 这一层，要在这里提示就得给 theme-store 加一条新通道；而自愈的正确位置也**不在面板**——能判断
    // 「设置丢了」的只有 theme-store 自己。所以本步保持原行为（任务 8 那段注释已经把这个选择写死），
    // 只留下这段说明。
    return el('div', { class: 'field' }, [
      el('label', { text: '背景照片' }),
      el('div', { class: 'photo-row' }, [
        thumbUrl ? el('img', { class: 'photo-thumb', src: thumbUrl, alt: '当前背景照片' }) : null,
        pick, fileInput,
        el('button', {
          class: 'btn btn-danger', type: 'button', dataset: { action: 'remove-photo' },
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
    mount(container, [renderCurrent(state), renderPresets(state), renderModes(state), renderPhoto(state)]);
  }

  safeRerender();
  return sheet;
}
