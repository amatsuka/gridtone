// Импортированные LUT образов в 3D-текстурах (docs/decisions/0015-lut-import.md): RGB32F, R по x,
// G по y, B по z — та же раскладка, что у Lut3D и строк `.cube`. Без фильтрации: шейдер читает узлы
// texelFetch и интерполирует сам, как core. Кэш по id LUT: id выводится из содержимого файла.
import type { Lut3D } from '@core/lut/lut3d';

/** Текстур в одном контексте: 65³ — 3.3 МБ каждая. */
export const LUT_TEXTURES_MAX = 8;

export class LutTextures {
  /** id → текстура; порядок Map — от давно нужной к недавней. */
  private readonly entries = new Map<string, WebGLTexture>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly max = LUT_TEXTURES_MAX,
  ) {}

  /** Привязывает текстуру LUT к блоку unit; при первом обращении загружает её. */
  bind(id: string, lut: Lut3D, unit: number): void {
    const gl = this.gl;
    let texture = this.entries.get(id);
    this.entries.delete(id);
    if (!texture) texture = this.upload(lut, unit);
    this.entries.set(id, texture);
    for (const [old, t] of this.entries) {
      if (this.entries.size <= this.max) break;
      // Удалять текстуру, которую уже нарисовали в этом кадре, можно: GL освободит её после отрисовки.
      gl.deleteTexture(t);
      this.entries.delete(old);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, texture);
  }

  get count(): number {
    return this.entries.size;
  }

  dispose(): void {
    for (const texture of this.entries.values()) this.gl.deleteTexture(texture);
    this.entries.clear();
  }

  private upload(lut: Lut3D, unit: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    // С ArrayBufferView и включёнными FLIP_Y или PREMULTIPLY_ALPHA texImage3D даёт INVALID_OPERATION.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const { size } = lut;
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, Float32Array.from(lut.data));
    // Без мип-уровней и с NEAREST: иначе текстура неполная, и texelFetch вернёт нули.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return texture;
  }
}
