// NCC Stage107.7.1 heading fusion.
// PDR azimuth convention: 0=N, 90=E, 180=S, 270=W.
//
// Design goals:
// 1) Initial heading is automatic from an EARTH-referenced orientation source.
// 2) AbsoluteOrientationSensor / deviceorientationabsolute is the long-term truth.
// 3) Gyroscope is used only as a short-term predictor, therefore gyro drift cannot
//    accumulate while a fresh absolute reference is available.
// 4) Raw Magnetometer is diagnostic only. Android browsers may expose an absolute
//    orientation without exposing the Magnetometer API directly.
// 5) Non-absolute deviceorientation events never auto-calibrate the compass.

export function normalizeHeading(value) {
  const n = Number(value);
  return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

export function signedAngleDelta(target, current) {
  return ((Number(target) - Number(current) + 540) % 360) - 180;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function finite(v) { return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)); }

function circularMean(values) {
  if (!values?.length) return null;
  let sx = 0, cy = 0;
  for (const value of values) {
    const r = normalizeHeading(value) * Math.PI / 180;
    sx += Math.sin(r);
    cy += Math.cos(r);
  }
  if (Math.abs(sx) < 1e-12 && Math.abs(cy) < 1e-12) return null;
  return normalizeHeading(Math.atan2(sx, cy) * 180 / Math.PI);
}

function circularSpreadDeg(values, meanDeg) {
  if (!values?.length || !finite(meanDeg)) return Infinity;
  const rms = Math.sqrt(values.reduce((acc, value) => {
    const d = signedAngleDelta(value, meanDeg);
    return acc + d * d;
  }, 0) / values.length);
  return rms;
}

function circularBlend(currentDeg, targetDeg, gain) {
  if (!finite(targetDeg)) return finite(currentDeg) ? normalizeHeading(currentDeg) : null;
  if (!finite(currentDeg)) return normalizeHeading(targetDeg);
  return normalizeHeading(Number(currentDeg) + signedAngleDelta(targetDeg, currentDeg) * clamp(Number(gain), 0, 1));
}

// AbsoluteOrientationSensor quaternion is the rotation of the device/screen local
// coordinate system in relation to the Earth frame (X=east, Y=magnetic north,
// Z=sky). The top of the screen is local +Y. Rotate [0,1,0] into Earth frame and
// convert its horizontal projection to azimuth atan2(East, North).
export function headingFromAbsoluteQuaternion(quaternion) {
  if (!quaternion || quaternion.length < 4) return null;
  const x = Number(quaternion[0]);
  const y = Number(quaternion[1]);
  const z = Number(quaternion[2]);
  const w = Number(quaternion[3]);
  if (![x, y, z, w].every(Number.isFinite)) return null;

  // second column of the standard quaternion rotation matrix (local +Y vector)
  const east = 2 * (x * y - z * w);
  const north = 1 - 2 * (x * x + z * z);
  const horizontal = Math.hypot(east, north);
  if (horizontal < 0.08) return null; // top edge is almost vertical; azimuth is ill-conditioned
  return normalizeHeading(Math.atan2(east, north) * 180 / Math.PI);
}

export class HeadingFusion {
  constructor(config = {}, callbacks = {}) {
    this.cfg = {
      absoluteSmoothingAlpha: 0.18,
      absoluteCorrectionGain: 0.35,
      movingCorrectionGain: 0.22,
      disturbedCorrectionGain: 0.08,
      deadbandDeg: 0.35,
      maxCorrectionDegPerReading: 4.0,
      gyroDeadbandDps: 0.7,
      maxGyroRateDps: 180,
      gyroPredictionGainFresh: 0.18,
      absoluteFreshMs: 750,
      accelTrustDeviationMps2: 2.2,
      magneticMinUt: 18,
      magneticMaxUt: 90,
      initialAbsoluteSamples: 6,
      initialMaxSamples: 16,
      initialSpreadDeg: 28,
      ...config,
    };
    this.cb = callbacks;

    this.absoluteRaw = null;
    this.absoluteFiltered = null;
    this.absoluteCalibrated = null;
    this.absoluteSource = null;
    this.lastAbsoluteAt = 0;
    this.initialAbsoluteSamples = [];
    this.relativeRaw = null;

    this.headingOffsetDeg = 0;
    this.manualOverride = false;
    this.fused = null;
    this.calibrated = false;

    this.gyroRateDps = 0;
    this.genericGyro = { x: null, y: null, z: null };
    this.lastGyroTs = null;
    this.accelNorm = 9.80665;
    this.magneticFieldUt = null;

    this.sensorMode = 'waiting-absolute';
    this.capabilities = [];
    this.genericSensors = [];
    this.lastOutputAt = 0;
    this.lastRelativeDiagnosticAt = 0;
  }

  setConfig(partial = {}) { this.cfg = { ...this.cfg, ...partial }; }

  async startOptionalGenericSensors() {
    // Prevent duplicate sensors when the user taps Enable more than once.
    this.stopGenericSensors();
    const started = [];

    const start = (sensor, name, fn) => {
      sensor.addEventListener('reading', fn);
      sensor.addEventListener('error', e => {
        this.cb.onDiagnostic?.(`${name}:${e.error?.name || e.error || 'error'}`);
      });
      sensor.start();
      this.genericSensors.push(sensor);
      started.push(name);
    };

    try {
      if ('Magnetometer' in window) {
        const s = new Magnetometer({ frequency: 20 });
        start(s, 'magnetometer', () => {
          if ([s.x, s.y, s.z].every(finite)) {
            this.magneticFieldUt = Math.hypot(Number(s.x), Number(s.y), Number(s.z));
          }
        });
      }
    } catch (e) {
      this.cb.onDiagnostic?.(`magnetometer-unavailable:${e.name || e}`);
    }

    try {
      if ('Gyroscope' in window) {
        const s = new Gyroscope({ frequency: 50 });
        start(s, 'gyroscope', () => {
          if (finite(s.x)) this.genericGyro.x = Number(s.x) * 180 / Math.PI;
          if (finite(s.y)) this.genericGyro.y = Number(s.y) * 180 / Math.PI;
          if (finite(s.z)) this.genericGyro.z = Number(s.z) * 180 / Math.PI;
        });
      }
    } catch (e) {
      this.cb.onDiagnostic?.(`gyroscope-unavailable:${e.name || e}`);
    }

    try {
      if ('Accelerometer' in window) {
        const s = new Accelerometer({ frequency: 30 });
        start(s, 'accelerometer', () => {
          if ([s.x, s.y, s.z].every(finite)) {
            this.accelNorm = Math.hypot(Number(s.x), Number(s.y), Number(s.z));
          }
        });
      }
    } catch (e) {
      this.cb.onDiagnostic?.(`accelerometer-unavailable:${e.name || e}`);
    }

    // This is the preferred Android/Chrome path. Unlike the previous Stage107
    // implementation, Stage107.7.1 actually consumes the absolute quaternion.
    try {
      if ('AbsoluteOrientationSensor' in window) {
        let s;
        try {
          s = new AbsoluteOrientationSensor({ frequency: 30, referenceFrame: 'screen' });
        } catch {
          s = new AbsoluteOrientationSensor({ frequency: 30, referenceFrame: 'device' });
        }
        start(s, 'absolute-orientation', () => {
          const heading = headingFromAbsoluteQuaternion(s.quaternion);
          if (finite(heading)) {
            this.pushAbsoluteHeading(heading, performance.now(), 'absolute-orientation-sensor');
          }
        });
      }
    } catch (e) {
      this.cb.onDiagnostic?.(`absolute-orientation-unavailable:${e.name || e}`);
    }

    this.capabilities = started;
    if (started.length) this.cb.onDiagnostic?.(`generic-sensors:${started.join('+')}`);
    return started;
  }

  stopGenericSensors() {
    for (const s of this.genericSensors) {
      try { s.stop(); } catch {}
    }
    this.genericSensors = [];
    this.capabilities = [];
  }

  stop() { this.stopGenericSensors(); }

  screenAngle() {
    const a = Number(screen.orientation?.angle ?? window.orientation ?? 0);
    return Number.isFinite(a) ? a : 0;
  }

  pushOrientation(event, timestampMs = performance.now(), options = {}) {
    let heading = null;
    let source = null;
    let absolute = false;

    if (finite(event.webkitCompassHeading)) {
      heading = normalizeHeading(Number(event.webkitCompassHeading) + this.screenAngle());
      source = 'webkit-compass';
      absolute = true;
    } else if (finite(event.alpha)) {
      heading = normalizeHeading(360 - Number(event.alpha) + this.screenAngle());
      absolute = Boolean(options.forceAbsolute || event.absolute === true);
      source = absolute ? 'deviceorientation-absolute' : 'deviceorientation-relative';
    }

    if (!finite(heading)) return null;

    if (absolute) {
      return this.pushAbsoluteHeading(heading, timestampMs, source);
    }

    // Keep relative orientation only as a diagnostic. It has an arbitrary
    // reference and can drift, so it must never become the initial north azimuth.
    this.relativeRaw = heading;
    if (timestampMs - this.lastRelativeDiagnosticAt > 5000 && !this.calibrated) {
      this.lastRelativeDiagnosticAt = timestampMs;
      this.cb.onDiagnostic?.('relative-orientation-received-but-not-used-as-north-reference');
    }
    return this.heading();
  }

  pushMotion(event, timestampMs = performance.now()) {
    const a = event.accelerationIncludingGravity || event.acceleration;
    if (a && [a.x, a.y, a.z].every(finite)) {
      this.accelNorm = Math.hypot(Number(a.x), Number(a.y), Number(a.z));
    }

    let rawRate = null;
    if (event.rotationRate && finite(event.rotationRate.alpha)) {
      // DeviceOrientation alpha is opposite to compass heading, so negate alpha.
      rawRate = -Number(event.rotationRate.alpha);
    } else if (finite(this.genericGyro.z)) {
      rawRate = -Number(this.genericGyro.z);
    }

    if (!finite(rawRate)) return this.heading();
    rawRate = clamp(rawRate, -this.cfg.maxGyroRateDps, this.cfg.maxGyroRateDps);
    if (Math.abs(rawRate) < Number(this.cfg.gyroDeadbandDps ?? 0.7)) rawRate = 0;
    this.gyroRateDps = rawRate;

    if (this.lastGyroTs != null) {
      const dt = clamp((timestampMs - this.lastGyroTs) / 1000, 0, 0.12);
      if (dt > 0 && this.calibrated && finite(this.fused)) {
        const absoluteFresh = this.absoluteAgeMs(timestampMs) <= Number(this.cfg.absoluteFreshMs ?? 750);
        const gain = absoluteFresh ? Number(this.cfg.gyroPredictionGainFresh ?? 0.18) : 1;
        this.fused = normalizeHeading(this.fused + rawRate * dt * gain);
        this.#emit(timestampMs, absoluteFresh ? 'gyro-predict-bounded' : 'gyro-only-degraded');
      }
    }
    this.lastGyroTs = timestampMs;
    return this.heading();
  }

  pushAbsoluteHeading(rawHeading, timestampMs = performance.now(), source = 'absolute') {
    const raw = normalizeHeading(rawHeading);
    this.absoluteRaw = raw;
    this.absoluteSource = source;
    this.lastAbsoluteAt = timestampMs;
    this.absoluteFiltered = circularBlend(
      this.absoluteFiltered,
      raw,
      Number(this.cfg.absoluteSmoothingAlpha ?? 0.18),
    );

    const correctedTarget = normalizeHeading(this.absoluteFiltered + this.headingOffsetDeg);
    this.absoluteCalibrated = correctedTarget;

    if (!this.calibrated) {
      this.initialAbsoluteSamples.push(raw);
      const maxSamples = Math.max(4, Number(this.cfg.initialMaxSamples ?? 16));
      if (this.initialAbsoluteSamples.length > maxSamples) {
        this.initialAbsoluteSamples.splice(0, this.initialAbsoluteSamples.length - maxSamples);
      }
      const minSamples = Math.max(3, Number(this.cfg.initialAbsoluteSamples ?? 6));
      if (this.initialAbsoluteSamples.length >= minSamples) {
        const mean = circularMean(this.initialAbsoluteSamples);
        const spread = circularSpreadDeg(this.initialAbsoluteSamples, mean);
        if (spread <= Number(this.cfg.initialSpreadDeg ?? 28) || this.initialAbsoluteSamples.length >= maxSamples) {
          this.headingOffsetDeg = 0;
          this.manualOverride = false;
          this.absoluteFiltered = mean;
          this.absoluteCalibrated = mean;
          this.fused = mean;
          this.calibrated = true;
          this.sensorMode = `absolute:${source}`;
          this.lastGyroTs = null;
          this.cb.onDiagnostic?.(`absolute-auto-init:${source}:${mean.toFixed(1)}deg:spread=${spread.toFixed(1)}`);
          this.#emit(timestampMs, 'absolute-auto-init');
        } else {
          this.cb.onDiagnostic?.(`absolute-init-wait:spread=${spread.toFixed(1)}deg`);
        }
      }
      this.cb.onAbsolute?.(raw, source);
      return this.heading();
    }

    this.sensorMode = this.manualOverride ? `absolute+override:${source}` : `absolute:${source}`;
    const diff = signedAngleDelta(correctedTarget, this.fused);
    const accelDev = Math.abs(Number(this.accelNorm || 9.80665) - 9.80665);
    const magKnown = finite(this.magneticFieldUt);
    const magGood = !magKnown || (
      this.magneticFieldUt >= Number(this.cfg.magneticMinUt ?? 18)
      && this.magneticFieldUt <= Number(this.cfg.magneticMaxUt ?? 90)
    );

    let gain = Number(this.cfg.absoluteCorrectionGain ?? 0.35);
    if (!magGood) gain = Math.min(gain, Number(this.cfg.disturbedCorrectionGain ?? 0.08));
    else if (accelDev > Number(this.cfg.accelTrustDeviationMps2 ?? 2.2)) {
      gain = Math.min(gain, Number(this.cfg.movingCorrectionGain ?? 0.22));
    }

    let correction = 0;
    if (Math.abs(diff) > Number(this.cfg.deadbandDeg ?? 0.35)) {
      correction = clamp(
        diff * gain,
        -Number(this.cfg.maxCorrectionDegPerReading ?? 4),
        Number(this.cfg.maxCorrectionDegPerReading ?? 4),
      );
    }
    this.fused = normalizeHeading(this.fused + correction);
    this.#emit(timestampMs, 'absolute-correct');
    this.cb.onAbsolute?.(raw, source);
    return this.fused;
  }

  // Optional emergency override. If an absolute reference exists, convert the
  // entered heading into an offset, so absolute updates continue to remove drift.
  calibrate(knownHeadingDeg) {
    const known = normalizeHeading(knownHeadingDeg);
    if (finite(this.absoluteFiltered)) {
      this.headingOffsetDeg = signedAngleDelta(known, this.absoluteFiltered);
      this.absoluteCalibrated = normalizeHeading(this.absoluteFiltered + this.headingOffsetDeg);
    } else {
      this.headingOffsetDeg = 0;
      this.absoluteCalibrated = known;
    }
    this.fused = known;
    this.calibrated = true;
    this.manualOverride = true;
    this.sensorMode = finite(this.absoluteFiltered)
      ? `absolute+override:${this.absoluteSource || 'absolute'}`
      : 'manual+gyro';
    this.lastGyroTs = null;
    this.#emit(performance.now(), 'manual-override');
    return this.snapshot();
  }

  clearCalibration() {
    this.headingOffsetDeg = 0;
    this.manualOverride = false;
    this.fused = null;
    this.calibrated = false;
    this.absoluteCalibrated = null;
    this.initialAbsoluteSamples = [];
    this.lastGyroTs = null;
    this.sensorMode = this.absoluteSource ? `waiting:${this.absoluteSource}` : 'waiting-absolute';
  }

  heading() {
    if (finite(this.fused)) return normalizeHeading(this.fused);
    if (finite(this.absoluteFiltered)) return normalizeHeading(this.absoluteFiltered + this.headingOffsetDeg);
    return null;
  }

  absoluteAgeMs(now = performance.now()) {
    return this.lastAbsoluteAt > 0 ? Math.max(0, now - this.lastAbsoluteAt) : Infinity;
  }

  magneticQuality() {
    if (finite(this.magneticFieldUt)) {
      return this.magneticFieldUt >= Number(this.cfg.magneticMinUt ?? 18)
        && this.magneticFieldUt <= Number(this.cfg.magneticMaxUt ?? 90)
        ? 'raw-mag-good'
        : 'raw-mag-disturbed';
    }
    if (this.absoluteSource && this.absoluteAgeMs() <= Number(this.cfg.absoluteFreshMs ?? 750) * 2) {
      return 'orientation-fused';
    }
    if (this.calibrated) return 'gyro-only-degraded';
    return 'unavailable';
  }

  snapshot() {
    return {
      headingDeg: this.heading(),
      calibrated: this.calibrated,
      manualOverride: this.manualOverride,
      absoluteRawDeg: this.absoluteRaw,
      absoluteFilteredDeg: this.absoluteFiltered,
      absoluteCalibratedDeg: this.absoluteCalibrated,
      absoluteSource: this.absoluteSource,
      absoluteAgeMs: this.absoluteAgeMs(),
      relativeRawDeg: this.relativeRaw,
      gyroRateDps: this.gyroRateDps,
      accelNorm: this.accelNorm,
      magneticFieldUt: this.magneticFieldUt,
      magneticQuality: this.magneticQuality(),
      sensorMode: this.sensorMode,
      capabilities: [...this.capabilities],
      initialSamples: this.initialAbsoluteSamples.length,
    };
  }

  #emit(timestampMs, phase) {
    this.lastOutputAt = timestampMs;
    this.cb.onHeading?.(this.heading(), { ...this.snapshot(), phase });
  }
}
