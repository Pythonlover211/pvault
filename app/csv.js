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
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

export function decodeBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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
