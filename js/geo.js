/**
 * geo.js — Web Mercator projection helpers and small geo utilities.
 * No DOM dependency; safe to unit test under Node.
 */
(function (global) {
  'use strict';

  const TILE_SIZE = 256;

  /** World pixel size (both axes) at a given (possibly fractional) zoom level. */
  function worldSize(zoom) {
    return TILE_SIZE * Math.pow(2, zoom);
  }

  /** Project lng/lat (degrees) to continuous world-pixel coordinates at `zoom`. */
  function project(lng, lat, zoom) {
    const size = worldSize(zoom);
    const x = (lng + 180) / 360 * size;
    const clampedLat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size;
    return { x, y };
  }

  /** Inverse of project(): world-pixel coordinates at `zoom` back to lng/lat. */
  function unproject(x, y, zoom) {
    const size = worldSize(zoom);
    const lng = (x / size) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / size;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lng, lat };
  }

  /** Great-circle distance in meters (haversine). */
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** Shortest-path lerp for longitude, so crossing the antimeridian doesn't spin the camera. */
  function lerpLng(a, b, t) {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return a + d * t;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /** Bounding box {minLat,maxLat,minLng,maxLng} of an array of {lat,lng} points. */
  function boundingBox(points) {
    if (!points || !points.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return { minLat, maxLat, minLng, maxLng };
  }

  /** Best-fit continuous zoom level so that `box` fits within `width`x`height` px, with padding. */
  function zoomForBounds(box, width, height, padding, minZoom, maxZoom) {
    minZoom = minZoom == null ? 0 : minZoom;
    maxZoom = maxZoom == null ? 19 : maxZoom;
    padding = padding == null ? 40 : padding;
    if (!box) return (minZoom + maxZoom) / 2;
    const w = Math.max(width - padding * 2, 10);
    const h = Math.max(height - padding * 2, 10);
    // Handle a single point / degenerate box.
    const latSpan = Math.max(box.maxLat - box.minLat, 0.0005);
    const lngSpan = Math.max(box.maxLng - box.minLng, 0.0005);
    for (let z = maxZoom; z >= minZoom; z -= 0.05) {
      const p1 = project(box.minLng, box.minLat, z);
      const p2 = project(box.maxLng, box.maxLat, z);
      const pxW = Math.abs(p2.x - p1.x);
      const pxH = Math.abs(p2.y - p1.y);
      if (pxW <= w && pxH <= h) return z;
    }
    return minZoom;
  }

  function center(box) {
    if (!box) return { lat: 20, lng: 0 };
    return { lat: (box.minLat + box.maxLat) / 2, lng: (box.minLng + box.maxLng) / 2 };
  }

  const api = {
    TILE_SIZE,
    worldSize,
    project,
    unproject,
    distanceMeters,
    lerp,
    lerpLng,
    easeInOutCubic,
    clamp,
    boundingBox,
    zoomForBounds,
    center,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.Geo = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
