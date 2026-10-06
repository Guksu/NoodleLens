import { ConsentGate } from './components/ConsentGate';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { HistoryView } from './components/HistoryView';
import { MessageList } from './components/MessageList';
import { PreviewSheet } from './components/PreviewSheet';
import { SettingsView } from './components/SettingsView';
import { TargetBar } from './components/TargetBar';
import { Toasts } from './components/Toasts';
import { useStore } from './store';

export function App() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const consented = useStore((s) => s.settings.consentAt !== null);
  const view = useStore((s) => s.view);
  const preview = useStore((s) => s.previewSnapshotId);

  if (!ready) return <div className="app app-loading" aria-busy="true" />;
  if (loadError) {
    return (
      <div className="app app-error" role="alert">
        <p>저장소를 열지 못했습니다.</p>
        <code>{loadError}</code>
      </div>
    );
  }
  if (!consented) return <ConsentGate />;

  return (
    <div className="app">
      <Header />
      {view === 'chat' && (
        <>
          <TargetBar />
          <MessageList />
          <Composer />
        </>
      )}
      {view === 'history' && <HistoryView />}
      {view === 'settings' && <SettingsView />}
      {preview && <PreviewSheet snapshotId={preview} />}
      <Toasts />
    </div>
  );
}
