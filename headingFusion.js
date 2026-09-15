// NCC Stage107 heading fusion.
// Convention used everywhere in PDR: azimuth 0=N, 90=E, 180=S, 270=W.
// Fuses a magnetically-referenced absolute heading with gyroscope yaw-rate;
// accelerometer magnitude and optional direct magnetometer magnitude gate the
// correction so straight walking does not inherit compass jitter.

export function normalizeHeading(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

export function signedAngleDelta(target, current) {
  return ((Number(target) - Number(current) + 540) % 360) - 180;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function finite(v) { return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)); }

export class HeadingFusion {
  constructor(config = {}, callbacks = {}) {
    this.cfg = {
      magneticCorrectionGain: 0.012,
      disturbedCorrectionGain: 0.0015,
      movingCorrectionGain: 0.004,
      straightCorrectionGain: 0.0025,
      turnCorrectionGain: 0.008,
      deadbandDeg: 2.0,
      maxCorrectionDegPerReading: 0.25,
      maxGyroRateDps: 140,
      gyroDeadbandDps: 0.8,
      straightGyroThresholdDps: 5.0,
      accelTrustDeviationMps2: 1.8,
      magneticMinUt: 18,
      magneticMaxUt: 90,
      ...config,
    };
    this.cb = callbacks;
    this.absoluteRaw = null;
    this.absoluteCalibrated = null;
    this.absoluteBaseline = null;
    this.knownBaseline = null;
    this.fused = null;
    this.calibrated = false;
    this.gyroRateDps = 0;
    this.lastGyroTs = null;
    this.accelNorm = 9.80665;
    this.magneticFieldUt = null;
    this.sensorMode = 'fallback';
    this.genericSensors = [];
    this.genericGyroRateDps = null;
    this.lastOutputAt = 0;
  }

  setConfig(partial = {}) { this.cfg = { ...this.cfg, ...partial }; }

  async startOptionalGenericSensors() {
    const started = [];
    const start = (sensor, name, fn) => {
      sensor.addEventListener('reading', fn);
      sensor.addEventListener('error', e => this.cb.onDiagnostic?.(`${name}:${e.error?.name || e.error || 'error'}`));
      sensor.start(); this.genericSensors.push(sensor); started.push(name);
    };
    try {
      if ('Magnetometer' in window) {
        const s = new Magnetometer({ frequency: 20 });
        start(s, 'magnetometer', () => {
          if ([s.x,s.y,s.z].every(finite)) this.magneticFieldUt = Math.hypot(Number(s.x),Number(s.y),Number(s.z));
        });
      }
    } catch (e) { this.cb.onDiagnostic?.(`magnetometer-unavailable:${e.name || e}`); }
    try {
      if ('Gyroscope' in window) {
        const s = new Gyroscope({ frequency: 50 });
        start(s, 'gyroscope', () => {
          // Generic Sensor Gyroscope values are angular velocity. Use device-Z
          // as a fallback yaw-rate only when DeviceMotion rotationRate is absent.
          if (finite(s.z)) this.genericGyroRateDps = -Number(s.z) * 180 / Math.PI;
        });
      }
    } catch (e) { this.cb.onDiagnostic?.(`gyroscope-unavailable:${e.name || e}`); }
    try {
      if ('Accelerometer' in window) {
        const s = new Accelerometer({ frequency: 30 });
        start(s, 'accelerometer', () => {
          if ([s.x,s.y,s.z].every(finite)) this.accelNorm = Math.hypot(Number(s.x),Number(s.y),Number(s.z));
        });
      }
    } catch (e) { this.cb.onDiagnostic?.(`accelerometer-unavailable:${e.name || e}`); }
    // Starting AbsoluteOrientationSensor is useful as a capability check: the
    // platform-level absolute orientation itself is already sensor-fused from
    // accelerometer+gyroscope+magnetometer. DeviceOrientation remains the
    // cross-browser absolute-heading measurement used below.
    try {
      if ('AbsoluteOrientationSensor' in window) {
        const s = new AbsoluteOrientationSensor({ frequency: 30, referenceFrame: 'device' });
        start(s, 'absolute-orientation', () => {});
      }
    } catch (e) { this.cb.onDiagnostic?.(`absolute-orientation-unavailable:${e.name || e}`); }
    if (started.length) this.sensorMode = `web-fusion:${started.join('+')}`;
    return started;
  }

  stop() {
    for (const s of this.genericSensors) { try { s.stop(); } catch {} }
    this.genericSensors = [];
  }

  screenAngle() {
    const a = Number(screen.orientation?.angle ?? window.orientation ?? 0);
    return Number.isFinite(a) ? a : 0;
  }

  pushOrientation(event, timestampMs = performance.now()) {
    let heading = null;
    let source = null;
    if (finite(event.webkitCompassHeading)) {
      heading = normalizeHeading(Number(event.webkitCompassHeading) + this.screenAngle());
      source = 'webkit-compass';
    } else if (finite(event.alpha)) {
      // DeviceOrientation alpha is counter-clockwise from north; NCC azimuth is
      // clockwise from north. Hence 360-alpha, with screen-angle compensation.
      heading = normalizeHeading(360 - Number(event.alpha) + this.screenAngle());
      source = event.absolute ? 'deviceorientation-absolute' : 'deviceorientation';
    }
    if (!finite(heading)) return null;
    this.sensorMode = this.sensorMode.startsWith('web-fusion') ? this.sensorMode : source;
    return this.pushAbsoluteHeading(heading, timestampMs, source);
  }

  pushMotion(event, timestampMs = performance.now()) {
    const a = event.accelerationIncludingGravity || event.acceleration;
    if (a && [a.x,a.y,a.z].every(finite)) this.accelNorm = Math.hypot(Number(a.x),Number(a.y),Number(a.z));

    let rawRate = null;
    if (event.rotationRate && finite(event.rotationRate.alpha)) {
      // rotationRate.alpha follows the DeviceOrientation alpha sense. Convert
      // to clockwise-positive NCC azimuth by negating it.
      rawRate = -Number(event.rotationRate.alpha);
    } else if (finite(this.genericGyroRateDps)) {
      rawRate = Number(this.genericGyroRateDps);
    }
    if (!finite(rawRate)) return this.heading();
    rawRate = clamp(rawRate, -this.cfg.maxGyroRateDps, this.cfg.maxGyroRateDps);
    if (Math.abs(rawRate) < Number(this.cfg.gyroDeadbandDps ?? 0.8)) rawRate = 0;
    this.gyroRateDps = rawRate;

    if (this.lastGyroTs != null) {
      const dt = clamp((timestampMs - this.lastGyroTs) / 1000, 0, 0.12);
      if (dt > 0 && this.calibrated && finite(this.fused)) {
        this.fused = normalizeHeading(this.fused + rawRate * dt);
        this.#emit(timestampMs, 'gyro-predict');
      }
    }
    this.lastGyroTs = timestampMs;
    return this.heading();
  }

  pushAbsoluteHeading(rawHeading, timestampMs = performance.now(), source = 'absolute') {
    const raw = normalizeHeading(rawHeading);
    this.absoluteRaw = raw;
    if (!this.calibrated) {
      this.cb.onAbsolute?.(raw, source);
      return raw;
    }
    // Calibration may be pressed before the first absolute-orientation sample.
    // Capture that first sample as the magnetic baseline instead of leaving the
    // filter permanently unreferenced.
    if (!finite(this.absoluteBaseline)) {
      this.absoluteBaseline = raw;
      this.absoluteCalibrated = normalizeHeading(this.knownBaseline);
      if (!finite(this.fused)) this.fused = this.absoluteCalibrated;
      this.cb.onAbsolute?.(raw, source);
      this.#emit(timestampMs, 'absolute-baseline-captured');
      return this.fused;
    }
    this.absoluteCalibrated = normalizeHeading(this.knownBaseline + signedAngleDelta(raw, this.absoluteBaseline));
    if (!finite(this.fused)) this.fused = this.absoluteCalibrated;

    const diff = signedAngleDelta(this.absoluteCalibrated, this.fused);
    const accelDev = Math.abs(Number(this.accelNorm || 9.80665) - 9.80665);
    const magKnown = finite(this.magneticFieldUt);
    const magGood = !magKnown || (this.magneticFieldUt >= this.cfg.magneticMinUt && this.magneticFieldUt <= this.cfg.magneticMaxUt);
    // Straight-motion lock: gyroscope carries the short-term heading and the
    // magnetic reference is allowed to correct drift only very slowly. This is
    // intentionally conservative indoors, where compass readings can jitter.
    const absGyro = Math.abs(Number(this.gyroRateDps || 0));
    let gain = absGyro < Number(this.cfg.straightGyroThresholdDps ?? 5)
      ? Number(this.cfg.straightCorrectionGain ?? 0.0025)
      : Number(this.cfg.turnCorrectionGain ?? 0.008);
    if (!magGood) gain = Math.min(gain, Number(this.cfg.disturbedCorrectionGain ?? 0.0015));
    else if (accelDev > this.cfg.accelTrustDeviationMps2) gain = Math.min(gain, Number(this.cfg.movingCorrectionGain ?? 0.004));

    let correction = 0;
    if (Math.abs(diff) > this.cfg.deadbandDeg) {
      correction = clamp(diff * gain, -this.cfg.maxCorrectionDegPerReading, this.cfg.maxCorrectionDegPerReading);
    }
    this.fused = normalizeHeading(this.fused + correction);
    this.#emit(timestampMs, 'absolute-correct');
    this.cb.onAbsolute?.(raw, source);
    return this.fused;
  }

  calibrate(knownHeadingDeg) {
    const known = normalizeHeading(knownHeadingDeg);
    this.knownBaseline = known;
    this.absoluteBaseline = finite(this.absoluteRaw) ? this.absoluteRaw : null;
    this.absoluteCalibrated = known;
    this.fused = known;
    this.calibrated = true;
    this.lastGyroTs = null;
    this.#emit(performance.now(), 'calibrated');
    return this.snapshot();
  }

  clearCalibration() {
    this.calibrated = false;
    this.absoluteBaseline = null;
    this.knownBaseline = null;
    this.absoluteCalibrated = null;
    this.fused = null;
    this.lastGyroTs = null;
  }

  heading() {
    return finite(this.fused) ? normalizeHeading(this.fused)
      : finite(this.absoluteRaw) ? normalizeHeading(this.absoluteRaw)
      : null;
  }

  magneticQuality() {
    if (!finite(this.magneticFieldUt)) return 'unknown';
    return this.magneticFieldUt >= this.cfg.magneticMinUt && this.magneticFieldUt <= this.cfg.magneticMaxUt ? 'good' : 'disturbed';
  }

  snapshot() {
    return {
      headingDeg: this.heading(), calibrated: this.calibrated,
      absoluteRawDeg: this.absoluteRaw, absoluteCalibratedDeg: this.absoluteCalibrated,
      gyroRateDps: this.gyroRateDps, accelNorm: this.accelNorm,
      magneticFieldUt: this.magneticFieldUt, magneticQuality: this.magneticQuality(),
      sensorMode: this.sensorMode,
    };
  }

  #emit(timestampMs, phase) {
    this.lastOutputAt = timestampMs;
    this.cb.onHeading?.(this.heading(), { ...this.snapshot(), phase });
  }
}
