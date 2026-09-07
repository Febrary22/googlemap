/**
 * mapCanvas.js — a minimal slippy-map tile renderer that draws straight onto
 * a <canvas>, with no DOM map library involved. This is deliberate: video
 * recording captures a canvas frame-by-frame via captureStream(), and a
 * DOM-based map (Leaflet/Google Maps) can't be captured cleanly or driven at
 * an exact, deterministic frame rate. Tile providers are restricted to ones
 * that serve CORS headers, so the canvas never gets "tainted" and stays
 * exportable.
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;

  // All raster sources below are Esri's public ArcGIS Online basemap tile
  // services — free, no API key, and CORS-enabled, so the canvas stays
  // exportable. (CARTO's basemap tiles used to work the same way but now
  // require a registered API key, which showed up as an "API KEY REQUIRED"
  // watermark baked right into the tile images — switched away from them
  // entirely rather than have that leak into recorded videos.)
  const PROVIDERS = {
    positron: {
      label: '라이트',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
      attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
      maxZoom: 16,
      dark: false,
    },
    dark: {
      label: '다크',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
      attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS',
      maxZoom: 16,
      dark: true,
    },
    voyager: {
      label: '컬러',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
      attribution: 'Esri, HERE, Garmin, USGS, Intermap',
      maxZoom: 19,
      dark: false,
    },
    satellite: {
      label: '위성',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      attribution: 'Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
      dark: true,
    },
    none: {
      label: '없음 (미니멀 배경)',
      url: null,
      attribution: '',
      maxZoom: 19,
      dark: true,
    },
  };

  class MapCanvasRenderer {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.provider = (options && options.provider) || 'satellite';
      this.bgColor = (options && options.bgColor) || '#0b1220';
      this.cache = new Map(); // "z/x/y/provider" -> { img, loaded, failed }
    }

    setProvider(name) {
      if (PROVIDERS[name]) this.provider = name;
    }

    static get providers() {
      return PROVIDERS;
    }

    _providerDef() {
      return PROVIDERS[this.provider] || PROVIDERS.voyager;
    }

    _tileKey(z, x, y) {
      return `${this.provider}/${z}/${x}/${y}`;
    }

    /** Returns a loaded HTMLImageElement, or null while it's still loading/failed. Kicks off loading as a side effect. */
    _getTile(z, x, y) {
      const def = this._providerDef();
      if (!def.url) return null;
      const n = Math.pow(2, z);
      const wrappedX = ((x % n) + n) % n;
      if (y < 0 || y >= n) return null;
      const key = this._tileKey(z, wrappedX, y);
      let entry = this.cache.get(key);
      if (!entry) {
        entry = { img: null, loaded: false, failed: false };
        this.cache.set(key, entry);
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          entry.loaded = true;
        };
        img.onerror = () => {
          entry.failed = true;
        };
        img.src = def.url(z, wrappedX, y);
        entry.img = img;
      }
      return entry.loaded ? entry.img : null;
    }

    /**
     * Pre-fetch every tile needed to render the given list of camera states
     * ({center:{lat,lng}, zoom}) at canvas size w x h, so playback/recording
     * never has to wait on the network mid-frame. Resolves once all tiles
     * have either loaded or permanently failed.
     */
    async prefetch(cameraSamples, w, h, onProgress) {
      const def = this._providerDef();
      if (!def.url) {
        if (onProgress) onProgress(1);
        return;
      }
      const needed = new Set();
      for (const cam of cameraSamples) {
        const tileZ = Geo.clamp(Math.round(cam.zoom), 0, def.maxZoom);
        const scale = Math.pow(2, cam.zoom - tileZ);
        const center = Geo.project(cam.center.lng, cam.center.lat, cam.zoom);
        const halfW = w / 2 / scale;
        const halfH = h / 2 / scale;
        const centerTileWorld = Geo.project(cam.center.lng, cam.center.lat, tileZ);
        const left = centerTileWorld.x - halfW;
        const right = centerTileWorld.x + halfW;
        const top = centerTileWorld.y - halfH;
        const bottom = centerTileWorld.y + halfH;
        const txMin = Math.floor(left / 256) - 1;
        const txMax = Math.floor(right / 256) + 1;
        const tyMin = Math.max(0, Math.floor(top / 256) - 1);
        const tyMax = Math.min(Math.pow(2, tileZ) - 1, Math.floor(bottom / 256) + 1);
        for (let tx = txMin; tx <= txMax; tx++) {
          for (let ty = tyMin; ty <= tyMax; ty++) {
            needed.add(`${tileZ}/${tx}/${ty}`);
          }
        }
      }

      const list = Array.from(needed);
      let done = 0;
      const CONCURRENCY = 10;
      let cursor = 0;

      await new Promise((resolve) => {
        if (list.length === 0) return resolve();
        let active = 0;
        const next = () => {
          if (cursor >= list.length && active === 0) return resolve();
          while (active < CONCURRENCY && cursor < list.length) {
            const [z, x, y] = list[cursor++].split('/').map(Number);
            active++;
            this._loadTilePromise(z, x, y).finally(() => {
              active--;
              done++;
              if (onProgress) onProgress(done / list.length);
              next();
            });
          }
        };
        next();
      });
    }

    _loadTilePromise(z, x, y) {
      const def = this._providerDef();
      const n = Math.pow(2, z);
      const wrappedX = ((x % n) + n) % n;
      const key = this._tileKey(z, wrappedX, y);
      let entry = this.cache.get(key);
      if (entry && (entry.loaded || entry.failed)) return Promise.resolve();
      return new Promise((resolve) => {
        if (!entry) {
          entry = { img: null, loaded: false, failed: false };
          this.cache.set(key, entry);
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            entry.loaded = true;
            resolve();
          };
          img.onerror = () => {
            entry.failed = true;
            resolve();
          };
          img.src = def.url(z, wrappedX, y);
          entry.img = img;
        } else {
          const check = () => {
            if (entry.loaded || entry.failed) resolve();
            else setTimeout(check, 50);
          };
          check();
        }
      });
    }

    /** Convert a lat/lng to on-canvas pixel coords for the given camera + canvas size. */
    project(lat, lng, center, zoom, w, h) {
      const c = Geo.project(center.lng, center.lat, zoom);
      const p = Geo.project(lng, lat, zoom);
      return { x: w / 2 + (p.x - c.x), y: h / 2 + (p.y - c.y) };
    }

    /** Draw the basemap (tiles, or a flat color/gradient in "none" mode) for the given camera. */
    drawBackground(center, zoom, w, h) {
      const ctx = this.ctx;
      const def = this._providerDef();

      if (!def.url) {
        const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
        grad.addColorStop(0, '#132036');
        grad.addColorStop(1, '#060a12');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        return;
      }

      ctx.fillStyle = def.dark ? '#0b1220' : '#e8e6df';
      ctx.fillRect(0, 0, w, h);

      const tileZ = Geo.clamp(Math.round(zoom), 0, def.maxZoom);
      const scale = Math.pow(2, zoom - tileZ);
      const tileSizeOnScreen = 256 * scale;

      const centerWorld = Geo.project(center.lng, center.lat, tileZ);
      const originX = w / 2 - centerWorld.x * scale;
      const originY = h / 2 - centerWorld.y * scale;

      const txMin = Math.floor(-originX / tileSizeOnScreen) - 1;
      const txMax = Math.floor((w - originX) / tileSizeOnScreen) + 1;
      const tyMin = Math.max(0, Math.floor(-originY / tileSizeOnScreen) - 1);
      const tyMax = Math.min(Math.pow(2, tileZ) - 1, Math.floor((h - originY) / tileSizeOnScreen) + 1);

      for (let tx = txMin; tx <= txMax; tx++) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const img = this._getTile(tileZ, tx, ty);
          const sx = originX + tx * tileSizeOnScreen;
          const sy = originY + ty * tileSizeOnScreen;
          if (img) {
            ctx.drawImage(img, sx, sy, tileSizeOnScreen + 0.5, tileSizeOnScreen + 0.5);
          }
        }
      }
    }

    drawAttribution(w, h) {
      const def = this._providerDef();
      if (!def.attribution) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.font = '11px system-ui, sans-serif';
      const text = def.attribution;
      const metrics = ctx.measureText(text);
      const pad = 6;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(w - metrics.width - pad * 2 - 4, h - 22, metrics.width + pad * 2, 18);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(text, w - metrics.width - pad - 4, h - 9);
      ctx.restore();
    }
  }

  global.MapCanvasRenderer = MapCanvasRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
