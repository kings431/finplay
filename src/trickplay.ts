import type { Auth } from "./jellyfin";
import { sendThumb } from "./player";
import type { BaseItem, TrickplayInfo } from "./types";

const MAX_TILES = 6;

type Source = { itemId: string; sourceId: string; info: TrickplayInfo; offsetSeconds: number };

/** Picks the trickplay resolution to use, preferring one at least 320px wide. */
export function trickplaySource(item: BaseItem, sourceId: string, offsetSeconds: number): Source | null {
  const byWidth = item.Trickplay?.[sourceId] ?? Object.values(item.Trickplay ?? {})[0];
  const options = Object.values(byWidth ?? {})
    .filter((info) => info.ThumbnailCount > 0 && info.Interval > 0 && info.TileWidth > 0 && info.TileHeight > 0)
    .sort((a, b) => a.Width - b.Width);
  if (!options.length) return null;
  const info = options.find((option) => option.Width >= 320) ?? options[options.length - 1];
  return { itemId: item.Id, sourceId, info, offsetSeconds };
}

/**
 * Cuts preview frames out of Jellyfin's trickplay tile sheets and hands them
 * to the player overlay as raw BGRA, which is the only format mpv overlays read.
 */
export class TrickplayRenderer {
  private tiles = new Map<number, Promise<ImageBitmap>>();
  private latest = 0;
  private canvas = document.createElement("canvas");

  constructor(
    private auth: Auth,
    private source: Source,
  ) {}

  async show(time: number, width: number) {
    const ticket = ++this.latest;
    const { info, offsetSeconds } = this.source;
    const seconds = Math.max(0, time + offsetSeconds);
    const thumb = Math.min(info.ThumbnailCount - 1, Math.floor((seconds * 1000) / info.Interval));
    const perTile = info.TileWidth * info.TileHeight;
    const bitmap = await this.tile(Math.floor(thumb / perTile));
    if (ticket !== this.latest) return;

    const offset = thumb % perTile;
    const sx = (offset % info.TileWidth) * info.Width;
    const sy = Math.floor(offset / info.TileWidth) * info.Height;
    const w = Math.round(width);
    const h = Math.round((width * info.Height) / info.Width);
    this.canvas.width = w;
    this.canvas.height = h;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(bitmap, sx, sy, info.Width, info.Height, 0, 0, w, h);
    const rgba = context.getImageData(0, 0, w, h).data;
    const bgra = new Uint8Array(rgba.length);
    for (let index = 0; index < rgba.length; index += 4) {
      bgra[index] = rgba[index + 2];
      bgra[index + 1] = rgba[index + 1];
      bgra[index + 2] = rgba[index];
      bgra[index + 3] = 255;
    }
    if (ticket !== this.latest) return;
    await sendThumb(bgra, w, h);
  }

  dispose() {
    this.latest++;
    for (const tile of this.tiles.values()) tile.then((bitmap) => bitmap.close()).catch(() => {});
    this.tiles.clear();
  }

  private tile(index: number) {
    const cached = this.tiles.get(index);
    if (cached) return cached;
    const { auth, source } = this;
    const params = new URLSearchParams({ MediaSourceId: source.sourceId, ApiKey: auth.token });
    const url = `${auth.server}/Videos/${source.itemId}/Trickplay/${source.info.Width}/${index}.jpg?${params}`;
    const loading = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Trickplay tile ${index} returned ${response.status}`);
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob));
    loading.catch(() => this.tiles.delete(index));
    this.tiles.set(index, loading);
    if (this.tiles.size > MAX_TILES) {
      const oldest = this.tiles.keys().next().value;
      if (oldest !== undefined && oldest !== index) {
        this.tiles.get(oldest)?.then((bitmap) => bitmap.close()).catch(() => {});
        this.tiles.delete(oldest);
      }
    }
    return loading;
  }
}
