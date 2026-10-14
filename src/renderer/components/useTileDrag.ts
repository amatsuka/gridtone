// Клик и перетаскивание плиток на pointer events. HTML5 DnD не подходит: фото рисует холст, и за
// курсором тянулась бы пустая DOM-плитка. Пока тянем, меняется только порядок превью (dragOrder),
// а холст рисует плитки по их новым местам в DOM. Отпускание — одна правка и одна запись истории.
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { moveSlots } from '@core/project/order';
import { clickTile, moveTiles } from '../commands';
import { useAppStore } from '../store';

const DRAG_THRESHOLD = 5;
/** Полоса у края прокрутки, где сетка прокручивается сама. */
const SCROLL_EDGE = 48;

interface Press {
  pointerId: number;
  slotId: string;
  mode: 'replace' | 'toggle' | 'range';
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Что тянем; null — ещё клик, порог не пройден. */
  ids: string[] | null;
  to: number;
}

export interface TileDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
  onLostPointerCapture(): void;
}

export function useTileDrag(gridRef: RefObject<HTMLElement | null>, scrollerRef: RefObject<HTMLElement | null>): TileDragHandlers {
  const press = useRef<Press | null>(null);
  const frame = useRef(0);

  const handlers = useMemo(() => {
    /** Позиция в сетке под указателем: плитка, в которую он попал, или ближайшая. */
    const positionAt = (x: number, y: number): number | null => {
      const tiles = gridRef.current?.children;
      if (!tiles) return null;
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let i = 0; i < tiles.length; i++) {
        const r = (tiles[i] as Element).getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      }
      return best;
    };

    /** Превью считается от текущих слотов: импорт мог добавить новые посреди перетаскивания. */
    const updatePreview = (p: Press) => {
      const to = positionAt(p.x, p.y);
      const project = useAppStore.getState().snapshot?.project;
      if (to === null || !p.ids || !project) return;
      p.to = to;
      const next = moveSlots(project.slots, p.ids, to, project.grid.pinned).map((slot) => slot.id);
      const current = useAppStore.getState().dragOrder;
      if (!current || current.length !== next.length || current.some((id, i) => id !== next[i])) {
        useAppStore.setState({ dragOrder: next });
      }
    };

    /** У верхнего и нижнего края сетка прокручивается сама, быстрее у самой кромки. */
    const autoscroll = () => {
      frame.current = 0;
      const p = press.current;
      const scroller = scrollerRef.current;
      if (!p?.ids || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const depth = p.y < r.top + SCROLL_EDGE ? p.y - r.top - SCROLL_EDGE : p.y > r.bottom - SCROLL_EDGE ? p.y - r.bottom + SCROLL_EDGE : 0;
      if (depth === 0) return;
      scroller.scrollTop += depth / 4;
      updatePreview(p);
      frame.current = requestAnimationFrame(autoscroll);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };

    const finish = (commit: boolean) => {
      const p = press.current;
      press.current = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      window.removeEventListener('keydown', onEscape, true);
      if (!p?.ids) return;
      useAppStore.setState({ dragOrder: null });
      if (commit) moveTiles(p.ids, p.to);
    };

    /** Тянем выделение, если плитка в нём; иначе только её. Опубликованные посты и закреплённые не двигаются. */
    const start = (p: Press, element: HTMLElement): boolean => {
      const { snapshot, selection } = useAppStore.getState();
      const index = snapshot?.project.slots.findIndex((s) => s.id === p.slotId) ?? -1;
      const slot = snapshot?.project.slots[index];
      if (!snapshot || !slot || slot.state === 'published' || index < snapshot.project.grid.pinned) return false;
      if (!selection.ids.includes(p.slotId)) clickTile(p.slotId, 'replace');
      p.ids = [...useAppStore.getState().selection.ids];
      element.setPointerCapture(p.pointerId);
      window.addEventListener('keydown', onEscape, true);
      return true;
    };

    return {
      onPointerDown(event: ReactPointerEvent<HTMLElement>) {
        if (event.button !== 0 || press.current) return;
        const tile = (event.target as Element).closest<HTMLElement>('[data-slot-id]');
        const slotId = tile?.dataset['slotId'];
        if (!slotId) return;
        const mode = event.metaKey || event.ctrlKey ? 'toggle' : event.shiftKey ? 'range' : 'replace';
        const { clientX: x, clientY: y } = event;
        press.current = { pointerId: event.pointerId, slotId, mode, startX: x, startY: y, x, y, ids: null, to: -1 };
      },

      onPointerMove(event: ReactPointerEvent<HTMLElement>) {
        const p = press.current;
        if (!p || p.pointerId !== event.pointerId) return;
        p.x = event.clientX;
        p.y = event.clientY;
        if (!p.ids) {
          // ⌘- и Shift-клик только выделяют.
          if (p.mode !== 'replace' || Math.hypot(p.x - p.startX, p.y - p.startY) < DRAG_THRESHOLD) return;
          if (!start(p, event.currentTarget)) return;
        }
        updatePreview(p);
        if (!frame.current) frame.current = requestAnimationFrame(autoscroll);
      },

      onPointerUp(event: ReactPointerEvent<HTMLElement>) {
        const p = press.current;
        if (!p || p.pointerId !== event.pointerId) return;
        if (p.ids) {
          finish(true);
        } else {
          press.current = null;
          clickTile(p.slotId, p.mode);
        }
      },

      onPointerCancel() {
        finish(false);
      },

      // После pointerup press уже пуст; сюда попадаем, только если захват потерян посреди перетаскивания.
      onLostPointerCapture() {
        if (press.current?.ids) finish(false);
      },
    };
  }, [gridRef, scrollerRef]);

  useEffect(() => () => handlers.onPointerCancel(), [handlers]);
  return handlers;
}
