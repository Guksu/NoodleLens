import { Crosshair, Eye, Globe, Lock, RefreshCw, TriangleAlert } from 'lucide-react';
import { getTarget, type StoredSnapshot } from '../../shared/snapshot';
import { checkLive, highlight, recollect, requestAllSites, startPicking } from '../actions';
import { originOf } from '../format';
import { draftKey, shallowEqual, useStore, type LiveStatus } from '../store';
import { IconButton } from './ui';

const LIVE_TEXT: Record<LiveStatus, string> = {
  connected: '페이지에 있음',
  detached: '요소가 사라짐',
  unknown: '확인 불가',
  'page-gone': '페이지 이동됨',
  checking: '확인 중',
};

function useTargetSnapshot(): { snapshot: StoredSnapshot | null; draft: boolean } {
  return useStore((s) => {
    const key = draftKey(s);
    const attachment = s.drafts[key]?.attachment ?? null;
    if (attachment) return { snapshot: attachment, draft: true };
    const conversation = s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined;
    const last = conversation?.lastSnapshotId ? s.snapshots[conversation.lastSnapshotId] : undefined;
    return { snapshot: last ?? null, draft: false };
  }, shallowEqual);
}

function PageRow() {
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

export function TargetBar() {
  const { snapshot } = useTargetSnapshot();
  const live = useStore((s) => (snapshot ? s.live[snapshot.id] : undefined));
  const picking = useStore((s) => s.picker.status !== 'idle');

  const target = snapshot ? getTarget(snapshot) : null;
  const status = live ?? 'checking';
  const stale = live === 'detached' || live === 'page-gone' || live === 'unknown';

  return (
    <section className="context" aria-label="분석 대상">
      <PageRow />
      {snapshot && target && (
        <div className={`target-row ${stale ? 'is-stale' : ''}`}>
          <span className="el-id">{target.id}</span>
          <span className="target-text">
            <span className="target-line">
              <code className="target-label" title={target.label}>
                {target.label}
              </code>
              <span className={`live live-${status}`} title={LIVE_TEXT[status]}>
                {status === 'connected' ? <span className="sr-only">{LIVE_TEXT[status]}</span> : LIVE_TEXT[status]}
              </span>
            </span>
            <span className="target-dims">
              {Math.round(target.rect.width * 10) / 10} × {Math.round(target.rect.height * 10) / 10} · display: {target.styles.display}
            </span>
          </span>
          <span className="context-actions">
            <IconButton label="페이지에서 보기" className="sm" onClick={() => void highlight(snapshot.id, snapshot.targetId)}>
              <Eye size={14} />
            </IconButton>
            <IconButton label="다시 선택" className="sm" onClick={() => void startPicking()} disabled={picking}>
              <Crosshair size={14} />
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
      )}
      {snapshot && stale && (
        <p className="target-warning">
          <TriangleAlert size={12} aria-hidden="true" />
          {live === 'detached'
            ? '요소가 페이지에서 사라졌거나 다시 그려졌습니다. 다시 선택해 주세요.'
            : live === 'unknown'
              ? '이전 수집 정보를 찾을 수 없습니다. 다시 선택해 주세요.'
              : '수집한 페이지가 이동되었거나 새로 고쳐졌습니다. 지금 화면을 보려면 다시 선택해 주세요.'}
          <button type="button" className="link-btn" onClick={() => void checkLive(snapshot.id)}>
            다시 확인
          </button>
        </p>
      )}
    </section>
  );
}
