import { normalizeHeading, projectStep } from './utm.js';

export class CircularHeadingFilter {
  constructor(alpha = 0.22) {
    this.alpha = alpha;
    this.x = null;
    this.y = null;
  }
  reset() { this.x = this.y = null; }
  push(degrees) {
    const h = normalizeHeading(degrees);
    const r = h * Math.PI / 180;
    const sx = Math.sin(r), cy = Math.cos(r);
    if (this.x == null) { this.x = sx; this.y = cy; }
    else {
      this.x = (1 - this.alpha) * this.x + this.alpha * sx;
      this.y = (1 - this.alpha) * this.y + this.alpha * cy;
    }
    return normalizeHeading(Math.atan2(this.x, this.y) * 180 / Math.PI);
  }
}

export class PdrEngine {
  constructor(config = {}, callbacks = {}) {
    this.cfg = { ...config };
    this.cb = callbacks;
    this.active = false;
    this.anchor = null;
    this.current = null;
    this.stepCount = 0;
    this.distanceM = 0;
    this.lastStepAt = 0;
    this.lastSampleAt = 0;
    this.baseline = 9.80665;
    this.signal = 0;
    this.prev2 = null;
    this.prev1 = null;
    this.armed = true;
    this.headingDeg = 0;
    this.headingFilter = new CircularHeadingFilter(this.cfg.headingAlpha ?? 0.22);
    this.samples = [];
    this.stepTimes = [];
  }

  setConfig(partial) {
    this.cfg = { ...this.cfg, ...partial };
    if (partial.headingAlpha != null) this.headingFilter.alpha = Number(partial.headingAlpha);
  }

  setHeading(rawHeadingDeg) {
    this.headingDeg = this.headingFilter.push(rawHeadingDeg);
    this.cb.onHeading?.(this.headingDeg);
    return this.headingDeg;
  }

  setAnchor(anchor, { keepActive = true } = {}) {
    const e = Number(anchor.e ?? anchor.utm_easting);
    const n = Number(anchor.n ?? anchor.utm_northing);
    const h = Number(anchor.h ?? anchor.display_altitude ?? 0);
    if (!Number.isFinite(e) || !Number.isFinite(n)) throw new Error('QR anchor UTM is invalid.');
    this.anchor = { ...anchor, e, n, h };
    this.current = { easting: e, northing: n, h };
    this.stepCount = 0;
    this.distanceM = 0;
    this.lastStepAt = 0;
    this.stepTimes = [];
    this.armed = true;
    this.prev1 = this.prev2 = null;
    this.active = Boolean(keepActive && this.active);
    this.cb.onAnchor?.(this.snapshot());
  }

  start() {
    if (!this.anchor || !this.current) throw new Error('ابتدا یک QR Anchor معتبر ثبت کنید.');
    this.active = true;
    this.armed = true;
    this.cb.onState?.(this.snapshot());
  }

  stop() {
    this.active = false;
    this.cb.onState?.(this.snapshot());
  }

  resetToAnchor() {
    if (!this.anchor) return;
    this.current = { easting: this.anchor.e, northing: this.anchor.n, h: this.anchor.h };
    this.stepCount = 0;
    this.distanceM = 0;
    this.lastStepAt = 0;
    this.stepTimes = [];
    this.armed = true;
    this.cb.onReset?.(this.snapshot());
  }

  pushAcceleration(ax, ay, az, timestampMs = performance.now()) {
    const x = Number(ax), y = Number(ay), z = Number(az);
    if (![x, y, z].every(Number.isFinite)) return null;
    const norm = Math.hypot(x, y, z);
    const ba = Number(this.cfg.baselineAlpha ?? 0.025);
    this.baseline += ba * (norm - this.baseline);
    const dynamic = norm - this.baseline;
    const sa = Number(this.cfg.signalAlpha ?? 0.35);
    this.signal = sa * dynamic + (1 - sa) * this.signal;
    this.lastSampleAt = timestampMs;

    const sample = { t: timestampMs, norm, baseline: this.baseline, dynamic: this.signal, step: false };
    this.samples.push(sample);
    const maxSamples = Number(this.cfg.chartSamples ?? 180);
    if (this.samples.length > maxSamples) this.samples.splice(0, this.samples.length - maxSamples);

    const resetThreshold = Number(this.cfg.resetThresholdMps2 ?? 0.18);
    if (this.signal < resetThreshold) this.armed = true;

    const current = { t: timestampMs, value: this.signal };
    if (this.prev2 && this.prev1) {
      const isPeak = this.prev1.value > this.prev2.value && this.prev1.value >= current.value;
      if (isPeak) this.#considerPeak(this.prev1);
    }
    this.prev2 = this.prev1;
    this.prev1 = current;
    this.cb.onSample?.(sample, this.samples);
    return sample;
  }

  #considerPeak(candidate) {
    if (!this.active || !this.current || !this.armed) return;
    const threshold = Number(this.cfg.peakThresholdMps2 ?? 0.9);
    const maxPeak = Number(this.cfg.maxPeakMps2 ?? 4.5);
    const minDt = Number(this.cfg.minStepIntervalMs ?? 350);
    if (candidate.value < threshold || candidate.value > maxPeak) return;
    if (this.lastStepAt && candidate.t - this.lastStepAt < minDt) return;

    const dt = this.lastStepAt ? candidate.t - this.lastStepAt : null;
    this.lastStepAt = candidate.t;
    this.armed = false;
    this.stepCount += 1;
    const stepLength = Number(this.cfg.stepLengthM ?? 0.7);
    this.distanceM += stepLength;
    const moved = projectStep(this.current.easting, this.current.northing, stepLength, this.headingDeg);
    this.current.easting = moved.easting;
    this.current.northing = moved.northing;
    if (dt && dt < Number(this.cfg.cadenceResetMs ?? 1800)) {
      this.stepTimes.push(candidate.t);
      if (this.stepTimes.length > 8) this.stepTimes.shift();
    } else {
      this.stepTimes = [candidate.t];
    }
    const lastSample = this.samples.at(-1);
    if (lastSample) lastSample.step = true;
    this.cb.onStep?.(this.snapshot({ peak: candidate.value }));
  }

  cadenceSpm() {
    if (this.stepTimes.length < 2) return 0;
    const dt = this.stepTimes.at(-1) - this.stepTimes[0];
    if (dt <= 0) return 0;
    return (this.stepTimes.length - 1) * 60000 / dt;
  }

  snapshot(extra = {}) {
    return {
      active: this.active,
      anchor: this.anchor ? { ...this.anchor } : null,
      easting: this.current?.easting ?? null,
      northing: this.current?.northing ?? null,
      h: this.current?.h ?? null,
      headingDeg: this.headingDeg,
      stepCount: this.stepCount,
      distanceM: this.distanceM,
      cadenceSpm: this.cadenceSpm(),
      dynamicAccel: this.signal,
      baseline: this.baseline,
      ...extra,
    };
  }
}
