// Состояние пунктов меню (docs/decisions/0011-undo-history.md, 0012-view-modes.md): какие активны и какой режим
// отмечен. Меню Playwright не нажимает, поэтому логика проверяется здесь, а e2e читает итог в main.
import { describe, expect, test } from 'vitest';
import type { MenuState } from '@shared/ipc';
import { VIEW_MODES } from '@shared/view';
import { INITIAL_MENU_STATE, menuItemStates, parseMenuState, PROJECT_ITEM_IDS } from '../../src/main/menu-state';

const state = (change: Partial<MenuState> = {}): MenuState => ({ ...INITIAL_MENU_STATE, ...change });

describe('пункты меню', () => {
  test('без проекта неактивны все пункты проекта, даже если renderer считает их доступными', () => {
    const items = menuItemStates(false, state({ undo: true, redo: true, editor: true }));
    expect([...items.keys()].sort()).toEqual([...PROJECT_ITEM_IDS].sort());
    for (const [id, item] of items) expect(item.enabled, id).toBe(false);
  });

  test('с проектом «Отменить», «Повторить» и «Редактор фото» — по renderer, остальные активны', () => {
    const closed = menuItemStates(true, state());
    expect(closed.get('undo')?.enabled).toBe(false);
    expect(closed.get('redo')?.enabled).toBe(false);
    expect(closed.get('editor')?.enabled).toBe(false);
    for (const id of ['import', 'importLut', 'export', 'save', 'close', 'copyAdjust', 'pasteAdjust', 'view:grid']) {
      expect(closed.get(id)?.enabled, id).toBe(true);
    }
    const open = menuItemStates(true, state({ undo: true, editor: true }));
    expect(open.get('undo')?.enabled).toBe(true);
    expect(open.get('redo')?.enabled).toBe(false);
    expect(open.get('editor')?.enabled).toBe(true);
    expect(menuItemStates(true, state({ redo: true })).get('redo')?.enabled).toBe(true);
  });

  test('в «Виде» отмечен ровно режим renderer — и при закрытом проекте', () => {
    for (const hasProject of [true, false]) {
      for (const mode of VIEW_MODES) {
        const items = menuItemStates(hasProject, state({ viewMode: mode }));
        const checked = VIEW_MODES.filter((m) => items.get(`view:${m}`)?.checked);
        expect(checked).toEqual([mode]);
      }
    }
    // Отметка есть только у пунктов «Вид».
    const items = menuItemStates(true, state());
    for (const id of PROJECT_ITEM_IDS.filter((id) => !id.startsWith('view:'))) expect(items.get(id)?.checked, id).toBeUndefined();
  });

  test('состояние из renderer проверяется', () => {
    const ok = { undo: true, redo: false, viewMode: 'luminance', editor: true };
    expect(parseMenuState(ok)).toEqual(ok);
    expect(parseMenuState({ ...ok, extra: 1 })).toEqual(ok);
    expect(() => parseMenuState(null)).toThrow(/меню/);
    expect(() => parseMenuState([])).toThrow();
    expect(() => parseMenuState({ ...ok, viewMode: 'night' })).toThrow();
    expect(() => parseMenuState({ ...ok, undo: 'да' })).toThrow();
    expect(() => parseMenuState({ ...ok, editor: undefined })).toThrow();
    expect(() => parseMenuState({ undo: true, redo: true, viewMode: 'grid' })).toThrow();
  });
});
