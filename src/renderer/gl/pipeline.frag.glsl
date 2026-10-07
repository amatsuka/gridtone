#version 300 es
// Цветовой конвейер на GPU. Повторяет src/core/color/pipeline.ts шаг в шаг и в том же порядке.
// Меняются только вместе; совпадение проверяет tests/e2e/shader-parity.spec.ts.
// Константы и матрицы подставляет program.ts из core — своих чисел здесь нет.
precision highp float;
precision highp int;
precision highp sampler2D;

//#constants

// Флаги прохода: какие шаги не тождественны (src/core/color/bake.ts, null — шаг пропускается).
const int LINEAR = 1;
const int TONE = 2;
const int CURVES = 4;
const int COLOR = 8;
const int HSL = 16;
const int GRADING = 32;
const int CHROMA = 64;

struct Pass {
  int flags;
  vec3 gain;          // баланс белого × 2^EV
  vec4 tone;          // множители контраста, светов, теней, белых
  float toneBlacks;   // множитель чёрных
  int curvesRow;      // строка в uCurves
  int hslRow;         // строка в uHsl
  vec2 gradeShadows;  // сдвиги (a, b) кругов
  vec2 gradeMidtones;
  vec2 gradeHighlights;
  float gradeExponent;
  float vibrance;     // ползунок / 100
  float saturation;   // ползунок / 100
};

uniform sampler2D uImage;
uniform sampler2D uCurves; // RGBA32F, строка — таблица кривых одного прохода
uniform sampler2D uHsl;    // RGBA32F, строка — таблица HSL одного прохода
uniform Pass uPass[2];     // поправка фото, затем образ
uniform int uPassCount;
uniform int uView;         // пост-обработка режима просмотра: VIEW_COLOR, VIEW_LUMINANCE, VIEW_POSTERIZE

in vec2 vUv;
out vec4 outColor;

// ─── Шаги 1 и 5: передаточная функция sRGB ────────────────────────────────

float srgbToLinear(float v) {
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

float linearToSrgb(float v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

vec3 decodeSrgb(vec3 c) {
  return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
}

float encodeClamped(float v) {
  return v >= 1.0 ? 1.0 : v <= 0.0 ? 0.0 : linearToSrgb(v);
}

vec3 encodeSrgbClamped(vec3 c) {
  return vec3(encodeClamped(c.r), encodeClamped(c.g), encodeClamped(c.b));
}

// ─── Шаг 4: тональная кривая (docs/decisions/0006-tone-curve.md) ─────────────

float pow6(float v) {
  float v2 = v * v;
  return v2 * v2 * v2;
}

float toneCurve(float x0, vec4 k, float kb) {
  float x = x0;
  float y = 1.0 - x;
  x += k.x * x * y * (2.0 * x - 1.0);
  y = 1.0 - x;
  x += k.y * pow6(x) * y * y;
  y = 1.0 - x;
  x += k.z * x * x * pow6(y);
  y = 1.0 - x;
  x += k.w * pow6(x) * x * y;
  y = 1.0 - x;
  x += kb * x * pow6(y) * y;
  return x;
}

vec3 applyTone(vec3 rgb, vec4 k, float kb) {
  float y = dot(rgb, LUMINANCE);
  if (y >= 1.0) return rgb;
  float yc = max(y, TONE_MIN_Y);
  float gain = srgbToLinear(toneCurve(linearToSrgb(yc), k, kb)) / yc;
  if (gain > 1.0) {
    float top = max(rgb.r, max(rgb.g, rgb.b));
    if (top > 0.0) gain = min(gain, max(1.0, 1.0 / top));
  }
  return rgb * gain;
}

// ─── Шаг 6: кривые ──────────────────────────────────────────────────────────

vec4 sampleCurves(int row, float x) {
  float pos = clamp(x, 0.0, 1.0) * float(CURVE_TABLE_SIZE - 1);
  int i = min(int(floor(pos)), CURVE_TABLE_SIZE - 2);
  float t = pos - float(i);
  return mix(texelFetch(uCurves, ivec2(i, row), 0), texelFetch(uCurves, ivec2(i + 1, row), 0), t);
}

// ─── Шаги 7–8: OKLab / OKLCH ────────────────────────────────────────────────

float cbrt(float x) {
  return sign(x) * pow(abs(x), 1.0 / 3.0);
}

vec3 linearToOklab(vec3 c) {
  vec3 lms = LINEAR_SRGB_TO_LMS * c;
  return LMS_TO_LAB * vec3(cbrt(lms.x), cbrt(lms.y), cbrt(lms.z));
}

vec3 oklabToLinear(vec3 lab) {
  vec3 lms = LAB_TO_LMS * lab;
  return LMS_TO_LINEAR_SRGB * (lms * lms * lms);
}

vec3 toLch(vec3 lab) {
  float C = length(lab.yz);
  // atan(0, 0) в GLSL не определён; в core Math.atan2(0, 0) = 0.
  float h = C > 0.0 ? degrees(atan(lab.z, lab.y)) : 0.0;
  if (h < 0.0) h += 360.0;
  return vec3(lab.x, C, h);
}

vec3 lchToLab(vec3 lch) {
  float rad = radians(lch.z);
  return vec3(lch.x, lch.y * cos(rad), lch.y * sin(rad));
}

vec4 sampleHsl(int row, float hue) {
  float pos = hue / 360.0 * float(HSL_TABLE_SIZE);
  float base = floor(pos);
  float t = pos - base;
  int i = int(base) % HSL_TABLE_SIZE;
  if (i < 0) i += HSL_TABLE_SIZE;
  int j = (i + 1) % HSL_TABLE_SIZE;
  return mix(texelFetch(uHsl, ivec2(i, row), 0), texelFetch(uHsl, ivec2(j, row), 0), t);
}

vec3 applyHsl(vec3 lch, int row) {
  float fade = smoothstep(0.0, HSL_CHROMA_FADE, lch.y);
  if (fade == 0.0) return lch;
  vec4 d = sampleHsl(row, lch.z);
  float hue = mod(lch.z + d.x * fade, 360.0);
  return vec3(lch.x * (1.0 + d.z * fade), lch.y * (1.0 + d.y * fade), hue);
}

vec3 applyGrading(vec3 lab, Pass p) {
  float t = pow(clamp(lab.x, 0.0, 1.0), p.gradeExponent);
  float u = 1.0 - t;
  vec2 ab = lab.yz + u * u * p.gradeShadows + 2.0 * t * u * p.gradeMidtones + t * t * p.gradeHighlights;
  return vec3(lab.x, ab);
}

float hueDistance(float a, float b) {
  float d = mod(abs(a - b), 360.0);
  return d > 180.0 ? 360.0 - d : d;
}

float vibranceWeight(float C, float h) {
  float d = hueDistance(h, SKIN_HUE) / SKIN_WIDTH;
  return (1.0 - smoothstep(0.0, VIBRANCE_CHROMA_LIMIT, C)) * (1.0 - SKIN_PROTECTION * exp(-d * d));
}

vec3 applyChroma(vec3 lch, float vibrance, float saturation) {
  float vib = vibrance == 0.0 ? 1.0 : 1.0 + vibrance * vibranceWeight(lch.y, lch.z);
  return vec3(lch.x, lch.y * vib * (1.0 + saturation), lch.z);
}

// ─── Проход ─────────────────────────────────────────────────────────────────

vec3 applyPass(vec3 c0, Pass p) {
  vec3 c = c0;
  if ((p.flags & LINEAR) != 0) {
    vec3 lin = decodeSrgb(c) * p.gain;
    if ((p.flags & TONE) != 0) lin = applyTone(lin, p.tone, p.toneBlacks);
    c = encodeSrgbClamped(lin);
  }
  if ((p.flags & CURVES) != 0) {
    c = vec3(sampleCurves(p.curvesRow, c.r).r, sampleCurves(p.curvesRow, c.g).g, sampleCurves(p.curvesRow, c.b).b);
  }
  if ((p.flags & COLOR) != 0) {
    vec3 lab = linearToOklab(decodeSrgb(c));
    if ((p.flags & HSL) != 0) lab = lchToLab(applyHsl(toLch(lab), p.hslRow));
    if ((p.flags & GRADING) != 0) lab = applyGrading(lab, p);
    if ((p.flags & CHROMA) != 0) lab = lchToLab(applyChroma(toLch(lab), p.vibrance, p.saturation));
    c = encodeSrgbClamped(oklabToLinear(lab));
  }
  return c;
}

// ─── Режимы просмотра 3 и 4 (src/core/color/view.ts) ─────────────────────────

vec3 applyView(vec3 c) {
  if (uView == VIEW_COLOR) return c;
  float L = linearToOklab(decodeSrgb(c)).x;
  if (uView == VIEW_POSTERIZE) {
    float level = min(floor(clamp(L, 0.0, 1.0) * float(POSTERIZE_LEVELS)), float(POSTERIZE_LEVELS - 1));
    L = (level + 0.5) / float(POSTERIZE_LEVELS);
  }
  // Серый с тем же OKLab L: линейное значение — ровно L³.
  return vec3(encodeClamped(L * L * L));
}

void main() {
  vec3 c = texture(uImage, vUv).rgb;
  for (int i = 0; i < 2; i++) {
    if (i >= uPassCount) break;
    c = applyPass(c, uPass[i]);
  }
  outColor = vec4(applyView(c), 1.0);
}
