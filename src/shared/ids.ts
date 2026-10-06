/** 보안 컨텍스트가 아닌 페이지(content script)에서도 쓸 수 있는 무작위 id */
export function makeId(prefix = ''): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = prefix;
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
