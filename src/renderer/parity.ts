// Скрытая страница для tests/e2e/shader-parity.spec.ts: рисует изображение тем же шейдером и той же
// программой, что и сетка, во float-буфер и отдаёт пиксели. Приложение эту страницу не открывает.
import { bakePipeline, CURVE_TABLE_SIZE, type BakedAdjust, type PipelineParams } from '@core/color/bake';
import { HSL_TABLE_SIZE } from '@core/color/hsl';
import type { ViewOutput } from '@core/color/view';
import type { Lut3D } from '@core/lut/lut3d';
import { LutTextures } from './gl/luts';
import { PipelineProgram, TEXTURE_UNIT, type PassInput } from './gl/program';
import { TableAtlas } from './gl/tables';

/** LUT для страницы: узлы float64 подряд в base64 — так 65³ не идёт через JSON числами. */
export interface ParityLut {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  data: string;
}

export interface ParityApi {
  /** Запоминает LUT под id: его текстура загружается один раз на все отрисовки (шаг 9, этап 3б). */
  loadLut(id: string, lut: ParityLut): void;
  /**
   * RGBA 8 бит (base64) → RGBA float32 (base64), строки сверху вниз, как во входе. view — режим 3 или 4.
   * lutId — LUT образа из loadLut: шаг 9 последнего прохода; params.lut не используется.
   */
  render(width: number, height: number, rgba8: string, params: PipelineParams, view?: ViewOutput, lutId?: string): string;
}

declare global {
  interface Window {
    gridtoneParity: ParityApi;
  }
}

const gl = createContext();
// Без него во float-текстуру не нарисовать, а 8-битный буфер скрыл бы расхождения меньше 1/255.
if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Нет EXT_color_buffer_float');

const program = new PipelineProgram(gl);
const curves = new TableAtlas(gl, CURVE_TABLE_SIZE);
const hsl = new TableAtlas(gl, HSL_TABLE_SIZE);
const lutTextures = new LutTextures(gl);
const NEUTRAL_PASS: BakedAdjust = { linear: null, curves: null, color: null };
const luts = new Map<string, Lut3D>();

window.gridtoneParity = {
  loadLut(id, { size, domainMin, domainMax, data }) {
    const bytes = fromBase64(data);
    luts.set(id, { size, domainMin, domainMax, data: new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8) });
  },

  render(width, height, rgba8, params, view = 'color', lutId) {
    const source = texture(gl.RGBA8, width, height, gl.RGBA, gl.UNSIGNED_BYTE, fromBase64(rgba8));
    const target = texture(gl.RGBA32F, width, height, gl.RGBA, gl.FLOAT, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Float-буфер не собрался');

    const lut = lutId === undefined ? undefined : luts.get(lutId);
    if (lutId !== undefined && !lut) throw new Error(`LUT ${lutId} не загружен`);
    const baked = bakePipeline({ photo: params.photo, look: params.look });
    // Как в приложении: у образа с LUT второй проход есть всегда, даже с нейтральной коррекцией.
    const look = baked.look ?? (lut ? NEUTRAL_PASS : null);
    const order = look ? [baked.photo, look] : [baked.photo];
    const passes = order.map((pass, i): PassInput => ({
      baked: pass,
      tables: {
        curvesRow: pass.curves ? curves.row(pass.curves) : 0,
        hslRow: pass.color?.hsl ? hsl.row(pass.color.hsl) : 0,
      },
      lut: lut && i === order.length - 1 ? lut : null,
    }));
    if (lut && lutId !== undefined) lutTextures.bind(lutId, lut, TEXTURE_UNIT.lut);

    gl.viewport(0, 0, width, height);
    program.use();
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.image);
    gl.bindTexture(gl.TEXTURE_2D, source);
    curves.bind(TEXTURE_UNIT.curves);
    hsl.bind(TEXTURE_UNIT.hsl);
    program.setPasses(passes);
    program.setView(view);
    program.setGeometry([0, 0, width, height], [width, height], [1, 0, 0, 0, 1, 0]);
    program.draw();

    const pixels = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(source);
    gl.deleteTexture(target);
    curves.endFrame();
    hsl.endFrame();

    // readPixels отдаёт строки снизу вверх, а верх изображения шейдер рисует в верх буфера.
    const flipped = new Float32Array(pixels.length);
    const stride = width * 4;
    for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
    return toBase64(new Uint8Array(flipped.buffer));
  },
};

function createContext(): WebGL2RenderingContext {
  const context = document.createElement('canvas').getContext('webgl2');
  if (!context) throw new Error('WebGL2 недоступен');
  return context;
}

function texture(
  internalFormat: GLenum,
  width: number,
  height: number,
  format: GLenum,
  type: GLenum,
  data: ArrayBufferView | null,
): WebGLTexture {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  // Пиксель в пиксель: центр фрагмента попадает в центр текселя.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
