import { useEffect, useRef, type RefObject } from 'react';
import type { ViewOutput } from '@core/color/view';
import type { ViewMode } from '@shared/view';
import { GridRenderer } from '../gl/GridRenderer';
import { useAppStore } from '../store';

/** Что шейдер делает после проходов в каждом режиме: только 3 и 4 меняют цвет на холсте. Так же и в редакторе фото. */
export function viewOutput(mode: ViewMode): ViewOutput {
  return mode === 'luminance' ? 'luminance' : mode === 'posterize' ? 'posterize' : 'color';
}

/**
 * Холст WebGL под DOM-сеткой. Рисует плитки по их координатам на экране и перерисовывается
 * при правке, прокрутке и изменении размеров. Если WebGL2 нет, переключает сетку на картинки.
 */
export function GridCanvas({
  scrollerRef,
  gridRef,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  gridRef: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: GridRenderer;
    try {
      renderer = new GridRenderer(canvas, () => gridRef.current);
    } catch (err) {
      console.error(err);
      useAppStore.setState({ renderMode: 'img' });
      return;
    }

    const sync = () => {
      const { snapshot, viewMode, showOriginal } = useAppStore.getState();
      renderer.setScene(
        snapshot ? { project: snapshot.project, assets: snapshot.assets, view: viewOutput(viewMode), original: showOriginal } : null,
      );
    };
    sync();
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (state.snapshot !== prev.snapshot || state.viewMode !== prev.viewMode || state.showOriginal !== prev.showOriginal) sync();
      // Превью перетаскивания переставляет плитки в DOM, холст рисует их на новых местах.
      else if (state.dragOrder !== prev.dragOrder) renderer.requestRender();
    });

    const render = () => renderer.requestRender();
    const scroller = scrollerRef.current;
    scroller?.addEventListener('scroll', render, { passive: true });
    window.addEventListener('resize', render);
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    if (gridRef.current) observer.observe(gridRef.current);

    return () => {
      unsubscribe();
      scroller?.removeEventListener('scroll', render);
      window.removeEventListener('resize', render);
      observer.disconnect();
      renderer.dispose();
    };
  }, [scrollerRef, gridRef]);

  return <canvas ref={canvasRef} className="grid-canvas" aria-hidden="true" />;
}
