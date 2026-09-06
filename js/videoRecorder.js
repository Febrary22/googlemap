/**
 * videoRecorder.js — drives a canvas + optional audio track through
 * MediaRecorder in real time. Recording is real-time by nature
 * (MediaRecorder timestamps frames off the wall clock), so the draw loop
 * below advances the scene's output-time in lockstep with elapsed time;
 * tiles should already be prefetched before this starts so every frame is a
 * fast, synchronous canvas draw.
 */
(function (global) {
  'use strict';

  function pickMimeType() {
    const candidates = [
      // Prefer native MP4 where the browser supports it (e.g. Safari) since
      // it's playable everywhere without conversion; fall back to WebM.
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    for (const c of candidates) {
      if (global.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  class VideoRecorder {
    constructor(canvas) {
      this.canvas = canvas;
      this._cancelled = false;
      this._audioCtx = null;
    }

    cancel() {
      this._cancelled = true;
    }

    /**
     * options:
     *   fps, durationSeconds, drawFrame(ot) -> void,
     *   audio: { url, startOffset, volume, fadeOutSeconds } | null,
     *   onProgress(fraction, ot), onStatus(text)
     * Resolves to a Blob (webm) once recording completes, or null if cancelled.
     */
    async record(options) {
      this._cancelled = false;
      const { fps, durationSeconds, drawFrame, audio, onProgress, onStatus } = options;

      const canvasStream = this.canvas.captureStream(fps);
      let combined = canvasStream;
      let audioEl = null;
      let gainNode = null;

      if (audio && audio.url) {
        if (onStatus) onStatus('음악 준비 중...');
        const AudioCtx = global.AudioContext || global.webkitAudioContext;
        this._audioCtx = new AudioCtx();
        // Some browsers create contexts in a "suspended" state unless resumed
        // inside a user gesture; recording started from a click handler, so
        // this should succeed, but nudge it explicitly to be safe.
        await this._audioCtx.resume().catch(() => {});
        audioEl = new Audio();
        audioEl.src = audio.url;
        audioEl.crossOrigin = 'anonymous';
        audioEl.loop = true;
        await new Promise((resolve) => {
          audioEl.oncanplaythrough = resolve;
          audioEl.onerror = resolve;
          audioEl.load();
        });
        try {
          audioEl.currentTime = audio.startOffset || 0;
        } catch (e) {
          /* ignore seek errors on unready media */
        }
        const source = this._audioCtx.createMediaElementSource(audioEl);
        gainNode = this._audioCtx.createGain();
        gainNode.gain.value = audio.volume == null ? 0.8 : audio.volume;
        const dest = this._audioCtx.createMediaStreamDestination();
        source.connect(gainNode).connect(dest);
        gainNode.connect(this._audioCtx.destination); // so the user also hears it live while recording
        combined = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      }

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(combined, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };

      const done = new Promise((resolve) => {
        recorder.onstop = () => resolve();
      });

      if (onStatus) onStatus('녹화 중...');
      recorder.start(250);
      if (audioEl) {
        audioEl.play().catch(() => {});
      }

      const startedAt = performance.now();
      let raf;
      await new Promise((resolve) => {
        const loop = () => {
          const ot = (performance.now() - startedAt) / 1000;
          if (this._cancelled || ot >= durationSeconds) {
            drawFrame(durationSeconds);
            if (onProgress) onProgress(1, durationSeconds);
            resolve();
            return;
          }
          drawFrame(ot);
          if (onProgress) onProgress(ot / durationSeconds, ot);

          if (audioEl && gainNode && audio.fadeOutSeconds) {
            const remaining = durationSeconds - ot;
            if (remaining <= audio.fadeOutSeconds) {
              const targetGain = Math.max(0, (audio.volume == null ? 0.8 : audio.volume) * (remaining / audio.fadeOutSeconds));
              gainNode.gain.setTargetAtTime(targetGain, this._audioCtx.currentTime, 0.05);
            }
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      });
      if (raf) cancelAnimationFrame(raf);

      recorder.stop();
      canvasStream.getTracks().forEach((t) => t.stop());
      if (audioEl) {
        audioEl.pause();
      }
      await done;
      if (this._audioCtx) {
        await this._audioCtx.close().catch(() => {});
        this._audioCtx = null;
      }

      if (this._cancelled) return null;
      return new Blob(chunks, { type: mimeType || 'video/webm' });
    }
  }

  global.VideoRecorder = VideoRecorder;
})(typeof window !== 'undefined' ? window : globalThis);
