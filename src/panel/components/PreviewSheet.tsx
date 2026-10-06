/**
 * '수집 내용' 미리보기. 모델에 보낼 텍스트를 그대로 보여 주고, 전송 전이면 항목을 뺄 수 있다.
 */
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { analyzeSnapshot } from '../../shared/analysis';
import { estimateTokens, formatSnapshotForModel } from '../../shared/serialize';
import type { ElementSnapshot } from '../../shared/snapshot';
import { openPreview, toggleElementExclusion, updateExclusions } from '../actions';
import { draftKey, useStore } from '../store';
import { Switch } from './ui';

const ROLE_TEXT: Record<ElementSnapshot['role'], string> = {
  target: '대상',
  ancestor: '조상',
  child: '자식',
  sibling: '형제',
  offender: '넘침 후보',
};

export function PreviewSheet({ snapshotId }: { snapshotId: string }) {
  const snapshot = useStore((s) => s.snapshots[snapshotId]);
  const editable = useStore((s) => s.drafts[draftKey(s)]?.attachment?.id === snapshotId);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && openPreview(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const payload = useMemo(
    () => (snapshot ? formatSnapshotForModel(snapshot, snapshot.exclusions, analyzeSnapshot(snapshot)) : ''),
    [snapshot],
  );

  if (!snapshot) return null;
  const excluded = new Set(snapshot.exclusions.elementIds);
  const ex = snapshot.exclusions;

  return (
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && openPreview(null)}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label="전송 자료 미리보기">
        <header className="sheet-head">
          <h2>{editable ? '보낼 자료 미리보기' : '보낸 자료'}</h2>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={() => openPreview(null)}>
            <X size={16} />
          </button>
        </header>
        <div className="sheet-body">
          <p className="sheet-intro">
            {editable
              ? '질문과 함께 아래 텍스트가 선택한 AI 제공자에게 그대로 전송됩니다. 빼고 싶은 항목은 끄세요. 대상 요소는 뺄 수 없습니다.'
              : '이 질문과 함께 아래 텍스트를 보냈습니다.'}
          </p>
          <p className="sheet-stats">
            요소 {snapshot.elements.length - excluded.size}개 · 약 {estimateTokens(payload).toLocaleString('ko-KR')} 토큰(추정) · 수집 {new Date(snapshot.page.collectedAt).toLocaleString('ko-KR')}
          </p>
          {editable && (
            <div className="sheet-toggles">
              <Switch label="페이지 글 포함" description="요소 안 글의 앞부분" checked={!ex.text} onChange={(v) => updateExclusions(snapshot.id, { text: !v })} />
              <Switch label="HTML 속성 포함" description="class·id 외 role, href(경로만) 등" checked={!ex.attributes} onChange={(v) => updateExclusions(snapshot.id, { attributes: !v })} />
              <Switch label="페이지 주소 포함" description="쿼리 값과 해시는 원래 수집하지 않음" checked={!ex.pageUrl} onChange={(v) => updateExclusions(snapshot.id, { pageUrl: !v })} />
              <Switch label="페이지 제목 포함" checked={!ex.pageTitle} onChange={(v) => updateExclusions(snapshot.id, { pageTitle: !v })} />
            </div>
          )}
          <h3 className="sheet-subtitle">수집한 요소</h3>
          <ul className="element-list">
            {snapshot.elements.map((el) => (
              <li key={el.id} className={excluded.has(el.id) ? 'is-excluded' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.has(el.id)}
                    disabled={!editable || el.id === snapshot.targetId}
                    onChange={() => toggleElementExclusion(snapshot.id, el.id)}
                  />
                  <span className="el-id">{el.id}</span>
                  <span className="element-role">
                    {el.role === 'ancestor' && el.depth === 1 ? '부모' : ROLE_TEXT[el.role]}
                    {el.role === 'ancestor' && el.depth && el.depth > 1 ? ` ${el.depth}` : ''}
                  </span>
                  <code className="element-label">{el.label}</code>
                </label>
              </li>
            ))}
          </ul>
          {snapshot.limitations.length > 0 && (
            <>
              <h3 className="sheet-subtitle">수집 한계</h3>
              <ul className="limitation-list">
                {snapshot.limitations.map((limitation, index) => (
                  <li key={index}>{limitation.message}</li>
                ))}
              </ul>
            </>
          )}
          <div className="sheet-payload-head">
            <h3 className="sheet-subtitle">전송 텍스트</h3>
            <button
              type="button"
              className="chip-btn"
              onClick={() => void navigator.clipboard.writeText(payload).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} 복사
            </button>
          </div>
          <pre className="payload">{payload}</pre>
        </div>
      </section>
    </div>
  );
}
