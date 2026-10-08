/**
 * '수집 내용' 미리보기. 모델에 보낼 텍스트를 그대로 보여 주고, 전송 전이면 항목을 뺄 수 있다.
 * 네이티브 <dialog>.showModal()이라 포커스 가두기·배경 inert·Esc·닫은 뒤 포커스 복귀는 브라우저가 맡는다.
 * 닫을 때만 퇴장 애니메이션(data-closing)이 끝난 뒤 close()하고 상태를 비운다.
 */
import { Check, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { analyzeSnapshot } from '../../shared/analysis';
import { estimateTokens, formatSnapshotForModel } from '../../shared/serialize';
import type { ElementSnapshot } from '../../shared/snapshot';
import { openPreview, toggleElementExclusion, updateExclusions } from '../actions';
import { draftKey, useStore } from '../store';
import { Switch } from './ui';

/** animationend가 오지 않는 환경(애니메이션 꺼짐 등)에서 닫힘을 보장하는 상한 */
const CLOSE_FALLBACK_MS = 500;

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);

  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog.removeEventListener('animationend', onEnd);
      dialog.close();
      openPreview(null);
    };
    // 안쪽 요소의 animationend도 올라오므로 dialog 자신의 것만 받는다.
    const onEnd = (event: AnimationEvent) => event.target === dialog && finish();
    dialog.setAttribute('data-closing', '');
    dialog.addEventListener('animationend', onEnd);
    window.setTimeout(finish, CLOSE_FALLBACK_MS);
  }, []);

  const hasSnapshot = Boolean(snapshot);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Esc: 브라우저가 바로 닫기 전에 가로채 퇴장 애니메이션을 거친다.
    const onCancel = (event: Event) => {
      event.preventDefault();
      requestClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [hasSnapshot, requestClose]);

  // ::backdrop을 누르면 대상이 dialog 자신이다. 시트 안쪽을 누르면 자식이 대상이다.
  const onBackdrop = (event: MouseEvent<HTMLDialogElement>) => event.target === event.currentTarget && requestClose();

  const payload = useMemo(
    () => (snapshot ? formatSnapshotForModel(snapshot, snapshot.exclusions, analyzeSnapshot(snapshot)) : ''),
    [snapshot],
  );

  if (!snapshot) return null;
  const excluded = new Set(snapshot.exclusions.elementIds);
  const ex = snapshot.exclusions;

  return (
    <dialog ref={dialogRef} className="sheet" aria-labelledby="sheet-title" onClick={onBackdrop}>
      <div className="sheet-frame">
        <header className="sheet-head">
          <h2 id="sheet-title">{editable ? '보낼 자료 미리보기' : '보낸 자료'}</h2>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={requestClose}>
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
                  {/* layout-audit-ignore: nested-card — E번호는 상자가 아니라 페이지 요소를 가리키는 배지다 */}
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
          {/* layout-audit-ignore: nested-card — 모델에 보내는 원문을 다른 글과 구분하는 코드 블록 면이다 */}
          <pre className="payload">{payload}</pre>
        </div>
      </div>
    </dialog>
  );
}
