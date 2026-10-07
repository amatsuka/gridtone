// Редактор фото на WebGL2: второй контекст с той же программой конвейера и атласами, что у сетки
// (docs/spec.md, «Рендер»). Фото — прокси 2048 целиком; кадр ленты и окно сетки поверх рисует DOM.
// Текстуры — текущее фото и соседние посты, не больше трёх; при закрытии редактора всё освобождается.
import type { ViewOutput } from '@core/color/view';
import type { Adjust } from '@core/project/types';
import { PipelineGpu } from './gpu';

/** Прокси 2048 в памяти: текущее фото и два соседа. */
export const EDITOR_TEXTURES = 3;

/** Всё фото: точка прямоугольника — та же точка фото. */
const IDENTITY = [1, 0, 0, 0, 1, 0] as const;

export interface PhotoScene {
  assetId: string;
  /** Соседние посты: их прокси грузятся заранее, чтобы ←/→ показывали фото сразу. */
  preload: readonly string[];
  /** Проходы конвейера: поправка фото и образ. Пусто — исходник (до/после). */
  adjusts: readonly Adjust[];
  /** Пост-обработка режимов 3 и 4 (ADR 0012) — как в сетке. */
  view: ViewOutput;
  /** Где на холсте фото: x, y, ширина, высота в CSS-пикселях. */
  rect: readonly [number, number, number, number];
}

export class PhotoRenderer {
  private readonly gl: WebGL2RenderingContext;
  private gpu: PipelineGpu | null;
  private scene: PhotoScene | null = null;
  private frameRequest = 0;

  /** Бросает, если WebGL2 недоступен. */
  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    this.gpu = this.createGpu();
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  setScene(scene: PhotoScene | null): void {
    this.scene = scene;
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.render();
    });
  }

  /** Освобождает текстуры и программу и отпускает сам контекст: их число в странице ограничено. */
  dispose(): void {
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    const gpu = this.gpu;
    this.gpu = null;
    gpu?.dispose();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private render(): void {
    const { gl, canvas, gpu } = this;
    if (!gpu || gl.isContextLost()) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const scene = this.scene;
    let drawn: string | null = null;
    if (scene) {
      const proxy = gpu.textures.get(scene.assetId);
      // Соседи только встают в очередь загрузки и отмечаются как нужные, чтобы LRU их не вытеснил.
      for (const id of scene.preload) gpu.textures.get(id);
      if (proxy) {
        const [x, y, w, h] = scene.rect;
        gpu.begin(scene.view);
        gpu.draw(proxy, scene.adjusts, [x * dpr, y * dpr, w * dpr, h * dpr], [width, height], IDENTITY);
        drawn = `${proxy.width}x${proxy.height}`;
      }
    }
    gpu.endFrame();

    // Для тестов: фото нарисовано, из прокси какого размера, сколько текстур в памяти.
    const data = canvas.dataset;
    if (drawn) {
      if (data['rendered'] !== 'true') data['rendered'] = 'true';
      if (data['texture'] !== drawn) data['texture'] = drawn;
    } else if (data['rendered']) {
      delete data['rendered'];
    }
    const count = String(gpu.textures.count);
    if (data['textures'] !== count) data['textures'] = count;
  }

  private createGpu(): PipelineGpu {
    return new PipelineGpu(this.gl, { size: 2048, maxTextures: EDITOR_TEXTURES, onLoad: () => this.requestRender() });
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.gpu?.abandon();
    this.gpu = null;
  };

  private readonly onContextRestored = (): void => {
    this.gpu = this.createGpu();
    this.requestRender();
  };
}
