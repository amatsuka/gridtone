import { useEffect } from 'react';
import { GridView } from './components/GridView';
import { GroupsDialog } from './components/GroupsDialog';
import { ImportStatus } from './components/ImportStatus';
import { Inspector } from './components/Inspector';
import { PhotoEditor } from './components/PhotoEditor';
import { Toolbar } from './components/Toolbar';
import { connectMetrics } from './metrics';
import { connectShortcuts } from './shortcuts';
import { api, connectStore, useAppStore } from './store';

export function App() {
  useEffect(() => connectStore(), []);
  useEffect(() => connectShortcuts(), []);
  useEffect(() => connectMetrics(), []);
  const ready = useAppStore((state) => state.ready);
  const snapshot = useAppStore((state) => state.snapshot);
  const editorOpen = useAppStore((state) => state.editorSlotId !== null);

  return (
    <div className="app">
      {/* Под открытым редактором фото сетка и инспектор не получают ни фокуса, ни кликов. */}
      <div className="app-body" inert={editorOpen}>
        <Toolbar snapshot={snapshot} />
        <ImportStatus />
        <main className="main">
          {ready &&
            (snapshot ? (
              <>
                <GridView snapshot={snapshot} />
                <Inspector />
              </>
            ) : (
              <Welcome />
            ))}
        </main>
      </div>
      <PhotoEditor />
      <GroupsDialog />
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>Gridtone</h1>
      <p>Сетка Instagram как одно изображение.</p>
      <div className="welcome-actions">
        <button className="primary" onClick={() => void api.invoke('project:create')}>
          Новый проект
        </button>
        <button onClick={() => void api.invoke('project:open')}>Открыть проект</button>
      </div>
    </div>
  );
}
