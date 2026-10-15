// Состояние меню из состояния интерфейса (docs/decisions/0011-undo-history.md): «Отменить», «Повторить»,
// «Редактор фото» и отмеченный режим. Логика меню — здесь: Playwright пункты меню не нажимает.
import { describe, expect, test } from 'vitest';
import { menuStateOf, sameMenuState, type MenuInputs } from '../../src/renderer/menuState';

const SLOTS = [{ id: 'photo', assetId: 'a1' }, { id: 'empty' }, { id: 'published', assetId: 'a2' }];

const inputs = (change: Partial<MenuInputs> = {}): MenuInputs => ({
  slots: SLOTS,
  primary: null,
  editorSlotId: null,
  modal: false,
  canUndo: false,
  canRedo: false,
  viewMode: 'grid',
  textField: false,
  ...change,
});

describe('состояние меню', () => {
  test('«Отменить» и «Повторить» — по истории', () => {
    expect(menuStateOf(inputs())).toMatchObject({ undo: false, redo: false });
    expect(menuStateOf(inputs({ canUndo: true }))).toMatchObject({ undo: true, redo: false });
    expect(menuStateOf(inputs({ canRedo: true }))).toMatchObject({ undo: false, redo: true });
  });

  test('в текстовом поле «Отменить» и «Повторить» активны и при пустой истории: они правят текст', () => {
    expect(menuStateOf(inputs({ textField: true }))).toMatchObject({ undo: true, redo: true });
    // Под диалогом — тоже: поле «Рядов» в импорте паттерна.
    expect(menuStateOf(inputs({ textField: true, modal: true }))).toMatchObject({ undo: true, redo: true });
  });

  test('под диалогом команды проекта не выполняются — пункты неактивны', () => {
    const state = menuStateOf(inputs({ modal: true, canUndo: true, canRedo: true, primary: 'photo' }));
    expect(state).toMatchObject({ undo: false, redo: false, editor: false });
  });

  test('«Редактор фото» — основная плитка с фото, редактор закрыт', () => {
    expect(menuStateOf(inputs()).editor).toBe(false);
    expect(menuStateOf(inputs({ primary: 'photo' })).editor).toBe(true);
    // Опубликованную можно открыть, как по E: правки в ней не меняются, но кадр и фото видны.
    expect(menuStateOf(inputs({ primary: 'published' })).editor).toBe(true);
    expect(menuStateOf(inputs({ primary: 'empty' })).editor).toBe(false);
    expect(menuStateOf(inputs({ primary: 'нет такой' })).editor).toBe(false);
    expect(menuStateOf(inputs({ primary: 'photo', editorSlotId: 'photo' })).editor).toBe(false);
    expect(menuStateOf(inputs({ primary: 'photo', slots: [] })).editor).toBe(false);
  });

  test('режим просмотра — как есть; одинаковые состояния не шлются повторно', () => {
    expect(menuStateOf(inputs({ viewMode: 'deviation' })).viewMode).toBe('deviation');
    const a = menuStateOf(inputs({ canUndo: true }));
    expect(sameMenuState(a, menuStateOf(inputs({ canUndo: true })))).toBe(true);
    expect(sameMenuState(a, { ...a, redo: true })).toBe(false);
    expect(sameMenuState(a, { ...a, editor: true })).toBe(false);
    expect(sameMenuState(a, { ...a, viewMode: 'profile' })).toBe(false);
    expect(sameMenuState(a, { ...a, undo: false })).toBe(false);
  });
});
