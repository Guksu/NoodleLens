/**
 * 기본 검사 결과. 항목은 한 줄 제목 + 근거 값 한 줄로 보여 주고, 누르면 설명을 펼친다.
 * 색은 등급(문제·가능성·정상·참고)에만 쓴다. '측정 사실'도 문제를 나타내면 '문제'로 묶는다.
 */
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { analyzeSnapshot, type Finding } from '../../shared/analysis';
import type { StoredSnapshot } from '../../shared/snapshot';
import { highlight } from '../actions';

type Severity = 'issue' | 'hint' | 'info' | 'ok';

const SEVERITY: Record<Finding['kind'], Severity> = { fact: 'issue', rule: 'issue', hint: 'hint', info: 'info', ok: 'ok' };
const SEVERITY_LABEL: Record<Severity, string> = { issue: '문제', hint: '가능성', info: '참고', ok: '정상' };
const KIND_LABEL: Record<Finding['kind'], string> = {
  fact: '측정 사실',
  rule: 'CSS 조건',
  hint: '가능성 — 확인 필요',
  ok: '정상',
  info: '참고',
};
const ORDER: Severity[] = ['issue', 'hint', 'info', 'ok'];

function propsLine(finding: Finding): string {
  return finding.evidence
    .filter((e) => e.property)
    .slice(0, 3)
    .map((e) => `${e.elementId} ${e.property}: ${e.value ?? '—'}`)
    .join(' · ');
}

function FindingRow({ finding, snapshotId, excluded }: { finding: Finding; snapshotId: string; excluded: Set<string> }) {
  const [open, setOpen] = useState(false);
  const severity = SEVERITY[finding.kind];
  const ids = [...new Set(finding.evidence.map((e) => e.elementId))];
  const props = propsLine(finding);
  return (
    <li className={`finding sev-${severity} ${open ? 'is-open' : ''}`}>
      <button type="button" className="finding-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="dot" aria-label={SEVERITY_LABEL[severity]} />
        <span className="finding-main">
          <span className="finding-title">{finding.title}</span>
          {props && <span className="finding-props">{props}</span>}
        </span>
      </button>
      {ids.length > 0 && (
        <span className="finding-ids">
          {ids.slice(0, 3).map((id) => (
            <button
              key={id}
              type="button"
              className={`cite ${excluded.has(id) ? 'is-excluded' : ''}`}
              onClick={() => void highlight(snapshotId, id)}
              title={`${id} 페이지에서 보기${excluded.has(id) ? ' (전송에서 제외됨)' : ''}`}
            >
              {id}
            </button>
          ))}
        </span>
      )}
      {open && (
        <p className="finding-detail">
          <span className="finding-kind">{KIND_LABEL[finding.kind]}</span> {finding.detail}
        </p>
      )}
    </li>
  );
}

export function FindingsCard({
  snapshot,
  title,
  defaultOpen = false,
}: {
  snapshot: StoredSnapshot;
  title: string;
  defaultOpen?: boolean;
}) {
  const findings = useMemo(() => analyzeSnapshot(snapshot), [snapshot]);
  const sorted = useMemo(
    () => [...findings].sort((a, b) => ORDER.indexOf(SEVERITY[a.kind]) - ORDER.indexOf(SEVERITY[b.kind])),
    [findings],
  );
  const counts = useMemo(() => {
    const out: Record<Severity, number> = { issue: 0, hint: 0, info: 0, ok: 0 };
    for (const f of findings) out[SEVERITY[f.kind]] += 1;
    return out;
  }, [findings]);
  const [open, setOpen] = useState(defaultOpen);
  const excluded = new Set(snapshot.exclusions.elementIds);

  return (
    <section className={`findings ${open ? 'is-open' : ''}`}>
      <button type="button" className="findings-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="findings-title">{title}</span>
        <span className="findings-summary">
          {(['issue', 'hint', 'ok'] as Severity[])
            .filter((s) => counts[s] > 0)
            .map((s) => (
              <span key={s} className={`sev sev-${s}`}>
                {SEVERITY_LABEL[s]} {counts[s]}
              </span>
            ))}
        </span>
        <ChevronDown size={14} className="findings-chevron" aria-hidden="true" />
      </button>
      {open && (
        <>
          <ul className="finding-list">
            {sorted.map((finding, index) => (
              <FindingRow key={`${finding.code}-${index}`} finding={finding} snapshotId={snapshot.id} excluded={excluded} />
            ))}
          </ul>
          <p className="findings-note">측정값으로 계산한 결과입니다. ‘가능성’은 원인 후보이며 확정이 아닙니다. 항목을 누르면 설명이 펼쳐집니다.</p>
        </>
      )}
    </section>
  );
}
