/**
 * pickerMap.js — a tiny Leaflet map used ONLY as an interactive picker so the
 * user can click a spot on the map to add a custom "zoom in here" focus
 * point. It is never recorded, so it's fine to use a normal DOM map library
 * here even though the actual video renderer uses its own canvas engine.
 */
(function (global) {
  'use strict';

  class PickerMap {
    constructor(containerEl) {
      this.map = global.L.map(containerEl, { worldCopyJump: true }).setView([20, 0], 2);
      global.L.tileLayer('https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap, © CARTO',
      }).addTo(this.map);
      this.marker = null;
      this.pathLayer = null;
      this.onPick = null;
      this.map.on('click', (e) => {
        this.setMarker(e.latlng.lat, e.latlng.lng);
        if (this.onPick) this.onPick(e.latlng.lat, e.latlng.lng);
      });
    }

    setMarker(lat, lng) {
      if (this.marker) this.marker.setLatLng([lat, lng]);
      else this.marker = global.L.marker([lat, lng]).addTo(this.map);
    }

    clearMarker() {
      if (this.marker) {
        this.map.removeLayer(this.marker);
        this.marker = null;
      }
    }

    setRoutePreview(points) {
      if (this.pathLayer) this.map.removeLayer(this.pathLayer);
      if (!points || !points.length) return;
      const latlngs = points.map((p) => [p.lat, p.lng]);
      this.pathLayer = global.L.polyline(latlngs, { color: '#4f8cff', weight: 2, opacity: 0.55 }).addTo(this.map);
      try {
        this.map.fitBounds(this.pathLayer.getBounds(), { padding: [24, 24] });
      } catch (e) {
        /* ignore degenerate bounds */
      }
    }

    invalidate() {
      this.map.invalidateSize();
    }

    destroy() {
      this.map.remove();
    }
  }

  global.PickerMap = PickerMap;
})(typeof window !== 'undefined' ? window : globalThis);
