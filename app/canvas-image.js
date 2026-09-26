// 浏览器侧的图片编解码工具：解码（含 EXIF 方向）、缩放到指定长边、导出 JPEG。
// 依赖 Image / createImageBitmap / canvas / URL，**不能在 Node 里 import**。
// 纯计算（尺寸取舍、质量取值）在 image-scale.js 里单测，这里只做 API 编排。
//
// 发票图片（image-store）与外观背景图（theme-store）共用这一份：
// 两边都要「解码 → 缩放 → JPEG」，而 EXIF 方向这类纪律只要有一边漏了，
// 用户看到的就是一张躺倒的图——复制两份实现迟早会漂成一个对一个错。

import { computeTargetSize } from './image-scale.js';

/**
 * 用 <img> + object URL 解码。这是 decode 的最后一道退路，也是老内核（没有 createImageBitmap）唯一的路。
 * <img> 在 Chrome 81+ 默认 from-image，EXIF 方向是套用过的，所以这条路出来的位图本来就是正的。
 */
export async function loadViaImg(blob) {
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
export async function decode(blob) {
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
export function releaseSource(source) {
  source?.close?.();
}

/** 画到指定长边并导出 JPEG Blob。 */
export async function drawTo(source, maxEdge, quality) {
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
