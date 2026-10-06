import type { GridtoneApi } from '@shared/ipc';

declare global {
  interface Window {
    gridtone: GridtoneApi;
  }
}
