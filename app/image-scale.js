// 图片压缩的尺寸计算与取舍判断。纯函数，可在 Node 里单测。
// 真正的 Canvas 压缩在 image-store.js 里，那部分只能在浏览器 / WebView 里跑。

/** 原图长边上限。发票上的字要看得清，1600 足够，再大只是浪费体积。 */
export const MAX_EDGE = 1600;
/** 缩略图长边。列表页只加载它。 */
export const THUMB_EDGE = 240;
/**
 * 原图 JPEG 质量。0.72 是「白底黑字」这类高对比内容上的经验拐点：
 * 再往下（0.6 一带）发票上的小号数字开始出现肉眼可见的毛边，往上到 0.85 以上
 * 体积几乎线性变贵却看不出区别——压完的图还是要在手机上直接看清金额和号码的。
 */
export const JPEG_QUALITY = 0.72;
/**
 * 缩略图质量，比原图略低。理由不是省那点体积，而是列表要一次读几十张：
 * 缩略图只有 240px，是列表里的一小块，0.72 与 0.7 的差别肉眼不可辨，
 * 而每一 KB 都要乘以「一屏几十张」，省下来的是切 Tab 时的加载时间。
 */
export const THUMB_QUALITY = 0.7;
/** 小于这个体积就不压：压完未必更小，还白白损失一次画质。 */
export const SKIP_COMPRESS_BYTES = 300 * 1024;

/**
 * 算压缩后的目标尺寸。长边超过 maxEdge 时等比缩小，否则原样返回。
 * 非法的尺寸或 maxEdge 一律返回 0 尺寸而不是抛错——调用方据此放弃压缩、回退原图。
 */
export function computeTargetSize(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width);
  const h = Number(height);
  const edge = Number(maxEdge);
  // maxEdge 必须和宽高一起校验，它是单独就能把图毁掉的那个参数：
  // edge = 0 时任何图都会被缩成 1×1（发票变成一像素）；edge 为 NaN 时
  // Math.max(1, NaN) 得到 NaN，而调用方原来的守卫写的是 `target.width === 0`——
  // NaN === 0 是 false，NaN 会从缝里溜过去，最后给 canvas 设一块宽度 0 的画布白跑一趟。
  // edge < 1 与 0 同类，一并算非法。
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 ||
      !Number.isFinite(edge) || edge < 1) {
    return { width: 0, height: 0, scale: 1 };
  }
  const longest = Math.max(w, h);
  if (longest <= edge) {
    return { width: Math.round(w), height: Math.round(h), scale: 1 };
  }
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

/**
 * 该不该压：既要够大（否则白损失画质），又要确实会缩小。
 * 「确实会缩小」比的是取整后的像素数，不是 scale。反例：computeTargetSize(1600.6, 10, 1600)
 * 的目标是 (1600, 10)，和原图截断后的像素数一模一样，可 scale = 0.9996 < 1——
 * 只看 scale 就会判成「该压」，白白多跑一次解码 + 重编码，还多损失一道画质。
 * 小数尺寸本身是脏数据：位图的像素宽度只能是整数，1600.6 的图解码出来就是 1600 像素，
 * 所以原尺寸也按截断算，两边才是同一把尺子。
 */
export function shouldCompress(bytes, width, height) {
  if (!Number.isFinite(bytes) || bytes < SKIP_COMPRESS_BYTES) return false;
  const target = computeTargetSize(width, height);
  // 尺寸非法（含 maxEdge 兜底那一路）就谈不上「压小了」，交给调用方回退原图。
  if (!(target.width >= 1)) return false;
  return target.width < Math.trunc(Number(width)) || target.height < Math.trunc(Number(height));
}

/** 压完比原图还大就不用压缩版——宁可占点体积，也不要把图弄糊。 */
export function useCompressed(originalBytes, compressedBytes) {
  if (!Number.isFinite(compressedBytes) || compressedBytes <= 0) return false;
  return compressedBytes < originalBytes;
}

/**
 * 估算含图备份的体积（MB）。base64 比二进制大约 1/3，
 * 再加缩略图与 JSON 结构，用 1.4 的系数偏高估——导出前宁可说大一点。
 * 用 Array.isArray 而不是 `files ?? []`：后者只挡 null/undefined，传进来一个对象
 * （调用方读错了字段）会变成 `({}).reduce is not a function`，一句与图片毫无关系的报错。
 */
export function estimateBackupMB(files) {
  const list = Array.isArray(files) ? files : [];
  const bytes = list.reduce((s, f) => s + (Number(f?.size) || 0), 0);
  return Math.round((bytes * 1.4) / (1024 * 1024) * 10) / 10;
}
