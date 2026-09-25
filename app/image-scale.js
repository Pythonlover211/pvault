// 图片压缩的尺寸计算与取舍判断。纯函数，可在 Node 里单测。
// 真正的 Canvas 压缩在 image-store.js 里，那部分只能在浏览器 / WebView 里跑。

/** 原图长边上限。发票上的字要看得清，1600 足够，再大只是浪费体积。 */
export const MAX_EDGE = 1600;
/** 缩略图长边。列表页只加载它。 */
export const THUMB_EDGE = 240;
export const JPEG_QUALITY = 0.72;
export const THUMB_QUALITY = 0.7;
/** 小于这个体积就不压：压完未必更小，还白白损失一次画质。 */
export const SKIP_COMPRESS_BYTES = 300 * 1024;

/**
 * 算压缩后的目标尺寸。长边超过 maxEdge 时等比缩小，否则原样返回。
 * 非法尺寸返回 0 尺寸而不是抛错——调用方据此放弃压缩、回退原图。
 */
export function computeTargetSize(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 0, height: 0, scale: 1 };
  }
  const longest = Math.max(w, h);
  if (longest <= maxEdge) {
    return { width: Math.round(w), height: Math.round(h), scale: 1 };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

/** 该不该压：既要够大（否则白损失画质），又要确实会缩小。 */
export function shouldCompress(bytes, width, height) {
  if (!Number.isFinite(bytes) || bytes < SKIP_COMPRESS_BYTES) return false;
  return computeTargetSize(width, height).scale < 1;
}

/** 压完比原图还大就不用压缩版——宁可占点体积，也不要把图弄糊。 */
export function useCompressed(originalBytes, compressedBytes) {
  if (!Number.isFinite(compressedBytes) || compressedBytes <= 0) return false;
  return compressedBytes < originalBytes;
}

/**
 * 估算含图备份的体积（MB）。base64 比二进制大约 1/3，
 * 再加缩略图与 JSON 结构，用 1.4 的系数偏高估——导出前宁可说大一点。
 */
export function estimateBackupMB(files) {
  const bytes = (files ?? []).reduce((s, f) => s + (Number(f?.size) || 0), 0);
  return Math.round((bytes * 1.4) / (1024 * 1024) * 10) / 10;
}
