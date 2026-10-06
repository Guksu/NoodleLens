/**
 * 스냅샷을 모델에 보낼 텍스트로 바꾼다.
 *
 * 페이지에서 온 문자열(제목, URL, 속성, 글, 클래스, computed 값의 문자열 등)은 모두
 * '<' '>'를 이스케이프해서 <page_snapshot> 경계를 흉내 낼 수 없게 한다.
 * 사용자가 제외한 요소·글·속성·URL은 넣지 않는다. 미리보기 화면도 이 결과를 그대로 보여 준다.
 */
import type { Finding } from './analysis';
import type { ElementSnapshot, Snapshot, SnapshotExclusions } from './snapshot';

const ROLE_LABEL: Record<ElementSnapshot['role'], string> = {
  target: '대상',
  ancestor: '조상',
  child: '자식',
  sibling: '형제',
  offender: '넘침 후보',
};

const KIND_LABEL: Record<Finding['kind'], string> = {
  fact: '측정 사실',
  rule: 'CSS 조건',
  hint: '가능성',
  ok: '정상',
  info: '참고',
};

export function escapeAngles(value: string): string {
  return value.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** 페이지 문자열을 따옴표로 감싸고 이스케이프한다 */
export function quote(value: string): string {
  return escapeAngles(JSON.stringify(value));
}

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function roleText(el: ElementSnapshot): string {
  let text = ROLE_LABEL[el.role];
  if (el.role === 'ancestor' && el.depth !== undefined) text = el.depth === 1 ? '부모' : `조상(${el.depth}단계 위)`;
  if (el.role === 'offender') {
    text = el.offenderOf === 'target' ? '대상 내부 넘침 후보' : '페이지 가로 넘침 후보';
    if (el.overflowPx !== undefined) text += ` ${n(el.overflowPx)}px 넘침`;
  }
  if (el.alsoRoles?.length) {
    text += ` / ${el.alsoRoles
      .map((role) => (role === 'offender' ? (el.offenderOf === 'target' ? '대상 내부 넘침 후보' : '페이지 가로 넘침 후보') : ROLE_LABEL[role]))
      .join(', ')}`;
  }
  return text;
}

function formatElement(el: ElementSnapshot, exclusions: SnapshotExclusions): string[] {
  const lines: string[] = [];
  const position = el.indexInParent ? `, 부모의 ${el.indexInParent}번째 자식` : '';
  lines.push(`[${el.id}] ${roleText(el)}: ${quote(el.label)}${position}`);
  const r = el.rect;
  const b = el.box;
  const offset = b.offsetWidth !== null && b.offsetHeight !== null ? ` | offset ${b.offsetWidth}×${b.offsetHeight}` : '';
  lines.push(
    `  rect: x=${n(r.x)} y=${n(r.y)} w=${n(r.width)} h=${n(r.height)} | client ${b.clientWidth}×${b.clientHeight} | scroll ${b.scrollWidth}×${b.scrollHeight}${offset}` +
      (b.scrollLeft || b.scrollTop ? ` | scrollLeft ${n(b.scrollLeft)} scrollTop ${n(b.scrollTop)}` : ''),
  );
  if (!exclusions.attributes) {
    const attrs = Object.entries(el.attributes)
      .filter(([name]) => name !== 'id' && name !== 'class')
      .map(([name, value]) => `${name}=${quote(value)}`);
    if (el.attributes.class) attrs.unshift(`class=${quote(el.attributes.class)}`);
    if (el.attributes.id) attrs.unshift(`id=${quote(el.attributes.id)}`);
    const omitted = el.omittedAttributeCount + (el.classOmittedCount ? 1 : 0);
    if (attrs.length || omitted) {
      lines.push(`  attrs: ${attrs.join(' ')}${omitted ? ` (그 밖의 속성 ${el.omittedAttributeCount}개 수집 안 함${el.classOmittedCount ? `, class ${el.classOmittedCount}개 생략` : ''})` : ''}`);
    }
  }
  if (exclusions.text && el.text.kind === 'text') {
    lines.push('  text: (사용자가 전송에서 제외)');
  } else if (el.text.kind === 'text') {
    lines.push(`  text: ${quote(el.text.value)}${el.text.truncated ? ' (앞부분만)' : ''}`);
  } else if (el.text.kind === 'excluded') {
    lines.push(`  text: (수집 안 함: ${el.text.reason})`);
  }
  const styles = Object.entries(el.styles)
    .map(([name, value]) => `${name}:${escapeAngles(value)}`)
    .join('; ');
  lines.push(`  style: ${styles}`);
  if (el.pseudo?.before) {
    lines.push(`  ::before: ${Object.entries(el.pseudo.before).map(([k, v]) => `${k}:${escapeAngles(v)}`).join('; ')}`);
  }
  if (el.pseudo?.after) {
    lines.push(`  ::after: ${Object.entries(el.pseudo.after).map(([k, v]) => `${k}:${escapeAngles(v)}`).join('; ')}`);
  }
  if (el.image) {
    const img = el.image;
    lines.push(
      `  image: natural ${img.naturalWidth}×${img.naturalHeight}, complete=${img.complete}, width속성=${img.hasWidthAttr ? '있음' : '없음'}, height속성=${img.hasHeightAttr ? '있음' : '없음'}` +
        (img.src && !exclusions.attributes ? `, src=${quote(img.src)}` : ''),
    );
  }
  const flags = Object.entries(el.flags)
    .filter(([, value]) => value)
    .map(([key, value]) => (value === true ? key : `${key}=${String(value)}`));
  if (flags.length) lines.push(`  flags: ${flags.join(', ')}`);
  lines.push(`  자식 요소 수: ${el.childElementCount}, 수집 상세도: ${el.detail}`);
  return lines;
}

export function referencedIds(finding: Finding): string[] {
  const ids = new Set(finding.evidence.map((e) => e.elementId));
  for (const match of `${finding.title} ${finding.detail}`.matchAll(/\[(E\d+)\]/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export function visibleFindings(findings: Finding[], exclusions: SnapshotExclusions): Finding[] {
  if (exclusions.elementIds.length === 0) return findings;
  const excluded = new Set(exclusions.elementIds);
  return findings.filter((finding) => !referencedIds(finding).some((id) => excluded.has(id)));
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return '(해당 없음)';
  return findings
    .map((f) => {
      const evidence = f.evidence
        .map((e) => (e.property ? `${e.elementId} ${e.property}${e.value !== undefined ? `=${escapeAngles(e.value)}` : ''}` : e.elementId))
        .join(', ');
      return `- [${KIND_LABEL[f.kind]}] ${escapeAngles(f.title)}: ${escapeAngles(f.detail)}${evidence ? ` (근거: ${evidence})` : ''}`;
    })
    .join('\n');
}

export function formatSnapshotForModel(snapshot: Snapshot, exclusions: SnapshotExclusions, findings: Finding[]): string {
  const excluded = new Set(exclusions.elementIds);
  const page = snapshot.page;
  const lines: string[] = [];
  lines.push(`<page_snapshot id="${snapshot.id}" collected_at="${page.collectedAt}">`);
  lines.push(
    `페이지 제목: ${exclusions.pageTitle ? '(사용자가 제외)' : quote(page.title)}` +
      ` | URL: ${exclusions.pageUrl ? '(사용자가 제외)' : `${quote(page.url)}${page.urlRedacted ? ' (쿼리 값·해시는 수집하지 않음)' : ''}`}`,
  );
  const vp = page.viewport;
  lines.push(
    `뷰포트: inner ${vp.innerWidth}×${vp.innerHeight}, documentElement client ${vp.clientWidth}×${vp.clientHeight}, DPR ${vp.dpr}, 스크롤 x=${n(page.scroll.x)} y=${n(page.scroll.y)}`,
  );
  const doc = page.document;
  lines.push(
    `문서 스크롤 영역: scrollWidth ${doc.scrollWidth} / clientWidth ${doc.clientWidth} (가로 넘침 ${doc.hasHorizontalOverflow ? '있음' : '없음'}), scrollHeight ${doc.scrollHeight} / clientHeight ${doc.clientHeight}, ${doc.compatMode}`,
  );
  lines.push('');
  for (const el of snapshot.elements) {
    if (excluded.has(el.id) && el.id !== snapshot.targetId) continue;
    lines.push(...formatElement(el, exclusions));
  }
  const omitted = snapshot.omitted;
  const omittedParts = [
    omitted.ancestors && `조상 ${omitted.ancestors}개`,
    omitted.children && `자식 ${omitted.children}개`,
    omitted.siblings && `형제 ${omitted.siblings}개`,
    omitted.offenders && `넘침 후보 ${omitted.offenders}개`,
    excluded.size && `사용자가 제외한 요소 ${excluded.size}개`,
  ].filter(Boolean);
  lines.push('');
  lines.push(
    `수집 상한: 조상 ${snapshot.limits.maxAncestors}(+body·html), 자식 ${snapshot.limits.maxChildren}, 형제 ${snapshot.limits.maxSiblings}, 넘침 후보 ${snapshot.limits.maxOffenders}. 생략: ${omittedParts.length ? omittedParts.join(', ') : '없음'}`,
  );
  if (snapshot.limitations.length) {
    lines.push(`수집 한계: ${snapshot.limitations.map((l) => `${l.elementId ? `[${l.elementId}] ` : ''}${l.message}`).join(' / ')}`);
  }
  lines.push('</page_snapshot>');
  lines.push('');
  lines.push('<rule_checks>');
  lines.push(formatFindings(visibleFindings(findings, exclusions)));
  lines.push('</rule_checks>');
  return lines.join('\n');
}

/** 대략적인 토큰 수. 한글은 영문보다 토큰이 많이 든다. 표시용 추정치다. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3.6 + other / 1.2);
}
