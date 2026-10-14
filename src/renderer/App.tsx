import { useEffect } from 'react';
import { ExportDialog } from './components/ExportDialog';
import { GridView } from './components/GridView';
import { GroupsDialog } from './components/GroupsDialog';
import { ImportStatus } from './components/ImportStatus';
import { Inspector } from './components/Inspector';
import { PatternImport } from './components/PatternImport';
import { PhotoEditor } from './components/PhotoEditor';
import { Toolbar } from './components/Toolbar';
import { connectFixes } from './fixes';
import { connectLuts } from './luts';
import { connectMetrics } from './metrics';
import { connectShortcuts } from './shortcuts';
import { api, connectStore, useAppStore } from './store';

export function App() {
  useEffect(() => connectStore(), []);
  useEffect(() => connectShortcuts(), []);
  useEffect(() => connectLuts(), []);
  useEffect(() => connectMetrics(), []);
  useEffect(() => connectFixes(), []);
  const ready = useAppStore((state) => state.ready);
  const snapshot = useAppStore((state) => state.snapshot);
  const editorOpen = useAppStore((state) => state.editorSlotId !== null);
  const exportOpen = useAppStore((state) => state.exportOpen);
  const patternImportOpen = useAppStore((state) => state.patternImport !== null);

  return (
    <div className="app">
      {/* Под открытым редактором фото и импортом паттерна сетка и инспектор не получают ни фокуса, ни кликов. */}
      <div className="app-body" inert={editorOpen || exportOpen || patternImportOpen}>
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
      <PatternImport />
      <GroupsDialog />
      <ExportDialog />
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
