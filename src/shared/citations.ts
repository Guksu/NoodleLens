/**
 * 답변 속 근거 식별자([E3], [E1, E4]) 파싱과 검증.
 * 실제 수집 자료에 없는 식별자는 '확인되지 않은 참조'로 표시한다.
 */

const CITATION = /\[(E\d{1,5}(?:\s*,\s*E\d{1,5})*)\]/g;

export type CitationPart = string | { ids: string[] };

export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push({ ids: (match[1] ?? '').split(/\s*,\s*/) });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 코드 블록·인라인 코드를 뺀 본문에서 인용한 식별자 */
export function extractCitations(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const ids: string[] = [];
  for (const part of splitCitations(withoutCode)) {
    if (typeof part === 'string') continue;
    for (const id of part.ids) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function validateCitations(markdown: string, knownIds: ReadonlySet<string>) {
  const cited = extractCitations(markdown);
  return {
    cited,
    valid: cited.filter((id) => knownIds.has(id)),
    unknown: cited.filter((id) => !knownIds.has(id)),
  };
}
