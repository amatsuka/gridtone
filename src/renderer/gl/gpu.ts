// Ресурсы одного контекста WebGL2 для конвейера: программа, атласы таблиц и текстуры прокси.
// Общие для сетки (GridRenderer) и редактора фото (PhotoRenderer): одна и та же программа рисует
// плитку и крупный кадр, поэтому редактор показывает ровно то же, что сетка.
import { bakeAdjust, CURVE_TABLE_SIZE, type BakedAdjust } from '@core/color/bake';
import { HSL_TABLE_SIZE } from '@core/color/hsl';
import type { ViewOutput } from '@core/color/view';
import type { Lut3D } from '@core/lut/lut3d';
import type { Affine } from '@core/project/crop';
import type { Adjust } from '@core/project/types';
import type { ProxySize } from '@shared/cache';
import { LutTextures } from './luts';
import { PipelineProgram, TEXTURE_UNIT, type PassInput } from './program';
import { TableAtlas } from './tables';
import { ProxyTextures, type ProxyTexture } from './textures';

/** Подготовленные параметры по объекту коррекции: Immer меняет объект только при правке. Это данные CPU — кэш общий для контекстов. */
const baked = new WeakMap<Adjust, BakedAdjust>();

function bake(adjust: Adjust): BakedAdjust {
  let result = baked.get(adjust);
  if (!result) {
    result = bakeAdjust(adjust);
    baked.set(adjust, result);
  }
  return result;
}

/** Загруженный LUT образа: id из реестра проекта и разобранная таблица (ADR 0015). */
export interface LoadedLut {
  id: string;
  lut: Lut3D;
}

export class PipelineGpu {
  readonly textures: ProxyTextures;
  readonly luts: LutTextures;
  private readonly program: PipelineProgram;
  private readonly curves: TableAtlas;
  private readonly hsl: TableAtlas;

  /** Текстуры — прокси proxySize, не больше maxTextures; onLoad — новая текстура готова, нужен кадр. */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    proxy: { size: ProxySize; maxTextures: number; onLoad: () => void },
  ) {
    this.program = new PipelineProgram(gl);
    this.curves = new TableAtlas(gl, CURVE_TABLE_SIZE);
    this.hsl = new TableAtlas(gl, HSL_TABLE_SIZE);
    this.textures = new ProxyTextures(gl, proxy.onLoad, proxy.maxTextures, proxy.size);
    this.luts = new LutTextures(gl);
  }

  /** Начало кадра: программа и пост-обработка режима просмотра (3 и 4). */
  begin(view: ViewOutput): void {
    this.program.use();
    this.program.setView(view);
  }

  /**
   * Рисует фото: rect — прямоугольник в пикселях холста, uv — точка прямоугольника → координаты фото.
   * adjusts — проходы конвейера: поправка фото и образ; пусто — исходник (до/после).
   * lut — импортированный LUT образа: шаг 9 последнего прохода (ADR 0015).
   */
  draw(
    proxy: ProxyTexture,
    adjusts: readonly Adjust[],
    rect: readonly [number, number, number, number],
    canvas: readonly [number, number],
    uv: Affine,
    lut: LoadedLut | null = null,
  ): void {
    const passes = adjusts.map((adjust, i): PassInput => {
      const pass = bake(adjust);
      return {
        baked: pass,
        tables: {
          curvesRow: pass.curves ? this.curves.row(pass.curves) : 0,
          hslRow: pass.color?.hsl ? this.hsl.row(pass.color.hsl) : 0,
        },
        lut: lut && i === adjusts.length - 1 ? lut.lut : null,
      };
    });
    const gl = this.gl;
    if (lut && passes.length > 0) this.luts.bind(lut.id, lut.lut, TEXTURE_UNIT.lut);
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.image);
    gl.bindTexture(gl.TEXTURE_2D, proxy.texture);
    this.curves.bind(TEXTURE_UNIT.curves);
    this.hsl.bind(TEXTURE_UNIT.hsl);
    this.program.setPasses(passes);
    this.program.setGeometry(rect, canvas, uv);
    this.program.draw();
  }

  /** После кадра: строки таблиц и текстуры, которые в кадре не понадобились, освобождаются. */
  endFrame(): void {
    this.curves.endFrame();
    this.hsl.endFrame();
    this.textures.endFrame();
  }

  /** Контекст потерян: удалять нечего, но загрузки текстур нужно остановить. */
  abandon(): void {
    this.textures.dispose();
  }

  dispose(): void {
    if (this.gl.isContextLost()) {
      this.abandon();
      return;
    }
    this.program.dispose();
    this.curves.dispose();
    this.hsl.dispose();
    this.textures.dispose();
    this.luts.dispose();
  }
}
