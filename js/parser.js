/**
 * parser.js — turns one or more Google Timeline export files into a single
 * normalized dataset the rest of the app can work with, regardless of which
 * export format Google handed the user:
 *
 *  - On-device "Timeline.json" (Android/iPhone export since the Dec 2024
 *    migration): top-level `semanticSegments` (+ optional `rawSignals`).
 *  - Google Takeout "Semantic Location History" monthly files: top-level
 *    `timelineObjects` with `placeVisit` / `activitySegment`.
 *  - Google Takeout "Records.json": top-level `locations` array of raw
 *    E7-encoded location pings.
 *
 * The parser is deliberately permissive: coordinates show up as
 * "geo:lat,lng" strings, "lat°, lng°" strings, {latitude,longitude},
 * {lat,lng} or {latitudeE7,longitudeE7} depending on the export, so a
 * generic extractor is used everywhere instead of hard-coding one shape.
 */
(function (global) {
  'use strict';

  /** Pull two floats out of almost any coordinate representation. Returns null if it can't. */
  function extractLatLng(value) {
    if (value == null) return null;

    if (typeof value === 'object') {
      if (typeof value.latitudeE7 === 'number' && typeof value.longitudeE7 === 'number') {
        return { lat: value.latitudeE7 / 1e7, lng: value.longitudeE7 / 1e7 };
      }
      if (typeof value.latE7 === 'number' && typeof value.lngE7 === 'number') {
        return { lat: value.latE7 / 1e7, lng: value.lngE7 / 1e7 };
      }
      if (typeof value.latitude === 'number' && typeof value.longitude === 'number') {
        return { lat: value.latitude, lng: value.longitude };
      }
      if (typeof value.lat === 'number' && typeof value.lng === 'number') {
        return { lat: value.lat, lng: value.lng };
      }
      if (value.latLng) return extractLatLng(value.latLng);
      if (value.point) return extractLatLng(value.point);
      if (value.placeLocation) return extractLatLng(value.placeLocation);
      if (value.LatLng) return extractLatLng(value.LatLng);
      return null;
    }

    if (typeof value === 'string') {
      // Matches "geo:37.4,-122.1", "37.4219999°, -122.0862500°", "37.4,-122.1", etc.
      const nums = value.match(/-?\d+\.\d+/g);
      if (nums && nums.length >= 2) {
        const lat = parseFloat(nums[0]);
        const lng = parseFloat(nums[1]);
        if (isFinite(lat) && isFinite(lng)) return { lat, lng };
      }
    }
    return null;
  }

  function isValidLatLng(p) {
    return (
      p &&
      isFinite(p.lat) &&
      isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180 &&
      !(p.lat === 0 && p.lng === 0)
    );
  }

  function toMillis(value) {
    if (value == null) return NaN;
    if (typeof value === 'number') {
      // Heuristic: seconds vs. milliseconds vs. microseconds epoch.
      if (value > 1e17) return Math.round(value / 1000); // microseconds
      if (value > 1e12) return Math.round(value); // already ms
      if (value > 1e9) return Math.round(value * 1000); // seconds
      return Math.round(value);
    }
    if (typeof value === 'string') {
      const n = Number(value);
      if (!Number.isNaN(n) && /^\d+$/.test(value.trim())) return toMillis(n);
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return t;
    }
    return NaN;
  }

  function pushPoint(points, lat, lng, time, extra) {
    if (!isFinite(time)) return;
    const p = { lat, lng, time };
    if (extra) Object.assign(p, extra);
    points.push(p);
  }

  /** Parse the new on-device export: { semanticSegments: [...], rawSignals: [...] } */
  function parseSemanticSegments(json, points, visits, segmentsMeta) {
    const segs = json.semanticSegments;
    if (!Array.isArray(segs)) return;

    for (const seg of segs) {
      const segStart = toMillis(seg.startTime);
      const segEnd = toMillis(seg.endTime);

      if (seg.visit) {
        const top = seg.visit.topCandidate || {};
        const loc = extractLatLng(top.placeLocation) || extractLatLng(seg.visit.placeLocation);
        if (loc && isValidLatLng(loc)) {
          const start = segStart, end = isFinite(segEnd) ? segEnd : segStart;
          pushPoint(points, loc.lat, loc.lng, start, { type: 'visit' });
          visits.push({
            lat: loc.lat,
            lng: loc.lng,
            startTime: start,
            endTime: end,
            durationMs: isFinite(end) && isFinite(start) ? end - start : 0,
            placeName: top.semanticType || top.placeId || '방문 장소',
          });
        }
      } else if (seg.activity) {
        const act = seg.activity;
        const start = extractLatLng(act.start);
        const end = extractLatLng(act.end);
        const activityType = (act.topCandidate && act.topCandidate.type) || undefined;
        const distanceMeters = act.distanceMeters ? Number(act.distanceMeters) : undefined;
        if (start && isValidLatLng(start)) pushPoint(points, start.lat, start.lng, segStart, { type: 'path' });
        if (end && isValidLatLng(end)) pushPoint(points, end.lat, end.lng, segEnd, { type: 'path' });
        if (start && end && isValidLatLng(start) && isValidLatLng(end)) {
          segmentsMeta.push({
            startTime: segStart,
            endTime: segEnd,
            startLat: start.lat,
            startLng: start.lng,
            endLat: end.lat,
            endLng: end.lng,
            activityType,
            distanceMeters,
          });
        }
      } else if (Array.isArray(seg.timelinePath)) {
        for (const step of seg.timelinePath) {
          const loc = extractLatLng(step.point) || extractLatLng(step);
          const t = toMillis(step.time) || segStart;
          if (loc && isValidLatLng(loc)) pushPoint(points, loc.lat, loc.lng, t, { type: 'path' });
        }
      }
    }
  }

  /** Supplemental raw GPS pings: { rawSignals: [{ position: {...}, timestamp }] } */
  function parseRawSignals(json, points) {
    const raw = json.rawSignals;
    if (!Array.isArray(raw)) return;
    for (const sig of raw) {
      const pos = sig.position;
      if (!pos) continue;
      const loc = extractLatLng(pos.LatLng) || extractLatLng(pos.latLng) || extractLatLng(pos);
      const t = toMillis(pos.timestamp || sig.timestamp);
      if (loc && isValidLatLng(loc)) pushPoint(points, loc.lat, loc.lng, t, { type: 'path', raw: true });
    }
  }

  /** Legacy Takeout "Semantic Location History": { timelineObjects: [...] } */
  function parseTimelineObjects(json, points, visits, segmentsMeta) {
    const objs = json.timelineObjects;
    if (!Array.isArray(objs)) return;

    for (const obj of objs) {
      if (obj.placeVisit) {
        const pv = obj.placeVisit;
        const loc = extractLatLng(pv.location);
        const start = toMillis(pv.duration && (pv.duration.startTimestamp || pv.duration.startTimestampMs));
        const end = toMillis(pv.duration && (pv.duration.endTimestamp || pv.duration.endTimestampMs));
        if (loc && isValidLatLng(loc)) {
          pushPoint(points, loc.lat, loc.lng, start, { type: 'visit' });
          visits.push({
            lat: loc.lat,
            lng: loc.lng,
            startTime: start,
            endTime: isFinite(end) ? end : start,
            durationMs: isFinite(end) && isFinite(start) ? end - start : 0,
            placeName: pv.location.name || pv.location.address || '방문 장소',
          });
        }
      } else if (obj.activitySegment) {
        const as = obj.activitySegment;
        const start = toMillis(as.duration && (as.duration.startTimestamp || as.duration.startTimestampMs));
        const end = toMillis(as.duration && (as.duration.endTimestamp || as.duration.endTimestampMs));
        const startLoc = extractLatLng(as.startLocation);
        const endLoc = extractLatLng(as.endLocation);
        if (startLoc && isValidLatLng(startLoc)) pushPoint(points, startLoc.lat, startLoc.lng, start, { type: 'path' });

        const waypoints = (as.waypointPath && as.waypointPath.waypoints) ||
          (as.simplifiedRawPath && as.simplifiedRawPath.points) || [];
        if (waypoints.length) {
          const span = isFinite(end) && isFinite(start) ? end - start : 0;
          waypoints.forEach((wp, i) => {
            const loc = extractLatLng(wp);
            const t = toMillis(wp.timestamp) || (isFinite(start) ? start + (span * (i + 1)) / (waypoints.length + 1) : NaN);
            if (loc && isValidLatLng(loc)) pushPoint(points, loc.lat, loc.lng, t, { type: 'path' });
          });
        }
        if (endLoc && isValidLatLng(endLoc)) pushPoint(points, endLoc.lat, endLoc.lng, end, { type: 'path' });

        if (startLoc && endLoc && isValidLatLng(startLoc) && isValidLatLng(endLoc)) {
          segmentsMeta.push({
            startTime: start,
            endTime: end,
            startLat: startLoc.lat,
            startLng: startLoc.lng,
            endLat: endLoc.lat,
            endLng: endLoc.lng,
            activityType: as.activityType,
            distanceMeters: as.distance,
          });
        }
      }
    }
  }

  /** Legacy Takeout "Records.json": { locations: [{ latitudeE7, longitudeE7, timestamp|timestampMs }] } */
  function parseRecords(json, points) {
    const locs = json.locations;
    if (!Array.isArray(locs)) return;
    for (const loc of locs) {
      const p = extractLatLng(loc);
      const t = toMillis(loc.timestamp != null ? loc.timestamp : loc.timestampMs);
      if (p && isValidLatLng(p)) pushPoint(points, p.lat, p.lng, t, { type: 'path' });
    }
  }

  /** Parse one already-JSON.parsed object into the shared accumulators. */
  function parseOne(json, points, visits, segmentsMeta) {
    if (!json || typeof json !== 'object') return;
    parseSemanticSegments(json, points, visits, segmentsMeta);
    parseRawSignals(json, points);
    parseTimelineObjects(json, points, visits, segmentsMeta);
    parseRecords(json, points);
  }

  function dedupeSort(points) {
    points.sort((a, b) => a.time - b.time);
    const out = [];
    let lastKey = null;
    for (const p of points) {
      const key = p.time + '|' + p.lat.toFixed(6) + '|' + p.lng.toFixed(6);
      if (key === lastKey) continue;
      lastKey = key;
      out.push(p);
    }
    return out;
  }

  /**
   * Parse a list of File objects (from an <input type=file multiple>).
   * Returns a Promise<NormalizedData>.
   */
  async function parseFiles(fileList, onProgress) {
    const files = Array.from(fileList);
    const points = [];
    const visits = [];
    const segmentsMeta = [];
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (onProgress) onProgress({ index: i, total: files.length, name: file.name });
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (Array.isArray(json)) {
          // Some exports (rare) are a bare array of timelineObjects.
          parseOne({ timelineObjects: json }, points, visits, segmentsMeta);
        } else {
          parseOne(json, points, visits, segmentsMeta);
        }
      } catch (err) {
        failed++;
        console.warn('Failed to parse', file.name, err);
      }
    }

    const cleanPoints = dedupeSort(points.filter((p) => isValidLatLng(p) && isFinite(p.time)));
    visits.sort((a, b) => a.startTime - b.startTime);
    segmentsMeta.sort((a, b) => a.startTime - b.startTime);

    const stats = {
      totalPoints: cleanPoints.length,
      totalVisits: visits.length,
      minTime: cleanPoints.length ? cleanPoints[0].time : null,
      maxTime: cleanPoints.length ? cleanPoints[cleanPoints.length - 1].time : null,
      failedFiles: failed,
      totalFiles: files.length,
    };

    return { points: cleanPoints, visits, segmentsMeta, stats };
  }

  const api = { parseFiles, extractLatLng, toMillis, isValidLatLng };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.TimelineParser = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
