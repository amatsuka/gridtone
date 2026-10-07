import { useEffect, useRef, type RefObject } from 'react';
import { GridRenderer } from '../gl/GridRenderer';
import { useAppStore } from '../store';

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

    const sync = (snapshot = useAppStore.getState().snapshot) =>
      renderer.setScene(snapshot ? { project: snapshot.project, assets: snapshot.assets } : null);
    sync();
    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (state.snapshot !== prev.snapshot) sync(state.snapshot);
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
