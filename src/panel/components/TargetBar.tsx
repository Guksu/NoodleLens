import { Eye, Globe, Lock, RefreshCw } from 'lucide-react';
import { getTarget, type StoredSnapshot } from '../../shared/snapshot';
import { checkLive, highlight, recollect, requestAllSites } from '../actions';
import { originOf } from '../format';
import { draftKey, shallowEqual, useStore, type LiveStatus } from '../store';
import { IconButton } from './ui';

/**
 * 지금 대상(페이지·요소)을 입력창 맨 위 한 곳에 보인다 — 범용 채팅 화면처럼 머리 아래에 정보 줄을 쌓지 않는다.
 * 보낼 첨부가 있으면 첨부 줄(Composer의 AttachmentRow)이 이 자리를 쓰고, 여기서는 보낸 뒤의 대상과 페이지만 맡는다.
 */

export const LIVE_TEXT: Record<LiveStatus, string> = {
  connected: '페이지에 있음',
  detached: '요소가 사라짐',
  unknown: '확인 불가',
  'page-gone': '페이지 이동됨',
  checking: '확인 중',
};

export function useTargetSnapshot(): { snapshot: StoredSnapshot | null; draft: boolean } {
  return useStore((s) => {
    const key = draftKey(s);
    const attachment = s.drafts[key]?.attachment ?? null;
    if (attachment) return { snapshot: attachment, draft: true };
    const conversation = s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined;
    const last = conversation?.lastSnapshotId ? s.snapshots[conversation.lastSnapshotId] : undefined;
    return { snapshot: last ?? null, draft: false };
  }, shallowEqual);
}

/** 대상의 연결 상태 — 페이지에 그대로 있으면 아무것도 보이지 않고, 끊겼을 때만 글자와 '다시 확인'을 보인다 */
export function LiveStatusText({ snapshot }: { snapshot: StoredSnapshot }) {
  const live = useStore((s) => s.live[snapshot.id]);
  const status = live ?? 'checking';
  if (status === 'connected') return <span className="live live-connected sr-only">{LIVE_TEXT[status]}</span>;
  const stale = status === 'detached' || status === 'page-gone' || status === 'unknown';
  return (
    <>
      <span className={`live live-${status}`}>{LIVE_TEXT[status]}</span>
      {stale && (
        <button type="button" className="link-btn" onClick={() => void checkLive(snapshot.id)}>
          다시 확인
        </button>
      )}
    </>
  );
}

/** 페이지 줄 — 대상이 없을 때 무엇을 고르게 되는지, 접근할 수 없을 때 왜 못 고르는지 알린다 */
export function PageRow() {
  const tab = useStore((s) => s.tab);
  if (tab.access === 'granted') {
    return (
      <div className="page-row" title={tab.url}>
        <Globe size={12} aria-hidden="true" />
        <span className="page-title">{tab.title || '제목 없음'}</span>
        <span className="page-origin">{originOf(tab.url)}</span>
      </div>
    );
  }
  if (tab.access === 'restricted') {
    return (
      <div className="page-row is-muted">
        <Lock size={12} aria-hidden="true" />
        <span className="page-title">이 페이지(Chrome 내부·웹 스토어)에서는 요소를 선택할 수 없습니다</span>
      </div>
    );
  }
  return (
    <div className="page-row is-muted">
      <Lock size={12} aria-hidden="true" />
      <span className="page-title">이 탭은 접근 권한이 없습니다. 툴바의 NoodleLens 아이콘을 누르면 허용됩니다.</span>
      <button type="button" className="link-btn" onClick={requestAllSites}>
        모든 사이트 허용
      </button>
    </div>
  );
}

/** 보낸 뒤의 대상 — 선택자 한 줄 + 크기·상태 한 줄, 동작은 페이지에서 보기·새로 수집 둘. 다시 고르기는 입력창의 '요소 선택' 하나로 한다 */
export function TargetRow({ snapshot }: { snapshot: StoredSnapshot }) {
  const live = useStore((s) => s.live[snapshot.id]);
  const picking = useStore((s) => s.picker.status !== 'idle');
  const target = getTarget(snapshot);
  const stale = live === 'detached' || live === 'page-gone' || live === 'unknown';
  return (
    <div className={`target-row ${stale ? 'is-stale' : ''}`} aria-label="분석 대상">
      <span className="target-text">
        <code className="target-label" title={target.label}>
          {target.label}
        </code>
        <span className="target-meta">
          <span className="target-dims">
            {Math.round(target.rect.width * 10) / 10} × {Math.round(target.rect.height * 10) / 10} · {target.styles.display}
          </span>
          <LiveStatusText snapshot={snapshot} />
        </span>
      </span>
      <span className="context-actions">
        <IconButton label="페이지에서 보기" className="sm" onClick={() => void highlight(snapshot.id, snapshot.targetId)}>
          <Eye size={14} />
        </IconButton>
        <IconButton
          label="새로 수집 — 같은 요소를 지금 상태로 다시 재서 다음 질문에 첨부"
          className="sm"
          onClick={() => void recollect(snapshot)}
          disabled={picking || live === 'page-gone'}
        >
          <RefreshCw size={13} />
        </IconButton>
      </span>
    </div>
  );
}
