/** 문자열 정리·자르기와 URL 축약. content script와 패널이 함께 쓴다. */

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

export function clip(value: string, max: number): string {
  return truncate(value, max).value;
}

export interface SanitizedUrl {
  url: string;
  /** 쿼리 값·해시·사용자 정보 등을 지웠는지 */
  redacted: boolean;
}

const MAX_QUERY_KEYS = 10;

/**
 * 모델에 보낼 URL을 만든다. origin + pathname만 남기고
 * 쿼리는 키만, 해시와 사용자 정보는 지운다(토큰이 들어 있을 수 있음).
 */
export function sanitizeUrl(raw: string, base?: string): SanitizedUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    return { url: '[해석할 수 없는 URL]', redacted: true };
  }
  const scheme = parsed.protocol;
  if (scheme === 'data:' || scheme === 'blob:' || scheme === 'javascript:') {
    return { url: `${scheme}[생략]`, redacted: true };
  }
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'file:') {
    return { url: clip(`${scheme}//${parsed.host}${parsed.pathname}`, 200), redacted: true };
  }
  let redacted = Boolean(parsed.username || parsed.password || parsed.hash);
  let out = scheme === 'file:' ? `file://${parsed.pathname}` : `${parsed.origin}${parsed.pathname}`;
  const keys = [...new Set(parsed.searchParams.keys())];
  if (keys.length > 0) {
    redacted = true;
    const shown = keys.slice(0, MAX_QUERY_KEYS).map((key) => `${clip(key, 40)}=…`);
    if (keys.length > MAX_QUERY_KEYS) shown.push('…');
    out += `?${shown.join('&')}`;
  }
  const clipped = truncate(out, 300);
  return { url: clipped.value, redacted: redacted || clipped.truncated };
}

/** API 키처럼 보이는 문자열을 가린다. 오류 메시지·로그에 키가 섞이는 것을 막는다. */
export function maskSecrets(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, (m) => `${m.slice(0, 7)}…(가림)`)
    .replace(/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 3)}…(가림)`)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1…(가림)');
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('ko-KR').format(value);
}
