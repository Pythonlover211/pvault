// 发票图片的压缩与存取。
// 依赖 Canvas / Blob / indexedDB，**不能在 Node 里 import**。
// 所有纯计算已抽到 image-scale.js 单测，这里只做浏览器 API 的编排。

import * as db from './db.js';
import { uid } from './store.js';
import {
  MAX_EDGE, THUMB_EDGE, JPEG_QUALITY, THUMB_QUALITY,
  computeTargetSize, shouldCompress, useCompressed, estimateBackupMB
} from './image-scale.js';

export { estimateBackupMB };

/**
 * 用 <img> + object URL 解码。这是 decode 的最后一道退路，也是老内核（没有 createImageBitmap）唯一的路。
 * <img> 在 Chrome 81+ 默认 from-image，EXIF 方向是套用过的，所以这条路出来的位图本来就是正的。
 */
async function loadViaImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // decode() 一 resolve，像素就已经在 <img> 里了，URL 此后只是多占着一份 Blob 不让回收。
    // 放 finally：解码抛错（损坏文件、不支持的格式）时也不能把这个 URL 漏在内存里。
    URL.revokeObjectURL(url);
  }
}

/**
 * 解码成可画进 canvas 的位图。两条纪律：
 * 1. 必须显式写 imageOrientation: 'from-image'——Chromium 的 createImageBitmap 默认是 'none'，
 *    不套用 EXIF 方向；手机竖拍的发票会因此躺倒，而 canvas 重编码会把 EXIF 一起丢掉，
 *    躺倒从此不可逆（同一张图走 <img> 显示时反而是正的，更让人以为是偶发）。
 * 2. 失败必须退回 <img>：createImageBitmap 存在 ≠ 调用成功，HEIC、损坏文件、内存不足
 *    都会让它 reject；那时退回 <img>（它本来就是 from-image，方向也对）比整段放弃好得多——
 *    放弃会连已经能生成的缩略图一起丢掉。
 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (err) {
      // 老内核不认这个选项会抛 TypeError；图片本身有问题也会抛。两种情况都往下走。
      console.warn('createImageBitmap 解码失败，退回 <img>', err);
    }
  }
  return loadViaImg(blob);
}

/**
 * 位图用完立刻释放。ImageBitmap 背后是一整张解压后的像素（手机上一张就是几十 MB），
 * 等 GC 来收意味着连拍几张就先把自己撑爆；<img> 没有 close，可选调用正好兼容两条路径。
 */
function releaseSource(source) {
  source?.close?.();
}

/** 画到指定长边并导出 JPEG Blob。 */
async function drawTo(source, maxEdge, quality) {
  // 用 || 而不是 ??：<img> 在没插进文档等情形下 .width 会是 0，而 0 在 ?? 眼里是「有效值」，
  // 会一路走到「尺寸无效」把整张图（连带刚生成的缩略图）丢掉——0 只是个空值，该去看 naturalWidth。
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const target = computeTargetSize(w, h, maxEdge);
  // 不写 `=== 0`：脏尺寸配合非法 maxEdge 时这里可能是 NaN，而 NaN === 0 为 false，
  // 会放过去给 canvas 设一块宽度 0 的画布，白跑一遍 toBlob 再报一次错。
  if (!(target.width >= 1)) throw new Error('图片尺寸无效');
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  // canvas 缩放默认是 low（最近邻），缩到 1600 时发票上的小字会糊成一片马赛克，
  // 而 MAX_EDGE 这个上限存在的意义恰恰是「字要看得清」，所以这里必须显式要 high。
  ctx.imageSmoothingQuality = 'high';
  // 发票多为白底黑字，缩放后最容易出现的是一圈灰边；铺白底再画能干净不少
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('canvas.toBlob 返回空');
  return blob;
}

/**
 * 是不是 PDF。只看 `mime === 'application/pdf'` 太严：安卓的文件选择器给出的常常是
 * `application/pdf; charset=binary`、`application/octet-stream`，甚至是空 type，
 * 这些都会被漏成「图片」送进 <img> 解码，用户拍下来的 PDF 最后只剩一张裂图。
 * 所以 mime 里含 pdf、或文件名以 .pdf 结尾，都算数。
 */
function isPdf(mime, name) {
  return /pdf/i.test(mime) || /\.pdf$/i.test(name || '');
}

/**
 * 读入用户选的发票文件，返回可直接落库的形态：
 * `{ blob, thumbBlob, mime, size, originalSize, compressed, failed }`
 * - thumbBlob 可能是 null：PDF 本来就没有缩略图，或连缩略图都没生成出来；
 * - failed 为 true 表示压缩环节整个失败、已回退原图（此时 blob 就是 inputFile），
 *   但只要缩略图成功生成过就仍然带出来，列表页不至于只能显示占位方块；
 * - compressed 为 true 时才有 originalSize（压缩前的字节数），界面据此算省了多少。
 * 任何一步失败都回退原图——不能因为省体积就把用户的发票弄丢。
 */
export async function prepareFile(inputFile) {
  const mime = String(inputFile?.type || '');
  const size = Number(inputFile?.size) || 0;

  if (isPdf(mime, inputFile?.name)) {
    // PDF 不压缩，原样存；也没有缩略图。
    // mime 一律写成 application/pdf：选择器给的可能带 charset= 参数或是空 type，
    // 存原文也能用（预览只认 image/ 前缀），但备份里的元数据会留一堆五花八门的写法。
    return { blob: inputFile, thumbBlob: null, mime: 'application/pdf', size, compressed: false };
  }

  // 提到 try 外面：压缩失败时 catch 也要看得见它们，才能把已经生成好的缩略图一起返回。
  let thumbBlob = null;
  let source = null;
  try {
    source = await decode(inputFile);
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    thumbBlob = await drawTo(source, THUMB_EDGE, THUMB_QUALITY);

    if (!shouldCompress(size, w, h)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    const out = await drawTo(source, MAX_EDGE, JPEG_QUALITY);
    if (!useCompressed(size, out.size)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    return {
      blob: out, thumbBlob, mime: 'image/jpeg',
      size: out.size, originalSize: size, compressed: true
    };
  } catch (err) {
    console.error('发票图片压缩失败，按原样保存', err);
    // 缩略图成功过就留着：它只是一张 240px 的小图，扔了列表就只能显示占位方块，
    // 而原图其实好好地存在库里。
    return {
      blob: inputFile, thumbBlob,
      mime: mime || 'application/octet-stream', size, compressed: false, failed: true
    };
  } finally {
    // finally 而不是在成功路径上 close：上面每一条 return 和抛错都是出口，漏一条就漏一张位图。
    releaseSource(source);
  }
}

/** 把 prepareFile 的结果写进 invoiceFiles，返回 fileId。 */
export async function saveFile(prepared) {
  const id = uid();
  try {
    await db.put('invoiceFiles', {
      id,
      blob: prepared.blob,
      thumbBlob: prepared.thumbBlob,
      mime: prepared.mime,
      size: prepared.size ?? prepared.blob.size,
      createdAt: Date.now()
    });
  } catch (err) {
    // 配额写满是这台手机上最可能撞到的失败：一张原图几 MB。直接把 IndexedDB 的异常抛出去，
    // 用户在编辑器里看到的是「图片保存失败：QuotaExceededError: …」——既不知道发生了什么，
    // 也不知道下一步该做什么。这里换成一句能照着做的话。
    if (err?.name === 'QuotaExceededError') {
      const quota = new Error('手机存储空间不够了，照片没存下。可以先去「记账 → 备份」导出一份并清理旧图再试。');
      // 沿用原 name：界面读的是 message（已经是中文人话），控制台与排查时仍认得出这是配额失败，
      // 不至于退化成一个无从追查的普通 Error。
      quota.name = err.name;
      throw quota;
    }
    throw err;
  }
  return id;
}

export async function getFile(id) {
  if (!id) return null;
  return (await db.get('invoiceFiles', id)) ?? null;
}

export async function deleteFile(id) {
  if (!id) return;
  await db.removeAll([{ store: 'invoiceFiles', key: id }]);
}

// 同一份记录只建一次 URL，并记住它们，好让整页重绘时能一次性回收。
// 为什么不让调用方自己 revoke：调用点在搜索框的 oninput 里（每敲一个字跑一遍），
// 漏一次就是一批 URL 活到页面卸载，而每个 URL 都会 pin 住对应的 Blob。
const urlCache = new Map();   // key: `${kind}:${id}` → url

async function cachedUrl(kind, id, make) {
  const key = `${kind}:${id}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const url = await make();
  // 只记真的拿到了 URL 的情况。把 null（PDF 没有缩略图）也缓存下来的话，
  // 下次命中就得先判断「缓存里是不是 null」，反而更容易写错。
  if (url) urlCache.set(key, url);
  return url;
}

/**
 * 回收缩略图 URL 中「这一批不再需要的」那些：keepIds 是本批列表真正用到（真的取到了 URL）的 fileId 集合。
 *
 * 为什么不是「整页重绘前一律清空」：发票列表每敲一个字都要重绘一次，全量清空等于每按一个键
 * 就把可见的缩略图全部重新读一遍 IndexedDB、重新建一遍 blob URL，而其中绝大多数上一批刚取过。
 * 差集回收之后，连续搜索基本只读新出现的那几张。
 *
 * 只动 thumb: 前缀：编辑器预览用的是 full:（同一张图的原图），那是它自己手里的资源——
 * 列表页一次重绘顺手把它 revoke 掉，编辑器里的预览当场变成裂图。
 */
export function pruneUrlCache(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds ?? []);
  for (const [key, url] of urlCache) {
    if (!key.startsWith('thumb:')) continue;
    if (keep.has(key.slice('thumb:'.length))) continue;
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
}

export function revokeUrl(url) {
  if (!url) return;
  // 同步删掉缓存项：编辑器换图时会 revoke 旧 URL，缓存里若还留着它，
  // 之后命中的就是一个已经失效的 URL（图片会变成裂图）。
  for (const [key, cached] of urlCache) {
    if (cached === url) urlCache.delete(key);
  }
  URL.revokeObjectURL(url);
}

/**
 * 列表页的缩略图地址。两条契约都得知道：
 * 1. 返回的 URL 由本模块统一缓存，调用方**不要**自己 revoke；这一批画完时把本批用到的 id
 *    交给 pruneUrlCache(keepIds)，由它差集回收——不再需要的那批 revoke 掉，还在用的留着命中缓存；
 * 2. 这条记录是 PDF（或压根没生成出缩略图）时返回 null，调用方据此改显示占位图标，
 *    不要拿 null 去当 src——`<img src="null">` 会去请求一个真叫 null 的地址。
 */
export async function getThumbUrl(id) {
  return cachedUrl('thumb', id, async () => {
    const rec = await getFile(id);
    const blob = rec?.thumbBlob ?? null;
    if (!blob) return null;
    return URL.createObjectURL(blob);
  });
}

/**
 * 原图的地址。和 getThumbUrl 不同，它回答的是「这份资源在哪」，不是「这是不是一张能塞进 <img> 的图」：
 * PDF 记录同样会返回 URL。调用方（编辑器预览）必须先看 mime 再决定用 <img> 还是显示占位，
 * 直接塞进 <img> 得到的是裂图加一行浅灰 alt 文字，比干脆不显示更糟。
 */
export async function getFullUrl(id) {
  return cachedUrl('full', id, async () => {
    const rec = await getFile(id);
    const blob = rec?.blob ?? null;
    if (!blob) return null;
    return URL.createObjectURL(blob);
  });
}
