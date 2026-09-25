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

/** 把 File/Blob 解码成可绘制的位图。优先 createImageBitmap，失败时退回 <img>。 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 画到指定长边并导出 JPEG Blob。 */
async function drawTo(source, maxEdge, quality) {
  const w = source.width ?? source.naturalWidth;
  const h = source.height ?? source.naturalHeight;
  const target = computeTargetSize(w, h, maxEdge);
  if (target.width === 0) throw new Error('图片尺寸无效');
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  // 发票多为白底黑字，缩放后最容易出现的是一圈灰边；铺白底再画能干净不少
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('canvas.toBlob 返回空');
  return blob;
}

/**
 * 读入用户选的发票文件，返回可直接落库的形态。
 * 任何一步失败都回退原图——不能因为省体积就把用户的发票弄丢。
 */
export async function prepareFile(inputFile) {
  const mime = inputFile.type || '';
  const size = inputFile.size;

  if (mime === 'application/pdf') {
    // PDF 不压缩，原样存；也没有缩略图
    return { blob: inputFile, thumbBlob: null, mime, size, compressed: false };
  }

  try {
    const img = await decode(inputFile);
    const thumbBlob = await drawTo(img, THUMB_EDGE, THUMB_QUALITY);

    if (!shouldCompress(size, img.width, img.height)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    const out = await drawTo(img, MAX_EDGE, JPEG_QUALITY);
    if (!useCompressed(size, out.size)) {
      return { blob: inputFile, thumbBlob, mime: mime || 'image/jpeg', size, compressed: false };
    }
    return {
      blob: out, thumbBlob, mime: 'image/jpeg',
      size: out.size, originalSize: size, compressed: true
    };
  } catch (err) {
    console.error('发票图片压缩失败，按原样保存', err);
    return {
      blob: inputFile, thumbBlob: null,
      mime: mime || 'application/octet-stream', size, compressed: false, failed: true
    };
  }
}

/** 把 prepareFile 的结果写进 invoiceFiles，返回 fileId。 */
export async function saveFile(prepared) {
  const id = uid();
  await db.put('invoiceFiles', {
    id,
    blob: prepared.blob,
    thumbBlob: prepared.thumbBlob,
    mime: prepared.mime,
    size: prepared.size ?? prepared.blob.size,
    createdAt: Date.now()
  });
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

/** 列表页只需要缩略图。取不到缩略图（PDF 或压缩失败）时返回 null，由界面显示占位图标。 */
export async function getThumbUrl(id) {
  const rec = await getFile(id);
  if (!rec) return null;
  const blob = rec.thumbBlob ?? null;
  if (!blob) return null;
  return URL.createObjectURL(blob);
}

export async function getFullUrl(id) {
  const rec = await getFile(id);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}

export function revokeUrl(url) {
  if (url) URL.revokeObjectURL(url);
}
