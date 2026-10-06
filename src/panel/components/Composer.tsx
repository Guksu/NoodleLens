import { ArrowUp, Crosshair, Eye, FileText, Square, X } from 'lucide-react';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import { analyzeSnapshot } from '../../shared/analysis';
import { estimateTokens, formatSnapshotForModel } from '../../shared/serialize';
import { getTarget, type StoredSnapshot } from '../../shared/snapshot';
import { PROVIDERS } from '../../providers/registry';
import {
  cancel,
  cancelPicking,
  highlight,
  isConversationBusy,
  openPreview,
  providerReady,
  removeAttachment,
  send,
  setDraftText,
  setView,
  startPicking,
} from '../actions';
import { draftKey, useStore } from '../store';
import { Toasts } from './Toasts';

const EXAMPLES = [
  '이 텍스트가 왜 말줄임되지 않을까?',
  '이 요소 때문에 가로 스크롤이 생기는 걸까?',
  '이 요소가 부모의 가운데에 오지 않는 이유가 뭘까?',
  '이 이미지 때문에 레이아웃이 밀리는 걸까?',
];

function AttachmentCard({ snapshot }: { snapshot: StoredSnapshot }) {
  const target = getTarget(snapshot);
  const tokens = useMemo(
    () => estimateTokens(formatSnapshotForModel(snapshot, snapshot.exclusions, analyzeSnapshot(snapshot))),
    [snapshot],
  );
  const excludedCount = snapshot.exclusions.elementIds.length;
  return (
    <div className="attach-card" aria-label="이번 질문에 첨부되는 자료">
      <div className="attach-card-head">
        <FileText size={14} aria-hidden="true" />
        <span className="attach-card-title">이번 질문에 첨부</span>
        <span className="attach-card-meta">
          요소 {snapshot.elements.length - excludedCount}개 · 약 {tokens.toLocaleString('ko-KR')} 토큰
          {excludedCount > 0 && ` · 제외 ${excludedCount}`}
        </span>
      </div>
      <code className="attach-card-label" title={target.label}>
        {target.label}
      </code>
      <div className="attach-card-sub">
        크기 {Math.round(target.rect.width * 10) / 10} × {Math.round(target.rect.height * 10) / 10} / display: {target.styles.display}
      </div>
      <div className="attach-card-actions">
        <button type="button" className="chip-btn" onClick={() => void highlight(snapshot.id, snapshot.targetId)}>
          <Eye size={13} aria-hidden="true" /> 페이지에서 보기
        </button>
        <button type="button" className="chip-btn" onClick={() => openPreview(snapshot.id)}>
          <FileText size={13} aria-hidden="true" /> 수집 내용
        </button>
        <button type="button" className="chip-btn" onClick={() => removeAttachment()} title="이번 질문에서 이 자료를 빼고 보냅니다">
          <X size={13} aria-hidden="true" /> 제외
        </button>
      </div>
    </div>
  );
}

export function Composer() {
  const key = useStore((s) => draftKey(s));
  const draft = useStore((s) => s.drafts[draftKey(s)]);
  const picker = useStore((s) => s.picker);
  const busy = useStore((s) => isConversationBusy(s, s.activeId));
  const access = useStore((s) => s.tab.access);
  const provider = useStore((s) => (s.activeId ? s.conversations.find((c) => c.id === s.activeId)?.provider : undefined) ?? s.newChat.provider);
  const ready = useStore((s) => providerReady(s, provider));
  const hasMessages = useStore((s) => Boolean(s.activeId && (s.messages[s.activeId]?.length ?? 0) > 0));
  const hasTarget = useStore((s) => Boolean(s.drafts[draftKey(s)]?.attachment || (s.activeId && s.conversations.find((c) => c.id === s.activeId)?.lastSnapshotId)));
  const activeId = useStore((s) => s.activeId);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const text = draft?.text ?? '';
  const attachment = draft?.attachment ?? null;
  const picking = picker.status !== 'idle';
  // 선택 중에 보내면 새 대화의 요소 번호와 선택 결과가 엇갈릴 수 있어 선택을 마친 뒤 보낸다.
  const canSend = text.trim().length > 0 && !busy && ready && !picking;

  const submit = () => {
    if (!canSend) return;
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 입력 조합 중 Enter는 글자 확정이므로 보내지 않는다.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  let hint = '';
  if (!ready) hint = `${PROVIDERS[provider].shortLabel} API 키가 필요합니다`;
  else if (picking) hint = '요소 선택을 마치면 보낼 수 있습니다';
  else if (busy) hint = '답변 생성 중 · 중단하거나 다른 대화를 볼 수 있습니다';
  else if (!hasTarget) hint = '요소를 선택하면 실제 값을 근거로 답합니다';

  return (
    <footer className="composer">
      <Toasts placement="inline" />
      {picking && (
        <div className="picking-banner" role="status">
          <Crosshair size={14} aria-hidden="true" />
          <span>
            {picker.status === 'starting' ? '선택 모드를 준비하는 중…' : '페이지에서 요소를 클릭하세요 · ↑ 부모 · Esc 취소'}
          </span>
          <button type="button" className="link-btn" onClick={cancelPicking}>
            취소
          </button>
        </div>
      )}
      {attachment && <AttachmentCard snapshot={attachment} />}
      {attachment && !hasMessages && !text && (
        <div className="examples" aria-label="질문 예시">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="example-chip"
              onClick={() => {
                setDraftText(example);
                textRef.current?.focus();
              }}
            >
              {example}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={textRef}
          key={key}
          className="composer-input"
          value={text}
          placeholder={attachment || hasTarget ? '선택한 요소에 대해 질문하세요' : '질문을 입력하세요 (먼저 요소를 선택하면 더 정확합니다)'}
          aria-label="질문 입력"
          rows={1}
          onChange={(event) => setDraftText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          {picking ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={cancelPicking}>
              <X size={14} aria-hidden="true" />
              <span className="btn-label">선택 취소</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void startPicking()}
              disabled={access === 'restricted' || access === 'none'}
              title={access === 'unknown' ? '이 탭 접근 권한이 필요할 수 있습니다' : '페이지에서 요소 선택'}
            >
              <Crosshair size={14} aria-hidden="true" />
              <span className="btn-label">요소 선택</span>
            </button>
          )}
          <span className="composer-hint">
            {hint}
            {!ready && (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={() => setView('settings')}>
                  설정
                </button>
              </>
            )}
          </span>
          {busy && activeId ? (
            <button type="button" className="send-btn is-stop" onClick={() => cancel(activeId)} aria-label="응답 생성 중단" title="응답 생성 중단">
              <Square size={13} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="send-btn" onClick={submit} disabled={!canSend} aria-label="보내기" title="보내기 (Enter)">
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
