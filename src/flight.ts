// Next.js RSC flight 数据解析。
// gundam-official.com 是 App Router 站点，页面数据嵌在
// self.__next_f.push([1,"..."]) 的分片字符串里，拼起来才是完整数据流。

// 把 HTML 里所有 flight 分片解转义并拼接成完整文本
export function flightText(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      parts.push(JSON.parse('"' + m[1] + '"'));
    } catch {
      // 单个分片坏了就跳过
    }
  }
  return parts.join('');
}

// 提取 `"key":` 后面的平衡 {} / [] 片段并 JSON.parse
export function jsonAfterKey(text: string, key: string): any | null {
  const anchor = `"${key}":`;
  const i = text.indexOf(anchor);
  if (i < 0) return null;
  let j = i + anchor.length;
  while (j < text.length && text[j] !== '{' && text[j] !== '[') j++;
  if (j >= text.length) return null;
  const frag = balanced(text, j);
  if (!frag) return null;
  try {
    return JSON.parse(frag);
  } catch {
    return null;
  }
}

function balanced(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// 解析 "$25" 这类引用：正文存在 `25:T<hex>,` 文本块里，
// T 后面的 16 进制长度是 UTF-8 字节数（不是字符数），要按字节截取
export function resolveRef(text: string, ref: string): string | null {
  if (!ref.startsWith('$')) return ref; // 内联字符串直接用
  const id = ref.slice(1);
  const m = new RegExp('(?:^|\\n)' + id + ':T([0-9a-f]+),').exec(text);
  if (!m) return null;
  const nBytes = parseInt(m[1], 16);
  const start = m.index + m[0].length;
  let bytes = 0;
  let i = start;
  while (i < text.length && bytes < nBytes) {
    const cp = text.codePointAt(i)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return text.slice(start, i);
}
