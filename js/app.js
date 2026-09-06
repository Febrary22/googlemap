/**
 * app.js — wires the DOM (index.html) to the parser/timeline/renderer
 * modules and holds all UI state. Everything here runs only in the
 * browser; no data ever leaves it (no fetch to any first-party backend —
 * the only network calls are read-only map tile requests).
 */
(function () {
  'use strict';

  const STEPS = ['guide', 'upload', 'settings', 'render'];
  const PREVIEW_PLAY_SECONDS = 8;

  const State = {
    currentStep: 'guide',
    maxStepIndex: 0,
    rawData: null, // { points, visits, segmentsMeta, stats }
    range: { startMs: null, endMs: null },
    filtered: null, // { points, visits, segmentsMeta }
    yearRows: [],
    autoVisitCandidates: [],
    customFocusPoints: [],
    musicFile: null,
    musicUrl: null,
    previewMapRenderer: null,
    renderMapRenderer: null,
    previewScene: null,
    previewSettings: null,
    pickerMap: null,
    pendingFocusLatLng: null,
    recorder: null,
    renderScene: null,
    resultVideoUrl: null,
  };

  function $(id) {
    // Tolerate an optional leading "#" so both $('foo') and $('#foo') work.
    return document.getElementById(id.charAt(0) === '#' ? id.slice(1) : id);
  }
  function $$(sel, root) {
    return (root || document).querySelectorAll(sel);
  }

  // ---------------------------------------------------------------------
  // Step navigation
  // ---------------------------------------------------------------------

  function goToStep(name) {
    State.currentStep = name;
    const idx = STEPS.indexOf(name);
    if (idx > State.maxStepIndex) State.maxStepIndex = idx;
    $$('.step-panel').forEach((p) => p.classList.toggle('active', p.id === 'step-' + name));
    $$('#stepper .step').forEach((li) => {
      const liIdx = STEPS.indexOf(li.dataset.step);
      li.classList.toggle('active', li.dataset.step === name);
      li.classList.toggle('done', liIdx < idx);
      li.classList.toggle('reachable', liIdx <= State.maxStepIndex);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (name === 'settings') {
      applyAspectToPreviewCanvas();
      buildAutoVisitsList();
      rebuildPreviewScene();
    }
    if (name === 'render') {
      resetRenderUI();
    }
  }

  function bindStepper() {
    $('#stepper').addEventListener('click', (e) => {
      const li = e.target.closest('.step');
      if (!li) return;
      const idx = STEPS.indexOf(li.dataset.step);
      if (idx <= State.maxStepIndex) goToStep(li.dataset.step);
    });
    $('#btn-guide-next').addEventListener('click', () => goToStep('upload'));
    $('#btn-upload-back').addEventListener('click', () => goToStep('guide'));
    $('#btn-upload-next').addEventListener('click', () => goToStep('settings'));
    $('#btn-settings-back').addEventListener('click', () => goToStep('upload'));
    $('#btn-settings-next').addEventListener('click', () => goToStep('render'));
    $('#btn-render-back').addEventListener('click', () => goToStep('settings'));
  }

  // ---------------------------------------------------------------------
  // Step 1: guide tabs
  // ---------------------------------------------------------------------

  function bindGuideTabs() {
    $('#guide-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      $$('.tab').forEach((t) => {
        t.classList.toggle('active', t === btn);
        t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
      });
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
    });
  }

  // ---------------------------------------------------------------------
  // Step 2: upload + date range
  // ---------------------------------------------------------------------

  function bindDropzone() {
    const dz = $('#dropzone');
    dz.addEventListener('click', () => $('#file-input').click());
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    $('#file-input').addEventListener('change', (e) => {
      if (e.target.files.length) handleFiles(e.target.files);
    });
  }

  async function handleFiles(fileList) {
    $('#upload-progress').hidden = false;
    $('#data-summary').hidden = true;
    $('#range-section').hidden = true;
    $('#btn-upload-next').disabled = true;
    $('#upload-progress-fill').style.width = '0%';

    let result;
    try {
      result = await TimelineParser.parseFiles(fileList, ({ index, total, name }) => {
        $('#upload-progress-fill').style.width = `${Math.round((index / total) * 100)}%`;
        $('#upload-progress-text').textContent = `(${index + 1}/${total}) ${name} 처리 중...`;
      });
    } catch (err) {
      console.error(err);
      $('#upload-progress').hidden = true;
      alert('파일을 읽는 중 문제가 발생했어요. 구글 타임라인에서 내려받은 JSON 파일이 맞는지 확인해주세요.');
      return;
    }

    $('#upload-progress').hidden = true;

    if (!result.points.length) {
      alert('위치 데이터를 찾지 못했어요. Timeline.json, Records.json 또는 Semantic Location History 파일을 올려주세요.');
      return;
    }

    State.rawData = result;
    State.customFocusPoints = [];
    renderCustomFocusList();

    $('#sum-points').textContent = result.stats.totalPoints.toLocaleString();
    $('#sum-visits').textContent = result.stats.totalVisits.toLocaleString();
    $('#sum-range').textContent = `${SceneRenderer.formatDate(result.stats.minTime)} ~ ${SceneRenderer.formatDate(result.stats.maxTime)}`;
    $('#data-summary').hidden = false;
    $('#range-section').hidden = false;

    buildYearGrid(result.stats);
    $$('.chip').forEach((c) => c.classList.toggle('active', c.dataset.preset === 'all'));
    setRange(result.stats.minTime, result.stats.maxTime);
  }

  function toDateInputValue(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fromDateInputValue(str, endOfDay) {
    const [y, m, d] = str.split('-').map(Number);
    if (endOfDay) return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }

  function toDisplayDate(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  }

  function setRange(startMs, endMs, opts) {
    opts = opts || {};
    if (!State.rawData) return;
    startMs = Math.max(startMs, State.rawData.stats.minTime);
    endMs = Math.min(endMs, State.rawData.stats.maxTime);
    if (endMs < startMs) endMs = startMs;
    State.range.startMs = startMs;
    State.range.endMs = endMs;
    $('#range-start').value = toDateInputValue(startMs);
    $('#range-end').value = toDateInputValue(endMs);
    if (!opts.fromCheckboxes) syncCheckboxesToRange(startMs, endMs);
    recomputeFiltered();
  }

  function recomputeFiltered() {
    if (!State.rawData) return;
    const { startMs, endMs } = State.range;
    const points = State.rawData.points.filter((p) => p.time >= startMs && p.time <= endMs);
    const visits = State.rawData.visits.filter((v) => v.startTime >= startMs && v.startTime <= endMs);
    State.filtered = { points, visits, segmentsMeta: State.rawData.segmentsMeta };
    updateRangeStats();
    $('#btn-upload-next').disabled = points.length < 2;
  }

  function updateRangeStats() {
    if (!State.filtered) return;
    const { startMs, endMs } = State.range;
    const days = Math.round((endMs - startMs) / 86400000) + 1;
    $('#range-stats').textContent =
      `선택한 기간: ${toDisplayDate(startMs)} ~ ${toDisplayDate(endMs)} (${days.toLocaleString()}일) · ` +
      `지점 ${State.filtered.points.length.toLocaleString()}개 · 방문 ${State.filtered.visits.length.toLocaleString()}곳`;
    if (State.filtered.points.length < 2) {
      $('#range-stats').textContent += ' — 이 기간에는 영상을 만들 만큼의 기록이 없어요.';
    }
  }

  function buildYearGrid(stats) {
    const grid = $('#year-grid');
    grid.innerHTML = '';
    State.yearRows = [];
    if (!stats.minTime) return;

    const minYear = new Date(stats.minTime).getFullYear();
    const maxYear = new Date(stats.maxTime).getFullYear();
    const presence = new Set();
    for (const p of State.rawData.points) {
      const d = new Date(p.time);
      presence.add(d.getFullYear() * 100 + d.getMonth());
    }

    for (let y = maxYear; y >= minYear; y--) {
      const row = document.createElement('div');
      row.className = 'year-row';

      const header = document.createElement('div');
      header.className = 'year-row-header';

      const expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'year-expand';
      expand.textContent = '▸';
      expand.setAttribute('aria-label', `${y}년 월별 보기`);

      const yearLabel = document.createElement('label');
      const yearCb = document.createElement('input');
      yearCb.type = 'checkbox';
      yearLabel.append(yearCb, document.createTextNode(` ${y}년`));

      header.append(expand, yearLabel);

      const monthsRow = document.createElement('div');
      monthsRow.className = 'month-row';
      monthsRow.hidden = true;
      const monthCbs = [];
      for (let m = 0; m < 12; m++) {
        const has = presence.has(y * 100 + m);
        const mLabel = document.createElement('label');
        mLabel.className = 'month-cb';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.disabled = !has;
        mLabel.append(cb, document.createTextNode(`${m + 1}월`));
        if (!has) mLabel.classList.add('empty');
        monthsRow.appendChild(mLabel);
        monthCbs.push(cb);
      }

      expand.addEventListener('click', () => {
        monthsRow.hidden = !monthsRow.hidden;
        expand.textContent = monthsRow.hidden ? '▸' : '▾';
      });

      yearCb.addEventListener('change', () => {
        monthCbs.forEach((cb) => {
          if (!cb.disabled) cb.checked = yearCb.checked;
        });
        yearCb.indeterminate = false;
        recomputeRangeFromCheckboxes();
      });

      monthCbs.forEach((cb) => {
        cb.addEventListener('change', () => {
          const enabled = monthCbs.filter((c) => !c.disabled);
          const checkedCount = enabled.filter((c) => c.checked).length;
          yearCb.checked = enabled.length > 0 && checkedCount === enabled.length;
          yearCb.indeterminate = checkedCount > 0 && checkedCount < enabled.length;
          recomputeRangeFromCheckboxes();
        });
      });

      row.append(header, monthsRow);
      grid.appendChild(row);
      State.yearRows.push({ year: y, yearCb, monthCbs });
    }
  }

  function recomputeRangeFromCheckboxes() {
    let minMs = null;
    let maxMs = null;
    for (const { year, monthCbs } of State.yearRows) {
      monthCbs.forEach((cb, m) => {
        if (cb.checked) {
          const start = new Date(year, m, 1, 0, 0, 0, 0).getTime();
          const end = new Date(year, m + 1, 1, 0, 0, 0, 0).getTime() - 1;
          if (minMs === null || start < minMs) minMs = start;
          if (maxMs === null || end > maxMs) maxMs = end;
        }
      });
    }
    if (minMs === null) return;
    setRange(minMs, maxMs, { fromCheckboxes: true });
  }

  function syncCheckboxesToRange(startMs, endMs) {
    for (const { year, monthCbs } of State.yearRows) {
      monthCbs.forEach((cb, m) => {
        if (cb.disabled) return;
        const mStart = new Date(year, m, 1, 0, 0, 0, 0).getTime();
        const mEnd = new Date(year, m + 1, 1, 0, 0, 0, 0).getTime() - 1;
        const fully = mStart >= startMs && mEnd <= endMs;
        const overlaps = mStart <= endMs && mEnd >= startMs;
        cb.checked = fully;
        cb.indeterminate = !fully && overlaps;
      });
    }
    // Reconcile each year's own checkbox against the state of its months.
    State.yearRows.forEach(({ yearCb, monthCbs }) => {
      const enabled = monthCbs.filter((c) => !c.disabled);
      const checkedCount = enabled.filter((c) => c.checked).length;
      yearCb.checked = enabled.length > 0 && checkedCount === enabled.length;
      yearCb.indeterminate = checkedCount > 0 && checkedCount < enabled.length;
    });
  }

  function bindRangeControls() {
    $('#preset-buttons').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn || !State.rawData) return;
      const now = new Date();
      const bounds = State.rawData.stats;
      let startMs, endMs;
      switch (btn.dataset.preset) {
        case 'this-year':
          startMs = new Date(now.getFullYear(), 0, 1).getTime();
          endMs = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();
          break;
        case 'last-year':
          startMs = new Date(now.getFullYear() - 1, 0, 1).getTime();
          endMs = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999).getTime();
          break;
        case 'last-5-years':
          startMs = new Date(now.getFullYear() - 4, 0, 1).getTime();
          endMs = bounds.maxTime;
          break;
        default:
          startMs = bounds.minTime;
          endMs = bounds.maxTime;
      }
      $$('.chip').forEach((c) => c.classList.toggle('active', c === btn));
      setRange(startMs, endMs);
    });

    $('#range-start').addEventListener('change', () => {
      if (!$('#range-start').value) return;
      $$('.chip').forEach((c) => c.classList.remove('active'));
      setRange(fromDateInputValue($('#range-start').value, false), State.range.endMs);
    });
    $('#range-end').addEventListener('change', () => {
      if (!$('#range-end').value) return;
      $$('.chip').forEach((c) => c.classList.remove('active'));
      setRange(State.range.startMs, fromDateInputValue($('#range-end').value, true));
    });
  }

  // ---------------------------------------------------------------------
  // Step 3: video settings
  // ---------------------------------------------------------------------

  function formatDuration(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}시간 ${m}분`;
    return `${m}분`;
  }

  function displayPlaceName(v) {
    const KNOWN = { Home: '🏠 집', Work: '💼 직장' };
    if (v.placeName && KNOWN[v.placeName]) return KNOWN[v.placeName];
    if (v.placeName && /^[A-Za-z0-9_-]{15,}$/.test(v.placeName)) return '📍 방문 장소';
    return v.placeName ? `📍 ${v.placeName}` : '📍 방문 장소';
  }

  function buildAutoVisitsList() {
    const container = $('#auto-visits-list');
    container.innerHTML = '';
    State.autoVisitCandidates = [];
    if (!State.filtered) return;

    const candidates = State.filtered.visits
      .filter((v) => v.durationMs >= 15 * 60 * 1000)
      .slice()
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 15)
      .sort((a, b) => a.startTime - b.startTime);

    State.autoVisitCandidates = candidates;
    if (!candidates.length) {
      container.innerHTML = '<p class="muted small">이 기간에는 뚜렷한 장기 체류 장소가 없어요.</p>';
      return;
    }
    candidates.forEach((v, i) => {
      const row = document.createElement('label');
      row.className = 'visit-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.idx = String(i);
      cb.addEventListener('change', scheduleRebuildPreview);
      const text = document.createElement('span');
      text.textContent = `${displayPlaceName(v)} · ${SceneRenderer.formatDate(v.startTime)} · ${formatDuration(v.durationMs)}`;
      row.append(cb, text);
      container.appendChild(row);
    });
  }

  function getAutoFocusPoints() {
    const out = [];
    $$('#auto-visits-list input[type=checkbox]:checked').forEach((cb) => {
      const v = State.autoVisitCandidates[Number(cb.dataset.idx)];
      if (v) {
        out.push({
          lat: v.lat,
          lng: v.lng,
          time: (v.startTime + v.endTime) / 2,
          zoom: 15,
          holdSeconds: 2.5,
          label: displayPlaceName(v),
        });
      }
    });
    return out;
  }

  function renderCustomFocusList() {
    const container = $('#custom-focus-list');
    container.innerHTML = '';
    State.customFocusPoints.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'focus-row';
      const span = document.createElement('span');
      span.textContent = `📌 ${f.label} · 확대 ${f.zoom} · ${f.holdSeconds}초`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-x';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        State.customFocusPoints = State.customFocusPoints.filter((x) => x.id !== f.id);
        renderCustomFocusList();
        scheduleRebuildPreview();
      });
      row.append(span, del);
      container.appendChild(row);
    });
  }

  function sampleForPreview(points) {
    if (points.length <= 2000) return points;
    const stride = Math.ceil(points.length / 2000);
    return points.filter((_, i) => i % stride === 0);
  }

  function nearestPointTime(latlng) {
    if (!State.filtered || !State.filtered.points.length) return Date.now();
    let best = null;
    let bestD = Infinity;
    for (const p of State.filtered.points) {
      const d = Geo.distanceMeters(p.lat, p.lng, latlng.lat, latlng.lng);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? best.time : Date.now();
  }

  function bindFocusModal() {
    $('#btn-add-focus').addEventListener('click', () => {
      $('#focus-modal').hidden = false;
      State.pendingFocusLatLng = null;
      $('#btn-focus-add').disabled = true;
      $('#focus-label').value = '';
      $('#focus-zoom').value = '15';
      $('#echo-focus-zoom').textContent = '15';
      $('#focus-hold').value = '2.5';
      $('#echo-focus-hold').textContent = '2.5초';

      if (!State.pickerMap) {
        State.pickerMap = new PickerMap($('#picker-map'));
        State.pickerMap.onPick = (lat, lng) => {
          State.pendingFocusLatLng = { lat, lng };
          $('#btn-focus-add').disabled = false;
        };
      } else {
        State.pickerMap.clearMarker();
      }
      setTimeout(() => {
        State.pickerMap.invalidate();
        if (State.filtered) State.pickerMap.setRoutePreview(sampleForPreview(State.filtered.points));
      }, 50);
    });

    $('#btn-focus-cancel').addEventListener('click', () => {
      $('#focus-modal').hidden = true;
    });

    $('#btn-focus-add').addEventListener('click', () => {
      if (!State.pendingFocusLatLng) return;
      const time = nearestPointTime(State.pendingFocusLatLng);
      State.customFocusPoints.push({
        id: Date.now() + Math.random(),
        lat: State.pendingFocusLatLng.lat,
        lng: State.pendingFocusLatLng.lng,
        time,
        zoom: Number($('#focus-zoom').value),
        holdSeconds: Number($('#focus-hold').value),
        label: $('#focus-label').value.trim() || '📍 관심 지점',
      });
      $('#focus-modal').hidden = true;
      renderCustomFocusList();
      scheduleRebuildPreview();
    });
  }

  function syncFieldVisibility() {
    $('#row-line-color').hidden = $('#opt-line-colormode').value !== 'solid';
    const isFadeTrail = $('#opt-trail-mode').value === 'fade';
    $('#row-trail-hours').hidden = !isFadeTrail;
    $('#hint-trail-hours').hidden = !isFadeTrail;
    $('#row-follow-zoom').hidden = $('#opt-camera-mode').value !== 'follow';
    const isCluster = $('#opt-camera-mode').value === 'cluster';
    $('#row-cluster-window').hidden = !isCluster;
    $('#hint-cluster-mode').hidden = !isCluster;
  }

  function bindEcho(inputSel, echoSel, fmt) {
    const input = $(inputSel.replace('#', ''));
    const echo = $(echoSel.replace('#', ''));
    const update = () => {
      echo.textContent = fmt(input.value);
    };
    input.addEventListener('input', update);
    update();
  }

  function getOutputDims() {
    const aspect = $('opt-aspect').value;
    const res = Number($('opt-resolution').value);
    let w, h;
    if (aspect === '9:16') {
      w = res;
      h = Math.round((res * 16) / 9);
    } else if (aspect === '1:1') {
      w = res;
      h = res;
    } else {
      h = res;
      w = Math.round((res * 16) / 9);
    }
    return { w, h };
  }

  function applyAspectToPreviewCanvas() {
    const { w, h } = getOutputDims();
    const maxW = 480, maxH = 480;
    let scale = maxW / w;
    let pw = Math.round(w * scale), ph = Math.round(h * scale);
    if (ph > maxH) {
      scale = maxH / h;
      pw = Math.round(w * scale);
      ph = Math.round(h * scale);
    }
    const canvas = $('preview-canvas');
    canvas.width = pw;
    canvas.height = ph;
  }

  function gatherSettings(canvasW, canvasH) {
    const provider = document.getElementById('opt-provider').value;
    return {
      maxPoints: 5000,
      cameraMode: document.getElementById('opt-camera-mode').value,
      baseDuration: Number(document.getElementById('opt-duration').value),
      dwellWeighting: document.getElementById('opt-dwell-weighting').checked,
      focusPoints: getAutoFocusPoints().concat(State.customFocusPoints),
      followZoom: Number(document.getElementById('opt-follow-zoom').value),
      clusterWindowMs: Number(document.getElementById('opt-cluster-window').value) * 3600 * 1000,
      padding: Math.round(canvasW * 0.08),
      minZoom: 2,
      maxZoom: provider === 'satellite' ? 19 : 18,
      canvasW,
      canvasH,
      provider,
      lineColorMode: document.getElementById('opt-line-colormode').value,
      lineColor: document.getElementById('opt-line-color').value,
      lineWidth: Number(document.getElementById('opt-line-width').value),
      lineStyle: document.getElementById('opt-line-style').value,
      trailMode: document.getElementById('opt-trail-mode').value,
      trailHours: Number(document.getElementById('opt-trail-hours').value),
      overlayDate: document.getElementById('opt-overlay-date').checked,
      overlayStats: document.getElementById('opt-overlay-stats').checked,
      overlayProgressBar: document.getElementById('opt-overlay-progressbar').checked,
      overlaySummary: document.getElementById('opt-overlay-summary').checked,
    };
  }

  let previewDebounceTimer = null;
  function scheduleRebuildPreview() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(rebuildPreviewScene, 180);
  }

  function rebuildPreviewScene() {
    if (!State.filtered || State.filtered.points.length < 2) return;
    const canvas = $('preview-canvas');
    const settings = gatherSettings(canvas.width, canvas.height);
    State.previewSettings = settings;
    State.previewMapRenderer.setProvider(settings.provider);
    State.previewScene = TimelineScene.buildScene(State.filtered, settings);
    const frac = Number($('preview-scrub').value);
    requestPreviewRedraw(frac * State.previewScene.totalDuration);
  }

  let previewRedrawRetryTimer = null;
  function requestPreviewRedraw(ot) {
    drawPreviewFrame(ot);
    clearTimeout(previewRedrawRetryTimer);
    previewRedrawRetryTimer = setTimeout(() => drawPreviewFrame(ot), 500); // catch tiles that finished loading late
  }

  function drawPreviewFrame(ot) {
    if (!State.previewScene) return;
    const canvas = $('preview-canvas');
    const ctx = canvas.getContext('2d');
    SceneRenderer.drawSceneFrame(State.previewMapRenderer, State.previewScene, ot, State.previewSettings, ctx, canvas.width, canvas.height);
  }

  let previewPlayRaf = null;
  let previewPlayStarted = 0;
  function stopPreviewPlayback() {
    if (previewPlayRaf) {
      cancelAnimationFrame(previewPlayRaf);
      previewPlayRaf = null;
      $('btn-preview-play').textContent = '▶ 미리보기 재생';
    }
  }

  function bindPreviewControls() {
    $('preview-scrub').addEventListener('input', () => {
      stopPreviewPlayback();
      if (State.previewScene) drawPreviewFrame(Number($('preview-scrub').value) * State.previewScene.totalDuration);
    });
    $('btn-preview-play').addEventListener('click', () => {
      if (previewPlayRaf) {
        stopPreviewPlayback();
        return;
      }
      if (!State.previewScene) return;
      previewPlayStarted = performance.now();
      $('btn-preview-play').textContent = '⏸ 정지';
      const loop = () => {
        const elapsed = (performance.now() - previewPlayStarted) / 1000;
        let frac = elapsed / PREVIEW_PLAY_SECONDS;
        if (frac >= 1) {
          frac = 0;
          previewPlayStarted = performance.now();
        }
        $('preview-scrub').value = String(frac);
        drawPreviewFrame(frac * State.previewScene.totalDuration);
        previewPlayRaf = requestAnimationFrame(loop);
      };
      previewPlayRaf = requestAnimationFrame(loop);
    });
  }

  function bindSettingsControls() {
    document.getElementById('opt-line-colormode').addEventListener('change', syncFieldVisibility);
    document.getElementById('opt-trail-mode').addEventListener('change', syncFieldVisibility);
    document.getElementById('opt-camera-mode').addEventListener('change', syncFieldVisibility);

    bindEcho('opt-line-width', 'echo-line-width', (v) => `${v}px`);
    bindEcho('opt-trail-hours', 'echo-trail-hours', (v) => `${v}시간`);
    bindEcho('opt-follow-zoom', 'echo-follow-zoom', (v) => `${v}`);
    bindEcho('opt-cluster-window', 'echo-cluster-window', (v) => `±${v}시간`);
    bindEcho('opt-music-volume', 'echo-music-volume', (v) => `${Math.round(Number(v) * 100)}%`);
    bindEcho('opt-music-start', 'echo-music-start', (v) => `${v}초`);
    bindEcho('opt-duration', 'echo-duration', (v) => `${v}초`);
    bindEcho('focus-zoom', 'echo-focus-zoom', (v) => `${v}`);
    bindEcho('focus-hold', 'echo-focus-hold', (v) => `${v}초`);

    document.getElementById('opt-aspect').addEventListener('change', () => {
      applyAspectToPreviewCanvas();
      scheduleRebuildPreview();
    });
    document.getElementById('opt-resolution').addEventListener('change', () => {
      applyAspectToPreviewCanvas();
      scheduleRebuildPreview();
    });

    document.querySelectorAll('.settings-form input, .settings-form select').forEach((el) => {
      el.addEventListener('input', scheduleRebuildPreview);
      el.addEventListener('change', scheduleRebuildPreview);
    });

    document.getElementById('opt-music-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (State.musicUrl) URL.revokeObjectURL(State.musicUrl);
      if (!file) {
        State.musicUrl = null;
        State.musicFile = null;
        $('music-controls').hidden = true;
        return;
      }
      State.musicFile = file;
      State.musicUrl = URL.createObjectURL(file);
      $('music-controls').hidden = false;
    });
    $('btn-clear-music').addEventListener('click', () => {
      document.getElementById('opt-music-file').value = '';
      if (State.musicUrl) URL.revokeObjectURL(State.musicUrl);
      State.musicUrl = null;
      State.musicFile = null;
      $('music-controls').hidden = true;
    });
  }

  // ---------------------------------------------------------------------
  // Step 4: render
  // ---------------------------------------------------------------------

  function resetRenderUI() {
    $('render-result').hidden = true;
    $('render-controls-idle').hidden = false;
    $('render-controls-active').hidden = true;
    $('render-progress-fill').style.width = '0%';
    $('render-status').textContent = '대기 중...';
    if (State.resultVideoUrl) {
      URL.revokeObjectURL(State.resultVideoUrl);
      State.resultVideoUrl = null;
    }
  }

  async function startRender() {
    if (!State.filtered || State.filtered.points.length < 2) return;
    const { w, h } = getOutputDims();
    const canvas = $('render-canvas');
    canvas.width = w;
    canvas.height = h;

    const settings = gatherSettings(w, h);
    const renderer = State.renderMapRenderer;
    renderer.setProvider(settings.provider);
    const scene = TimelineScene.buildScene(State.filtered, settings);
    State.renderScene = scene;

    $('render-controls-idle').hidden = true;
    $('render-controls-active').hidden = false;
    $('render-status').textContent = '지도 타일 불러오는 중...';
    $('render-progress-fill').style.width = '0%';

    const sampleCount = Math.max(20, Math.round(scene.totalDuration * 2));
    const samples = [];
    for (let i = 0; i <= sampleCount; i++) {
      samples.push(scene.cameraAtTime((scene.totalDuration * i) / sampleCount));
    }
    await renderer.prefetch(samples, w, h, (frac) => {
      $('render-progress-fill').style.width = `${Math.round(frac * 35)}%`;
      $('render-status').textContent = `지도 타일 불러오는 중... ${Math.round(frac * 100)}%`;
    });

    const fps = Number(document.getElementById('opt-fps').value);
    const musicFile = document.getElementById('opt-music-file').files[0];
    const audio = musicFile
      ? {
          url: State.musicUrl,
          startOffset: Number(document.getElementById('opt-music-start').value),
          volume: Number(document.getElementById('opt-music-volume').value),
          fadeOutSeconds: document.getElementById('opt-music-fadeout').checked ? Math.min(3, scene.totalDuration * 0.15) : 0,
        }
      : null;

    State.recorder = new VideoRecorder(canvas);
    const ctx = canvas.getContext('2d');

    let blob = null;
    try {
      blob = await State.recorder.record({
        fps,
        durationSeconds: scene.totalDuration,
        drawFrame: (ot) => SceneRenderer.drawSceneFrame(renderer, scene, ot, settings, ctx, w, h),
        audio,
        onProgress: (frac) => {
          $('render-progress-fill').style.width = `${35 + Math.round(frac * 65)}%`;
          $('render-status').textContent = `녹화 중... ${Math.round(frac * 100)}%`;
        },
        onStatus: (text) => {
          $('render-status').textContent = text;
        },
      });
    } catch (err) {
      console.error(err);
      $('render-status').textContent = '녹화 중 오류가 발생했어요. 브라우저가 영상 녹화를 지원하는지 확인해주세요 (최신 크롬/엣지/파이어폭스 권장).';
      $('render-controls-active').hidden = true;
      $('render-controls-idle').hidden = false;
      return;
    }

    $('render-controls-active').hidden = true;
    $('render-controls-idle').hidden = false;

    if (!blob) {
      $('render-status').textContent = '중지되었어요.';
      $('render-progress-fill').style.width = '0%';
      return;
    }

    const isMp4 = blob.type.includes('mp4');
    const ext = isMp4 ? 'mp4' : 'webm';
    State.resultVideoUrl = URL.createObjectURL(blob);
    $('result-video').src = State.resultVideoUrl;
    const dl = $('btn-download');
    dl.href = State.resultVideoUrl;
    dl.download = `my-timeline.${ext}`;
    $('format-note').textContent = isMp4
      ? '✅ MP4 형식으로 만들어졌어요. 대부분의 기기와 메신저에서 바로 재생·공유할 수 있어요.'
      : '✅ WebM 형식으로 만들어졌어요. 크롬·엣지·파이어폭스·대부분의 안드로이드 기기에서 바로 재생돼요. MP4가 꼭 필요하면 무료 온라인 변환기로 손쉽게 바꿀 수 있어요.';
    $('render-status').textContent = '완료!';
    $('render-progress-fill').style.width = '100%';
    $('render-result').hidden = false;
  }

  function bindRenderControls() {
    $('btn-render-start').addEventListener('click', startRender);
    $('btn-render-cancel').addEventListener('click', () => {
      if (State.recorder) State.recorder.cancel();
    });
    $('btn-rerender').addEventListener('click', () => goToStep('settings'));
    $('btn-restart').addEventListener('click', () => {
      if (confirm('처음부터 다시 시작할까요? 지금까지의 설정이 초기화돼요.')) location.reload();
    });
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    State.previewMapRenderer = new MapCanvasRenderer($('preview-canvas'), { provider: 'voyager' });
    State.renderMapRenderer = new MapCanvasRenderer($('render-canvas'), { provider: 'voyager' });

    bindStepper();
    bindGuideTabs();
    bindDropzone();
    bindRangeControls();
    bindSettingsControls();
    bindFocusModal();
    bindPreviewControls();
    bindRenderControls();

    syncFieldVisibility();
    applyAspectToPreviewCanvas();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
