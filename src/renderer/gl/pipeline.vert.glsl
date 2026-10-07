#version 300 es
// Плитка: прямоугольник в пикселях холста и окно кадра внутри фото.

in vec2 aCorner; // угол плитки, 0..1, начало слева сверху

uniform vec4 uRect;   // x, y, ширина, высота в пикселях холста, начало слева сверху
uniform vec2 uCanvas; // размер холста в пикселях
uniform mat3 uUv;     // точка плитки → координаты фото 0..1 (src/core/project/crop.ts)

out vec2 vUv;

void main() {
  vec2 p = uRect.xy + aCorner * uRect.zw;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
  vUv = (uUv * vec3(aCorner, 1.0)).xy;
}
