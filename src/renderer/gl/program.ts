// Программа конвейера: шейдеры + константы из core + запись подготовленных параметров в uniforms.
// Общая для сетки (GridRenderer) и страницы сверки с эталоном (parity.ts).
import { CURVE_TABLE_SIZE, type BakedAdjust } from '@core/color/bake';
import { SKIN_HUE, SKIN_PROTECTION, SKIN_WIDTH, VIBRANCE_CHROMA_LIMIT } from '@core/color/chroma';
import { HSL_CHROMA_FADE, HSL_TABLE_SIZE } from '@core/color/hsl';
import { LAB_TO_LMS, LINEAR_SRGB_TO_LMS, LMS_TO_LAB, LMS_TO_LINEAR_SRGB } from '@core/color/oklab';
import { LUMINANCE, type Mat3 } from '@core/color/srgb';
import { TONE_MIN_Y } from '@core/color/tone';
import type { Affine } from '@core/project/crop';
import FRAGMENT from './pipeline.frag.glsl?raw';
import VERTEX from './pipeline.vert.glsl?raw';

/** Строки таблиц прохода в атласах; для отсутствующей таблицы — любая, шейдер её не читает. */
export interface PassTables {
  curvesRow: number;
  hslRow: number;
}

// Те же биты, что в pipeline.frag.glsl.
const LINEAR = 1;
const TONE = 2;
const CURVES = 4;
const COLOR = 8;
const HSL = 16;
const GRADING = 32;
const CHROMA = 64;

const PASS_FIELDS = [
  'flags',
  'gain',
  'tone',
  'toneBlacks',
  'curvesRow',
  'hslRow',
  'gradeShadows',
  'gradeMidtones',
  'gradeHighlights',
  'gradeExponent',
  'vibrance',
  'saturation',
] as const;
type PassField = (typeof PASS_FIELDS)[number];

export const TEXTURE_UNIT = { image: 0, curves: 1, hsl: 2 } as const;

export class PipelineProgram {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly passes: Record<PassField, WebGLUniformLocation | null>[];
  private readonly uniforms: Record<'rect' | 'canvas' | 'uv' | 'passCount', WebGLUniformLocation | null>;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = link(gl, compile(gl, gl.VERTEX_SHADER, VERTEX), compile(gl, gl.FRAGMENT_SHADER, withConstants(FRAGMENT)));
    const at = (name: string) => gl.getUniformLocation(this.program, name);
    this.passes = [0, 1].map((i) => Object.fromEntries(PASS_FIELDS.map((f) => [f, at(`uPass[${i}].${f}`)])) as Record<PassField, WebGLUniformLocation | null>);
    this.uniforms = { rect: at('uRect'), canvas: at('uCanvas'), uv: at('uUv'), passCount: at('uPassCount') };

    gl.useProgram(this.program);
    gl.uniform1i(at('uImage'), TEXTURE_UNIT.image);
    gl.uniform1i(at('uCurves'), TEXTURE_UNIT.curves);
    gl.uniform1i(at('uHsl'), TEXTURE_UNIT.hsl);

    // Один квадрат на все плитки: углы 0..1, полосой из двух треугольников.
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  use(): void {
    this.gl.useProgram(this.program);
    this.gl.bindVertexArray(this.vao);
  }

  /** Проходы конвейера: поправка фото и, если есть, образ. */
  setPasses(passes: readonly { baked: BakedAdjust; tables: PassTables }[]): void {
    const gl = this.gl;
    gl.uniform1i(this.uniforms.passCount, passes.length);
    passes.forEach(({ baked, tables }, i) => {
      const u = this.passes[i];
      if (!u) return;
      const { linear, curves, color } = baked;
      let flags = 0;
      if (linear) flags |= LINEAR | (linear.tone ? TONE : 0);
      if (curves) flags |= CURVES;
      if (color) {
        flags |= COLOR;
        if (color.hsl) flags |= HSL;
        if (color.grading) flags |= GRADING;
        if (color.vibrance !== 0 || color.saturation !== 0) flags |= CHROMA;
      }
      gl.uniform1i(u.flags, flags);
      const exposure = linear?.exposure ?? 1;
      const wb = linear?.wb ?? [1, 1, 1];
      gl.uniform3f(u.gain, wb[0] * exposure, wb[1] * exposure, wb[2] * exposure);
      const tone = linear?.tone ?? [0, 0, 0, 0, 0];
      gl.uniform4f(u.tone, tone[0], tone[1], tone[2], tone[3]);
      gl.uniform1f(u.toneBlacks, tone[4]);
      gl.uniform1i(u.curvesRow, tables.curvesRow);
      gl.uniform1i(u.hslRow, tables.hslRow);
      const grading = color?.grading;
      gl.uniform2f(u.gradeShadows, ...(grading?.shadows ?? [0, 0]));
      gl.uniform2f(u.gradeMidtones, ...(grading?.midtones ?? [0, 0]));
      gl.uniform2f(u.gradeHighlights, ...(grading?.highlights ?? [0, 0]));
      gl.uniform1f(u.gradeExponent, grading?.exponent ?? 1);
      gl.uniform1f(u.vibrance, color?.vibrance ?? 0);
      gl.uniform1f(u.saturation, color?.saturation ?? 0);
    });
  }

  /** Плитка: прямоугольник в пикселях холста и отображение плитки в координаты фото. */
  setGeometry(rect: readonly [number, number, number, number], canvas: readonly [number, number], uv: Affine): void {
    const gl = this.gl;
    gl.uniform4f(this.uniforms.rect, ...rect);
    gl.uniform2f(this.uniforms.canvas, ...canvas);
    // mat3 в GLSL по столбцам: (a, d, 0), (b, e, 0), (c, f, 1).
    gl.uniformMatrix3fv(this.uniforms.uv, false, [uv[0], uv[3], 0, uv[1], uv[4], 0, uv[2], uv[5], 1]);
  }

  draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteBuffer(this.buffer);
  }
}

/** Подставляет константы core на место //#constants. */
function withConstants(source: string): string {
  const constants = [
    `#define CURVE_TABLE_SIZE ${CURVE_TABLE_SIZE}`,
    `#define HSL_TABLE_SIZE ${HSL_TABLE_SIZE}`,
    `const vec3 LUMINANCE = vec3(${LUMINANCE.map(float).join(', ')});`,
    `const float TONE_MIN_Y = ${float(TONE_MIN_Y)};`,
    `const float HSL_CHROMA_FADE = ${float(HSL_CHROMA_FADE)};`,
    `const float VIBRANCE_CHROMA_LIMIT = ${float(VIBRANCE_CHROMA_LIMIT)};`,
    `const float SKIN_HUE = ${float(SKIN_HUE)};`,
    `const float SKIN_WIDTH = ${float(SKIN_WIDTH)};`,
    `const float SKIN_PROTECTION = ${float(SKIN_PROTECTION)};`,
    `const mat3 LINEAR_SRGB_TO_LMS = ${mat3(LINEAR_SRGB_TO_LMS)};`,
    `const mat3 LMS_TO_LINEAR_SRGB = ${mat3(LMS_TO_LINEAR_SRGB)};`,
    `const mat3 LMS_TO_LAB = ${mat3(LMS_TO_LAB)};`,
    `const mat3 LAB_TO_LMS = ${mat3(LAB_TO_LMS)};`,
  ].join('\n');
  if (!source.includes('//#constants')) throw new Error('В шейдере нет места для констант');
  return source.replace('//#constants', constants);
}

/** Число как литерал GLSL: у целых нужна точка. */
function float(v: number): string {
  const s = String(v);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** Матрица core (по строкам, M·v) → конструктор GLSL (по столбцам). */
function mat3(m: Mat3): string {
  const column = (j: 0 | 1 | 2) => [m[0][j], m[1][j], m[2][j]].map(float).join(', ');
  return `mat3(${column(0)}, ${column(1)}, ${column(2)})`;
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Не удалось создать шейдер');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Шейдер не скомпилировался: ${log ?? ''}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: WebGLShader, fragment: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Программа не собралась: ${log ?? ''}`);
  }
  return program;
}
