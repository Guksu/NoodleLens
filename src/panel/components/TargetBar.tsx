import { Crosshair, Globe, Lock, RefreshCw, ScanSearch, TriangleAlert } from 'lucide-react';
import { getTarget, type StoredSnapshot } from '../../shared/snapshot';
import { checkLive, highlight, recollect, requestAllSites, startPicking } from '../actions';
import { originOf } from '../format';
import { draftKey, shallowEqual, useStore, type LiveStatus } from '../store';

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
        <Globe size={13} aria-hidden="true" />
        <span className="page-title">{tab.title || '제목 없음'}</span>
        <span className="page-origin">{originOf(tab.url)}</span>
      </div>
    );
  }
  if (tab.access === 'restricted') {
    return (
      <div className="page-row is-muted">
        <Lock size={13} aria-hidden="true" />
        <span className="page-title">이 페이지(Chrome 내부·웹 스토어)에서는 요소를 선택할 수 없습니다</span>
      </div>
    );
  }
  return (
    <div className="page-row is-muted">
      <Lock size={13} aria-hidden="true" />
      <span className="page-title">
        이 탭은 아직 접근 권한이 없습니다. 툴바의 NoodleLens 아이콘을 누르면 허용됩니다.
      </span>
      <button type="button" className="link-btn" onClick={requestAllSites}>
        모든 사이트 허용
      </button>
    </div>
  );
}

export function TargetBar() {
  const { snapshot, draft } = useTargetSnapshot();
  const live = useStore((s) => (snapshot ? s.live[snapshot.id] : undefined));
  const picking = useStore((s) => s.picker.status !== 'idle');
  const tabId = useStore((s) => s.tab.tabId);

  const target = snapshot ? getTarget(snapshot) : null;
  const otherTab = snapshot && tabId !== null && snapshot.source.tabId !== tabId;
  const stale = live === 'detached' || live === 'page-gone' || live === 'unknown';

  return (
    <section className="target-bar" aria-label="분석 대상">
      <PageRow />
      {snapshot && target && (
        <div className={`target-card ${stale ? 'is-stale' : ''}`}>
          <div className="target-main">
            <span className="el-id">{target.id}</span>
            <code className="target-label" title={target.label}>
              {target.label}
            </code>
            <span className={`live live-${live ?? 'checking'}`} title={LIVE_TEXT[live ?? 'checking']}>
              {stale && <TriangleAlert size={12} aria-hidden="true" />}
              {LIVE_TEXT[live ?? 'checking']}
            </span>
          </div>
          <div className="target-meta">
            <span>
              {Math.round(target.rect.width * 10) / 10} × {Math.round(target.rect.height * 10) / 10}
            </span>
            <span>display: {target.styles.display}</span>
            {draft ? <span className="target-state">전송 대기</span> : <span className="target-state is-sent">이 대화의 대상</span>}
            {otherTab && <span className="target-state">다른 탭</span>}
          </div>
          {stale && (
            <p className="target-warning">
              {live === 'detached'
                ? '선택한 요소가 페이지에서 사라졌거나 다시 그려졌습니다. 다시 선택해 주세요.'
                : '수집한 페이지가 이동되었거나 새로 고쳐졌습니다. 지금 화면을 보려면 다시 선택해 주세요.'}
            </p>
          )}
          <div className="target-actions">
            <button type="button" className="chip-btn" onClick={() => void highlight(snapshot.id, snapshot.targetId)}>
              <ScanSearch size={13} aria-hidden="true" /> 페이지에서 보기
            </button>
            <button type="button" className="chip-btn" onClick={() => void startPicking()} disabled={picking}>
              <Crosshair size={13} aria-hidden="true" /> 다시 선택
            </button>
            <button
              type="button"
              className="chip-btn"
              onClick={() => void recollect(snapshot)}
              disabled={picking || live === 'page-gone'}
              title="같은 요소를 지금 상태로 다시 측정해 다음 질문에 첨부합니다"
            >
              <RefreshCw size={13} aria-hidden="true" /> 새로 수집
            </button>
            {live === undefined && (
              <button type="button" className="link-btn" onClick={() => void checkLive(snapshot.id)}>
                상태 확인
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
