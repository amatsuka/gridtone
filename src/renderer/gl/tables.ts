// Атлас таблиц (кривые или HSL): одна текстура RGBA32F, строка — таблица одного прохода.
// Шейдер читает её texelFetch и интерполирует сам — так же, как core, без фильтрации текстур.

export class TableAtlas {
  private texture: WebGLTexture;
  private capacity = 0;
  private readonly rows = new Map<Float32Array, number>();
  private readonly used = new Set<Float32Array>();
  private free: number[] = [];

  /** width — узлов в таблице; каждая таблица — width × 4 float. */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly width: number,
  ) {
    this.texture = this.allocate(8);
  }

  /** Строка таблицы в атласе. Новая таблица загружается сразу; если места нет, атлас растёт. */
  row(table: Float32Array): number {
    this.used.add(table);
    const existing = this.rows.get(table);
    if (existing !== undefined) return existing;
    if (table.length !== this.width * 4) throw new Error(`Таблица длиной ${table.length}, ожидалось ${this.width * 4}`);
    if (this.free.length === 0) this.grow();
    const row = this.free.shift() as number;
    this.rows.set(table, row);
    this.upload(table, row);
    return row;
  }

  bind(unit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
  }

  /** После кадра: строки таблиц, которые в кадре не понадобились, освобождаются. */
  endFrame(): void {
    for (const [table, row] of this.rows) {
      if (this.used.has(table)) continue;
      this.rows.delete(table);
      this.free.push(row);
    }
    this.used.clear();
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }

  private grow(): void {
    const old = this.texture;
    this.texture = this.allocate(this.capacity * 2);
    this.gl.deleteTexture(old);
    for (const [table, row] of this.rows) this.upload(table, row);
  }

  private allocate(capacity: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.width, capacity, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (let row = this.capacity; row < capacity; row++) this.free.push(row);
    this.capacity = capacity;
    return texture;
  }

  private upload(table: Float32Array, row: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, this.width, 1, gl.RGBA, gl.FLOAT, table);
  }
}
