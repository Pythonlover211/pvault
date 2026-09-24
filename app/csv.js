// 两类「文件本身有问题」的错误码：界面据此给出可执行的处置办法，而不是把技术细节
// 或者几千条「时间无法识别」丢给用户。
export const UNCLOSED_QUOTE_CODE = 'UNCLOSED_QUOTE';
export const UTF16_CODE = 'UTF16_FILE';

function fileError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function parseCsv(text, { delimiter = ',' } = {}) {
  const src = stripBom(String(text ?? ''));
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    pushField();
    // 完全空白的行直接丢弃（导出文件里常见）
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  // 未闭合的引号必须当成文件级错误抛出来，不能悄悄收尾：一个多余的引号会把**后面所有行**
  // 都吞进同一个字段里（实测 5000 行的账单只剩 2 行、第 2 格 12 万字符），而预览页会一脸
  // 平静地说「将导入 1 条」——用户完全不知道剩下 4999 行去哪了。
  if (inQuotes) {
    throw fileError(UNCLOSED_QUOTE_CODE, `第 ${rows.length + 1} 行附近有没闭合的引号`);
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export function decodeBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // UTF-16 的 BOM 必须单独认出来：Excel 的「Unicode 文本」导出就是 FF FE + UTF-16LE。
  // 这种文件按严格 UTF-8 必然失败、回落 GBK 会解出一串问号方块，时间列也一起乱码，
  // 用户看到的是几千条「时间无法识别」，根本猜不到问题出在编码上。宁可现在就拦下来，
  // 告诉他该怎么办。
  if ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF)) {
    throw fileError(UTF16_CODE, '这是 UTF-16 格式的文件，请在 Excel 里另存为「CSV UTF-8(逗号分隔)」');
  }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  try {
    // fatal 让非法字节直接抛错，而不是塞进 U+FFFD——这是我们判断「不是 UTF-8」的依据
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      // 极少数环境没有 gbk 解码器：退回宽松 UTF-8，至少不让导入完全打不开
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}
