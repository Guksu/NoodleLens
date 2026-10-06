import { CircleCheck, CircleHelp, Info, Ruler, Scale } from 'lucide-react';
import { useMemo, useState } from 'react';
import { analyzeSnapshot, summarizeFindings, type Finding } from '../../shared/analysis';
import type { StoredSnapshot } from '../../shared/snapshot';
import { highlight } from '../actions';

const KIND_META: Record<Finding['kind'], { label: string; icon: typeof Info; className: string }> = {
  fact: { label: '측정 사실', icon: Ruler, className: 'kind-fact' },
  rule: { label: 'CSS 조건', icon: Scale, className: 'kind-rule' },
  hint: { label: '가능성', icon: CircleHelp, className: 'kind-hint' },
  ok: { label: '정상', icon: CircleCheck, className: 'kind-ok' },
  info: { label: '참고', icon: Info, className: 'kind-info' },
};

const ORDER: Finding['kind'][] = ['rule', 'fact', 'hint', 'info', 'ok'];

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
  const sorted = useMemo(() => [...findings].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)), [findings]);
  const summary = summarizeFindings(findings);
  const [open, setOpen] = useState(defaultOpen);
  const excluded = new Set(snapshot.exclusions.elementIds);

  return (
    <details className="findings" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="findings-title">{title}</span>
        <span className="findings-summary">
          {summary.issues > 0 && <span className="pill pill-issue">확인된 항목 {summary.issues}</span>}
          {summary.hints > 0 && <span className="pill pill-hint">가능성 {summary.hints}</span>}
          {summary.ok > 0 && <span className="pill pill-ok">정상 {summary.ok}</span>}
        </span>
      </summary>
      <p className="findings-note">
        수집값으로 일반 코드가 계산한 결과입니다. ‘가능성’은 원인 후보이며 확정이 아닙니다.
      </p>
      <ul className="finding-list">
        {sorted.map((finding, index) => {
          const meta = KIND_META[finding.kind];
          const Icon = meta.icon;
          const ids = [...new Set(finding.evidence.map((e) => e.elementId))];
          return (
            <li key={`${finding.code}-${index}`} className={`finding ${meta.className}`}>
              <Icon size={14} className="finding-icon" aria-hidden="true" />
              <div className="finding-body">
                <div className="finding-head">
                  <span className="finding-kind">{meta.label}</span>
                  <span className="finding-title">{finding.title}</span>
                </div>
                <p className="finding-detail">{finding.detail}</p>
                {ids.length > 0 && (
                  <div className="finding-evidence">
                    {ids.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={`cite ${excluded.has(id) ? 'is-excluded' : ''}`}
                        onClick={() => void highlight(snapshot.id, id)}
                        title={`${id} 페이지에서 보기${excluded.has(id) ? ' (전송에서 제외됨)' : ''}`}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
