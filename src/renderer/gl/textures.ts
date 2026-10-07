// Прокси из gridtone:// в текстуры WebGL, с LRU: в памяти держатся только недавно нужные.
// Сетка берёт прокси 512 (до 64 текстур), редактор фото — 2048 (текущее фото и соседи, до трёх).
import { proxyUrl, type ProxySize } from '@shared/cache';

interface Entry {
  state: 'loading' | 'ready' | 'failed';
  texture: WebGLTexture | null;
  width: number;
  height: number;
  lastFrame: number;
}

export interface ProxyTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

/** Одновременных загрузок: остальные ждут в очереди в порядке запроса. */
const MAX_LOADING = 4;

export class ProxyTextures {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private loading = 0;
  private frame = 0;
  private disposed = false;

  /**
   * onLoad — новая текстура готова, нужен кадр. С mip-уровнями текстура прокси 512 занимает около 1.9 МБ,
   * прокси 2048 — до 22 МБ.
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly onLoad: () => void,
    private readonly maxTextures = 64,
    private readonly size: ProxySize = 512,
  ) {}

  /** Готовых текстур в памяти. */
  get count(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.texture) n++;
    return n;
  }

  /** Текстура прокси, если готова. Если нет — ставит загрузку в очередь. */
  get(assetId: string): ProxyTexture | null {
    let entry = this.entries.get(assetId);
    if (!entry) {
      entry = { state: 'loading', texture: null, width: 0, height: 0, lastFrame: this.frame };
      this.entries.set(assetId, entry);
      this.queue.push(assetId);
      this.pump();
    }
    entry.lastFrame = this.frame;
    return entry.state === 'ready' && entry.texture ? { texture: entry.texture, width: entry.width, height: entry.height } : null;
  }

  /** После кадра: лишние текстуры, давно не попадавшие в кадр, удаляются. */
  endFrame(): void {
    const ready = [...this.entries].filter(([, e]) => e.state !== 'loading');
    const excess = ready.length - this.maxTextures;
    if (excess > 0) {
      ready
        .filter(([, e]) => e.lastFrame < this.frame)
        .sort(([, a], [, b]) => a.lastFrame - b.lastFrame)
        .slice(0, excess)
        .forEach(([id, e]) => {
          if (e.texture) this.gl.deleteTexture(e.texture);
          this.entries.delete(id);
        });
    }
    this.frame++;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) if (entry.texture) this.gl.deleteTexture(entry.texture);
    this.entries.clear();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.loading < MAX_LOADING && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      this.loading++;
      void this.load(id).finally(() => {
        this.loading--;
        this.pump();
      });
    }
  }

  private async load(assetId: string): Promise<void> {
    const entry = this.entries.get(assetId);
    if (!entry) return;
    try {
      const response = await fetch(proxyUrl(assetId, this.size));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Прокси уже в sRGB (ADR 0004): браузер не должен ничего пересчитывать.
      const bitmap = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      if (this.disposed || this.entries.get(assetId) !== entry) {
        bitmap.close();
        return;
      }
      entry.texture = this.upload(bitmap);
      entry.width = bitmap.width;
      entry.height = bitmap.height;
      entry.state = 'ready';
      bitmap.close();
      this.onLoad();
    } catch (err) {
      console.error(`Не удалось загрузить прокси ${assetId}`, err);
      entry.state = 'failed';
    }
  }

  private upload(bitmap: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
}
