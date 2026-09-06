/**
 * timeline.js — turns normalized timeline data + user settings into a
 * "Scene": a deterministic function of output-time (seconds) that yields
 * the camera position/zoom and how much of the path should be visible.
 * Both the live preview and the final recorder call the same function, so
 * what you preview is exactly what gets recorded.
 */
(function (global) {
  'use strict';

  const Geo = global.Geo;

  const GAP_MS = 3 * 60 * 60 * 1000; // 3h silence -> new stroke segment
  const FLIGHT_KMH = 250; // implied speed above this -> treat as a "long jump" (flight)

  /** First index in a time-sorted array with .time >= t. */
  function timeLowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index in a time-sorted array with .time > t (i.e. an exclusive upper bound). */
  function timeUpperBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Filter points/visits to a [start,end] ms range (inclusive). */
  function filterRange(data, startMs, endMs) {
    const points = data.points.filter((p) => p.time >= startMs && p.time <= endMs);
    const visits = data.visits.filter((v) => v.startTime >= startMs && v.startTime <= endMs);
    return { points, visits, segmentsMeta: data.segmentsMeta };
  }

  /** Evenly decimate to at most `max` points, always keeping the very first/last and visit anchors. */
  function decimate(points, max, mustKeepTimes) {
    if (points.length <= max) return points;
    const keep = new Set([0, points.length - 1]);
    if (mustKeepTimes && mustKeepTimes.size) {
      let j = 0;
      for (const t of mustKeepTimes) {
        while (j < points.length - 1 && points[j].time < t) j++;
        keep.add(j);
      }
    }
    const stride = points.length / max;
    for (let i = 0; i < points.length; i += stride) keep.add(Math.floor(i));
    return Array.from(keep)
      .sort((a, b) => a - b)
      .map((i) => points[i]);
  }

  /**
   * Split a point list into stroke segments, breaking on big time/distance
   * gaps. Also returns per-edge flags (aligned to `points`, index i describes
   * the edge points[i-1] -> points[i]) so the renderer can skip or
   * special-case those edges every frame without recomputing gap math.
   */
  function buildStrokes(points) {
    const isJumpAt = new Array(points.length).fill(false);
    const isFlightAt = new Array(points.length).fill(false);
    if (!points.length) return { strokes: [], jumps: [], isJumpAt, isFlightAt };
    const strokes = [];
    let current = [points[0]];
    const jumps = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const dtMs = cur.time - prev.time;
      const distM = Geo.distanceMeters(prev.lat, prev.lng, cur.lat, cur.lng);
      const hours = Math.max(dtMs / 3600000, 1 / 3600);
      const kmh = distM / 1000 / hours;
      const flight = kmh > FLIGHT_KMH && distM > 50000;
      const isJump = dtMs > GAP_MS || flight;
      if (isJump) {
        isJumpAt[i] = true;
        isFlightAt[i] = flight;
        strokes.push(current);
        jumps.push({ from: prev, to: cur, flight });
        current = [cur];
      } else {
        current.push(cur);
      }
    }
    strokes.push(current);
    return { strokes, jumps, isJumpAt, isFlightAt };
  }

  /**
   * Build a Scene for the given filtered dataset + render settings.
   * settings: {
   *   maxPoints, cameraMode ('fit'|'follow'|'reveal'), baseDuration (sec),
   *   dwellWeighting (bool), focusPoints: [{lat,lng,time,zoom,holdSeconds,label}],
   *   followZoom, padding, minZoom, maxZoom, canvasW, canvasH
   * }
   */
  function buildScene(filtered, settings) {
    const mustKeep = new Set(filtered.visits.map((v) => v.startTime));
    const points = decimate(filtered.points, settings.maxPoints || 4000, mustKeep);
    const { strokes, jumps, isJumpAt, isFlightAt } = buildStrokes(points);

    const cumDistanceKm = new Array(points.length).fill(0);
    for (let i = 1; i < points.length; i++) {
      const d = Geo.distanceMeters(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
      cumDistanceKm[i] = cumDistanceKm[i - 1] + d / 1000;
    }

    const allBox = Geo.boundingBox(points);
    const padding = settings.padding == null ? 60 : settings.padding;
    const minZoom = settings.minZoom == null ? 2 : settings.minZoom;
    const maxZoom = settings.maxZoom == null ? 18 : settings.maxZoom;
    const fitZoom = Geo.zoomForBounds(allBox, settings.canvasW, settings.canvasH, padding, minZoom, maxZoom);
    const fitCenter = Geo.center(allBox);

    // Progress weight per point index (0..1 cumulative), optionally inflated near long visits.
    const weights = new Array(points.length).fill(1);
    if (settings.dwellWeighting && filtered.visits.length) {
      for (const v of filtered.visits) {
        let idx = 0;
        for (let i = 0; i < points.length; i++) {
          if (points[i].time >= v.startTime) {
            idx = i;
            break;
          }
        }
        const bonus = Math.min(6, 1 + Math.sqrt(Math.max(v.durationMs, 0) / 3600000));
        for (let k = Math.max(0, idx - 1); k <= Math.min(points.length - 1, idx + 1); k++) {
          weights[k] = Math.max(weights[k], bonus);
        }
      }
    }
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + (weights[i - 1] + weights[i]) / 2);
    const totalWeight = cum[cum.length - 1] || 1;
    const progressAtIndex = cum.map((c) => c / totalWeight);

    function indexAtProgress(frac) {
      frac = Geo.clamp(frac, 0, 1);
      // binary search progressAtIndex for frac
      let lo = 0, hi = progressAtIndex.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (progressAtIndex[mid] < frac) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // Base camera as a function of progress fraction (0..1).
    function baseCamera(frac) {
      if (settings.cameraMode === 'follow') {
        const idx = indexAtProgress(frac);
        const p = points[Math.max(0, idx)] || fitCenter;
        return { center: { lat: p.lat, lng: p.lng }, zoom: settings.followZoom || 13 };
      }
      if (settings.cameraMode === 'reveal') {
        const idx = Math.max(1, indexAtProgress(frac));
        const box = Geo.boundingBox(points.slice(0, idx + 1)) || allBox;
        return {
          center: Geo.center(box),
          zoom: Geo.zoomForBounds(box, settings.canvasW, settings.canvasH, padding, minZoom, maxZoom),
        };
      }
      if (settings.cameraMode === 'cluster') {
        // Zoom in on wherever the action currently is: frame a sliding
        // real-time window around the current point instead of the whole
        // trip, so a weekday commute reads as a tight home<->work loop and
        // a weekend trip reads as the camera swooping out to that city.
        const idx = indexAtProgress(frac);
        const p = points[idx];
        if (!p) return { center: fitCenter, zoom: fitZoom };
        const windowMs = settings.clusterWindowMs == null ? 6 * 3600 * 1000 : settings.clusterWindowMs;
        const lo = timeLowerBound(points, p.time - windowMs);
        const hi = timeUpperBound(points, p.time + windowMs); // exclusive
        const windowPoints = points.slice(lo, Math.max(hi, lo + 1));
        let box = Geo.boundingBox(windowPoints) || Geo.boundingBox([p]);
        box = Geo.expandBoxToMinSpanKm(box, settings.clusterMinSpanKm == null ? 3 : settings.clusterMinSpanKm);
        return {
          center: Geo.center(box),
          zoom: Geo.zoomForBounds(box, settings.canvasW, settings.canvasH, padding, minZoom, maxZoom),
        };
      }
      // 'fit' (default): whole route framed for the entire video.
      return { center: fitCenter, zoom: fitZoom };
    }

    // Normalize + sort focus points by their source timestamp, map to base-progress.
    const focus = (settings.focusPoints || [])
      .filter((f) => f && isFinite(f.time))
      .map((f) => {
        const t = Geo.clamp(f.time, points[0] ? points[0].time : f.time, points[points.length - 1] ? points[points.length - 1].time : f.time);
        let idx = 0;
        for (let i = 0; i < points.length; i++) {
          if (points[i].time >= t) {
            idx = i;
            break;
          }
          idx = i;
        }
        return {
          lat: f.lat,
          lng: f.lng,
          zoom: f.zoom || 15,
          holdSeconds: f.holdSeconds == null ? 2.5 : f.holdSeconds,
          label: f.label || '',
          bt: (progressAtIndex[idx] || 0) * settings.baseDuration,
        };
      })
      .sort((a, b) => a.bt - b.bt);

    const TRANSITION = 0.7; // seconds to ease in/out of a focus zoom
    let cursor = 0;
    for (const f of focus) {
      f.extra = TRANSITION * 2 + f.holdSeconds;
      f.outputStart = f.bt + cursor;
      cursor += f.extra;
    }
    const totalDuration = settings.baseDuration + cursor;

    /**
     * Map output-time (seconds) -> { center, zoom, progressFrac, focusLabel }.
     * Focus windows are built with strictly increasing, non-overlapping
     * [outputStart, outputStart+extra] ranges (see the cursor loop above),
     * so a single linear scan is enough to tell whether `ot` falls inside one.
     */
    function cameraAtTime(ot) {
      for (const f of focus) {
        if (ot >= f.outputStart && ot <= f.outputStart + f.extra) {
          const localPhase = ot - f.outputStart;
          const frac = settings.baseDuration > 0 ? f.bt / settings.baseDuration : 1;
          const base = baseCamera(frac);
          const target = { center: { lat: f.lat, lng: f.lng }, zoom: f.zoom };
          let camera;
          if (localPhase < TRANSITION) {
            camera = blend(base, target, Geo.easeInOutCubic(localPhase / TRANSITION));
          } else if (localPhase < TRANSITION + f.holdSeconds) {
            camera = target;
          } else {
            camera = blend(target, base, Geo.easeInOutCubic((localPhase - TRANSITION - f.holdSeconds) / TRANSITION));
          }
          return { center: camera.center, zoom: camera.zoom, progressFrac: frac, focusLabel: f.label };
        }
      }
      let consumed = 0;
      for (const f of focus) {
        if (ot > f.outputStart + f.extra) consumed += f.extra;
      }
      const bt = Geo.clamp(ot - consumed, 0, settings.baseDuration);
      const frac = settings.baseDuration > 0 ? bt / settings.baseDuration : 1;
      const base = baseCamera(frac);

      // Cinematic finish: for a camera mode that normally stays zoomed into
      // local activity ('cluster'/'follow'), pull back to the full-route view
      // over the last stretch of the video so it ends on "here's everywhere
      // I went" right as the summary card comes in. A no-op for 'fit'/'reveal'
      // since they already converge on (roughly) the same full-route framing.
      if (settings.endingReveal !== false) {
        const revealWindow = Math.min(3, settings.baseDuration * 0.15);
        const revealStart = settings.baseDuration - revealWindow;
        if (revealWindow > 0 && bt >= revealStart) {
          const t = Geo.easeInOutCubic((bt - revealStart) / revealWindow);
          const revealed = blend(base, { center: fitCenter, zoom: fitZoom }, t);
          return { center: revealed.center, zoom: revealed.zoom, progressFrac: frac, focusLabel: null };
        }
      }

      return { center: base.center, zoom: base.zoom, progressFrac: frac, focusLabel: null };
    }

    function blend(a, b, t) {
      return {
        center: { lat: Geo.lerp(a.center.lat, b.center.lat, t), lng: Geo.lerpLng(a.center.lng, b.center.lng, t) },
        zoom: Geo.lerp(a.zoom, b.zoom, t),
      };
    }

    return {
      points,
      strokes,
      jumps,
      isJumpAt,
      isFlightAt,
      cumDistanceKm,
      visits: filtered.visits,
      segmentsMeta: filtered.segmentsMeta || [],
      totalDuration,
      cameraAtTime,
      indexAtProgress,
      fitCenter,
      fitZoom,
    };
  }

  const api = { filterRange, decimate, buildStrokes, buildScene, timeLowerBound, timeUpperBound };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.TimelineScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
