/**
 * sceneRenderer.js — draws one frame of the video (background + path + trail
 * + markers + overlays) for a given output-time. Used identically by the
 * settings-step live preview and the final recorder, so what you preview is
 * what gets recorded.
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;
  const TimelineScene = global.TimelineScene;

  function activityColor(activityType) {
    if (!activityType) return null;
    const t = String(activityType).toUpperCase();
    if (t.includes('FLY') || t.includes('FLIGHT')) return '#c77dff';
    if (t.includes('VEHICLE') || t.includes('DRIV') || t.includes('CAR')) return '#ff9f43';
    if (t.includes('CYCL') || t.includes('BIK')) return '#20c997';
    if (t.includes('RUN')) return '#ff6b6b';
    if (t.includes('WALK')) return '#51cf66';
    if (t.includes('TRAIN') || t.includes('TRANSIT') || t.includes('BUS') || t.includes('SUBWAY')) return '#4f8cff';
    return null;
  }

  function findActivityColorAt(segmentsMeta, time, fallback) {
    if (!segmentsMeta || !segmentsMeta.length) return fallback;
    // segmentsMeta sorted by startTime.
    let lo = 0, hi = segmentsMeta.length - 1, found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segmentsMeta[mid].startTime <= time) {
        found = segmentsMeta[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found && time <= found.endTime + 30 * 60 * 1000) {
      return activityColor(found.activityType) || fallback;
    }
    return fallback;
  }

  function segmentColor(settings, scene, i, w) {
    if (settings.lineColorMode === 'activity') {
      return findActivityColorAt(scene.segmentsMeta, scene.points[i].time, settings.lineColor);
    }
    if (settings.lineColorMode === 'gradient') {
      const hue = Geo.lerp(212, 328, scene.points.length > 1 ? i / (scene.points.length - 1) : 0);
      return `hsl(${hue.toFixed(0)}, 78%, 62%)`;
    }
    return settings.lineColor;
  }

  function drawPath(ctx, mapRenderer, cam, scene, fromIdx, toIdx, settings, w, h) {
    const points = scene.points;
    if (toIdx <= fromIdx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = settings.lineWidth;
    if (settings.lineStyle === 'dashed') ctx.setLineDash([settings.lineWidth * 2.2, settings.lineWidth * 2.2]);
    else ctx.setLineDash([]);

    for (let i = Math.max(1, fromIdx + 1); i <= toIdx; i++) {
      if (scene.isJumpAt[i]) continue; // gaps/flights are drawn separately
      const p0 = mapRenderer.project(points[i - 1].lat, points[i - 1].lng, cam.center, cam.zoom, w, h);
      const p1 = mapRenderer.project(points[i].lat, points[i].lng, cam.center, cam.zoom, w, h);
      ctx.beginPath();
      ctx.strokeStyle = segmentColor(settings, scene, i, w);
      if (settings.lineStyle === 'glow') {
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = settings.lineWidth * 3;
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
  }

  function drawJumps(ctx, mapRenderer, cam, scene, fromIdx, toIdx, w, h) {
    const points = scene.points;
    for (let i = Math.max(1, fromIdx + 1); i <= toIdx; i++) {
      if (!scene.isJumpAt[i] || !scene.isFlightAt[i]) continue;
      const p0 = mapRenderer.project(points[i - 1].lat, points[i - 1].lng, cam.center, cam.zoom, w, h);
      const p1 = mapRenderer.project(points[i].lat, points[i].lng, cam.center, cam.zoom, w, h);
      const midX = (p0.x + p1.x) / 2;
      const midY = (p0.y + p1.y) / 2 - Math.min(80, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.25);
      ctx.beginPath();
      ctx.strokeStyle = '#c77dff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(midX, midY, p1.x, p1.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawCurrentMarker(ctx, mapRenderer, cam, point, settings, w, h) {
    const p = mapRenderer.project(point.lat, point.lng, cam.center, cam.zoom, w, h);
    ctx.save();
    ctx.shadowColor = settings.lineColor;
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = settings.lineColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function pill(ctx, x, y, text, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 15;
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`;
    const padX = 12, padY = 8;
    const tw = ctx.measureText(text).width;
    const bw = tw + padX * 2;
    const bh = fontSize + padY * 2;
    ctx.fillStyle = opts.bg || 'rgba(10,14,22,0.62)';
    roundRect(ctx, x, y, bw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = opts.color || '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + bh / 2 + 1);
    return { w: bw, h: bh };
  }

  function formatDate(ms) {
    if (!isFinite(ms)) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  function formatKm(km) {
    if (km >= 1000) return (km / 1000).toFixed(1) + '천km';
    return Math.round(km).toLocaleString() + 'km';
  }

  const KNOWN_PLACE_NAMES = { Home: '집', Work: '직장' };
  function friendlyPlaceName(placeName) {
    if (placeName && KNOWN_PLACE_NAMES[placeName]) return KNOWN_PLACE_NAMES[placeName];
    if (placeName && /^[A-Za-z0-9_-]{15,}$/.test(placeName)) return '방문 장소';
    return placeName || '방문 장소';
  }

  function drawOverlays(ctx, scene, idx, ot, settings, w, h) {
    const margin = Math.round(w * 0.03);
    if (settings.overlayProgressBar) {
      const frac = Geo.clamp(ot / scene.totalDuration, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, 0, w, 4);
      ctx.fillStyle = settings.lineColor;
      ctx.fillRect(0, 0, w * frac, 4);
    }
    if (settings.overlayDate && scene.points[idx]) {
      pill(ctx, margin, margin, formatDate(scene.points[idx].time), { fontSize: Math.round(w * 0.028) });
    }
    if (settings.overlayStats) {
      const visitsSoFar = scene.visits.filter((v) => v.startTime <= (scene.points[idx] ? scene.points[idx].time : 0)).length;
      const text = `🚗 ${formatKm(scene.cumDistanceKm[idx] || 0)}   📍 ${visitsSoFar}곳`;
      pill(ctx, margin, margin + Math.round(w * 0.07), text, { fontSize: Math.round(w * 0.024) });
    }
  }

  function drawFocusLabel(ctx, label, w, h) {
    if (!label) return;
    ctx.save();
    ctx.font = `700 ${Math.round(w * 0.036)}px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`;
    ctx.textAlign = 'center';
    const text = label;
    const tw = ctx.measureText(text).width;
    const bw = tw + w * 0.06;
    const bh = w * 0.07;
    const x = w / 2 - bw / 2;
    const y = h * 0.08;
    ctx.fillStyle = 'rgba(10,14,22,0.68)';
    roundRect(ctx, x, y, bw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, y + bh / 2 + 2);
    ctx.restore();
  }

  function drawSummaryCard(ctx, scene, ot, w, h) {
    const summaryWindow = Math.min(4, Math.max(2, scene.totalDuration * 0.12));
    const startAt = scene.totalDuration - summaryWindow;
    if (ot < startAt) return;
    const alpha = Geo.clamp((ot - startAt) / 0.6, 0, 1);
    const last = scene.points.length - 1;
    const totalKm = scene.cumDistanceKm[last] || 0;
    const first = scene.points[0], end = scene.points[last];
    const topVisits = scene.visits.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,10,18,0.72)';
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(w * 0.05)}px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`;
    ctx.fillText('나의 타임라인', w / 2, h * 0.22);

    ctx.font = `400 ${Math.round(w * 0.026)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    if (first && end) ctx.fillText(`${formatDate(first.time)} → ${formatDate(end.time)}`, w / 2, h * 0.3);

    ctx.font = `700 ${Math.round(w * 0.045)}px system-ui, sans-serif`;
    ctx.fillStyle = '#8fd3ff';
    ctx.fillText(`총 ${formatKm(totalKm)} 이동 · ${scene.visits.length}곳 방문`, w / 2, h * 0.42);

    if (topVisits.length) {
      ctx.font = `400 ${Math.round(w * 0.022)}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText('가장 오래 머문 곳', w / 2, h * 0.54);
      topVisits.forEach((v, i) => {
        const hours = Math.round((v.durationMs / 3600000) * 10) / 10;
        ctx.font = `600 ${Math.round(w * 0.026)}px system-ui, sans-serif`;
        ctx.fillStyle = '#fff';
        ctx.fillText(`${friendlyPlaceName(v.placeName)} · ${hours}시간`, w / 2, h * (0.6 + i * 0.06));
      });
    }
    ctx.restore();
  }

  /** Draw the full frame for output-time `ot` (seconds) into ctx (size w x h). */
  function drawSceneFrame(mapRenderer, scene, ot, settings, ctx, w, h) {
    const cam = scene.cameraAtTime(ot);
    mapRenderer.drawBackground(cam.center, cam.zoom, w, h);

    const idx = scene.indexAtProgress(cam.progressFrac);
    let fromIdx = 0;
    if (settings.trailMode === 'fade' && scene.points.length && scene.points[idx]) {
      // Real elapsed time, not video time: only the last `trailHours` of
      // actual movement stays on screen, regardless of pacing/dwell weighting.
      const cutoff = scene.points[idx].time - settings.trailHours * 3600 * 1000;
      fromIdx = TimelineScene.timeLowerBound(scene.points, cutoff);
    }

    drawPath(ctx, mapRenderer, cam, scene, fromIdx, idx, settings, w, h);
    drawJumps(ctx, mapRenderer, cam, scene, fromIdx, idx, w, h);
    if (scene.points[idx]) drawCurrentMarker(ctx, mapRenderer, cam, scene.points[idx], settings, w, h);
    if (cam.focusLabel) drawFocusLabel(ctx, cam.focusLabel, w, h);
    drawOverlays(ctx, scene, idx, ot, settings, w, h);
    mapRenderer.drawAttribution(w, h);
    if (settings.overlaySummary) drawSummaryCard(ctx, scene, ot, w, h);
  }

  global.SceneRenderer = { drawSceneFrame, formatDate, formatKm };
})(typeof window !== 'undefined' ? window : globalThis);
