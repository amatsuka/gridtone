import { useEffect } from 'react';
import { GridView } from './components/GridView';
import { ImportStatus } from './components/ImportStatus';
import { Toolbar } from './components/Toolbar';
import { api, connectStore, useAppStore } from './store';

export function App() {
  useEffect(() => connectStore(), []);
  const ready = useAppStore((state) => state.ready);
  const snapshot = useAppStore((state) => state.snapshot);

  return (
    <div className="app">
      <Toolbar snapshot={snapshot} />
      <ImportStatus />
      <main className="workspace">{ready && (snapshot ? <GridView snapshot={snapshot} /> : <Welcome />)}</main>
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
