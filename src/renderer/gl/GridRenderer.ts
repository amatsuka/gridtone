// Сетка на WebGL2: один контекст рисует все видимые плитки в общий холст по координатам DOM-сетки.
// DOM остаётся для номеров, бейджей и кликов; холст лежит под ним (docs/spec.md, «Рендер»).
import { bakeAdjust, CURVE_TABLE_SIZE, type BakedAdjust } from '@core/color/bake';
import { HSL_TABLE_SIZE } from '@core/color/hsl';
import type { ViewOutput } from '@core/color/view';
import { gridWindowTransform } from '@core/project/crop';
import type { Adjust, Project, Slot } from '@core/project/types';
import type { AssetStatus } from '@shared/ipc';
import { PipelineProgram, TEXTURE_UNIT } from './program';
import { TableAtlas } from './tables';
import { ProxyTextures } from './textures';

export interface GridScene {
  project: Project;
  assets: Record<string, AssetStatus>;
  /** Пост-обработка режимов 3 и 4 (ADR 0012). */
  view: ViewOutput;
  /** До/после: фото без поправок и образов. */
  original: boolean;
}

interface GpuState {
  program: PipelineProgram;
  curves: TableAtlas;
  hsl: TableAtlas;
  textures: ProxyTextures;
}

export class GridRenderer {
  private readonly gl: WebGL2RenderingContext;
  private gpu: GpuState | null;
  private scene: GridScene | null = null;
  private frameRequest = 0;
  /** Подготовленные параметры по объекту коррекции: Immer меняет объект только при правке. */
  private readonly baked = new WeakMap<Adjust, BakedAdjust>();

  /** tileRoot — контейнер, где лежат плитки с data-slot-id. Бросает, если WebGL2 недоступен. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly tileRoot: () => HTMLElement | null,
  ) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    this.gpu = this.createGpu();
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  setScene(scene: GridScene | null): void {
    this.scene = scene;
    this.requestRender();
  }

  /** Кадр в ближайший requestAnimationFrame; повторные запросы до него схлопываются. */
  requestRender(): void {
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.render();
    });
  }

  dispose(): void {
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.disposeGpu();
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
    const root = this.tileRoot();
    if (!scene || !root) return;

    const slots = new Map(scene.project.slots.map((slot) => [slot.id, slot]));
    const looks = new Map(scene.project.looks.map((look) => [look.id, look.adjust]));
    const bounds = canvas.getBoundingClientRect();
    gpu.program.use();
    gpu.program.setView(scene.view);

    for (const tile of root.querySelectorAll<HTMLElement>('[data-slot-id]')) {
      const slot = slots.get(tile.dataset['slotId'] ?? '');
      const r = tile.getBoundingClientRect();
      const visible = r.right > bounds.left && r.left < bounds.right && r.bottom > bounds.top && r.top < bounds.bottom;
      if (!slot || !visible) continue;
      const drawn = this.drawTile(gpu, scene, slot, looks, [
        (r.left - bounds.left) * dpr,
        (r.top - bounds.top) * dpr,
        r.width * dpr,
        r.height * dpr,
      ]);
      // Для тестов и стилей: плитка показывает фото, а не заглушку. Меняем, только если изменилось:
      // запись атрибута каждый кадр заставляла бы браузер пересчитывать стили.
      if (drawn !== (tile.dataset['rendered'] === 'true')) {
        if (drawn) tile.dataset['rendered'] = 'true';
        else delete tile.dataset['rendered'];
      }
    }

    gpu.curves.endFrame();
    gpu.hsl.endFrame();
    gpu.textures.endFrame();
  }

  private drawTile(
    gpu: GpuState,
    scene: GridScene,
    slot: Slot,
    looks: Map<string, Adjust>,
    rect: [number, number, number, number],
  ): boolean {
    const { assetId } = slot;
    if (!assetId || scene.assets[assetId]?.proxy !== 'ready') return false;
    const proxy = gpu.textures.get(assetId);
    if (!proxy) return false;

    const look = slot.lookId ? looks.get(slot.lookId) : undefined;
    const adjusts = scene.original ? [] : look ? [slot.adjust, look] : [slot.adjust];
    const passes = adjusts.map((adjust) => {
      const baked = this.bake(adjust);
      return {
        baked,
        tables: {
          curvesRow: baked.curves ? gpu.curves.row(baked.curves) : 0,
          hslRow: baked.color?.hsl ? gpu.hsl.row(baked.color.hsl) : 0,
        },
      };
    });

    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.image);
    gl.bindTexture(gl.TEXTURE_2D, proxy.texture);
    gpu.curves.bind(TEXTURE_UNIT.curves);
    gpu.hsl.bind(TEXTURE_UNIT.hsl);
    gpu.program.setPasses(passes);
    gpu.program.setGeometry(rect, [this.canvas.width, this.canvas.height], gridWindowTransform(proxy.width, proxy.height, slot.crop, scene.project.grid.ratio));
    gpu.program.draw();
    return true;
  }

  private bake(adjust: Adjust): BakedAdjust {
    let baked = this.baked.get(adjust);
    if (!baked) {
      baked = bakeAdjust(adjust);
      this.baked.set(adjust, baked);
    }
    return baked;
  }

  private createGpu(): GpuState {
    return {
      program: new PipelineProgram(this.gl),
      curves: new TableAtlas(this.gl, CURVE_TABLE_SIZE),
      hsl: new TableAtlas(this.gl, HSL_TABLE_SIZE),
      textures: new ProxyTextures(this.gl, () => this.requestRender()),
    };
  }

  private disposeGpu(): void {
    const gpu = this.gpu;
    this.gpu = null;
    if (!gpu || this.gl.isContextLost()) return;
    gpu.program.dispose();
    gpu.curves.dispose();
    gpu.hsl.dispose();
    gpu.textures.dispose();
  }

  // Контекст может пропасть (сон, смена GPU). После восстановления всё создаётся заново.
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.gpu?.textures.dispose();
    this.gpu = null;
  };

  private readonly onContextRestored = (): void => {
    this.gpu = this.createGpu();
    this.requestRender();
  };
}
