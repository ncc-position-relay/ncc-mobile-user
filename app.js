import { NCC_CONFIG } from './config.js';
import { wgs84ToUtm39, utm39ToWgs84, normalizeHeading, projectStepCardinalSelfTest } from './utm.js';
import { HeadingFusion } from './headingFusion.js';
import { PdrEngine } from './pdr.js';
import { MobileMap2D } from './map2d.js';

const $ = id => document.getElementById(id);
const PROFILE_KEY = 'ncc_mobile_profile_stage107';
const DEVICE_KEY = 'ncc_mobile_device_stage90';
const SESSION_KEY = 'ncc_mobile_session_stage90';
const PHOTO_KEY = 'ncc_mobile_photo_stage104';
const MODEL_URL_KEY = 'ncc_mobile_model_url_stage107';
const MAX_RELAY_MESSAGE_CHARS = 3900;
const MAX_RELAY_PHOTO_DATA_URL_CHARS = 2400;

let sentCount = 0;
let errorCount = 0;
let sequence = 0;
let gpsWatchId = null;
let latestGps = null;
let qrStream = null;
let qrLoopActive = false;
let qrDetector = null;
let scannedQrPoint = null;
let userPhotoDataUrl = null;
let motionBound = false;
let orientationBound = false;
let lastRawHeading = null;
let lastPosition = null;
let activeSource = null;
let pdrPublishChain = Promise.resolve();
let pdrHeartbeatTimer = null;
let map2d = null;
let view3d = null;
let view3dInitPromise = null;
let viewerMode = '2d';
let followUser = true;
let sensorPermissionGranted = false;

function log(text) {
  const stamp = new Date().toLocaleTimeString();
  $('log').textContent = `[${stamp}] ${text}\n` + $('log').textContent.slice(0, 12000);
}
function cleanTopic(value) { return String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, ''); }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function numberOr(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function randomId(prefix) {
  const core = (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`)
    .replaceAll('-', '').replace('.', '').slice(0, 12).toUpperCase();
  return `${prefix}_${core}`;
}
function deviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) { value = randomId('WEB'); localStorage.setItem(DEVICE_KEY, value); }
  return value;
}
function defaultUserId() { return `PHONE_${deviceId().split('_').at(-1)}`; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function profile() {
  return {
    user_id: $('userId').value.trim() || defaultUserId(),
    label: $('label').value.trim() || 'Mobile User',
    gender: $('gender').value,
    role: $('role').value,
    avatar_id: $('avatarId').value.trim() || null,
    height_cm: numberOrNull($('heightCm').value),
    weight_kg: numberOrNull($('weightKg').value),
    floor_id: $('floorId').value.trim() || null,
    device_id: deviceId(),
    session_id: deviceId(),
  };
}

function pdrConfigFromUi() {
  return {
    ...NCC_CONFIG.pdr,
    stepLengthM: clamp(numberOr($('stepLength').value, NCC_CONFIG.pdr.stepLengthM), .2, 1.5),
    peakThresholdMps2: clamp(numberOr($('peakThreshold').value, NCC_CONFIG.pdr.peakThresholdMps2), .1, 4),
    maxPeakMps2: clamp(numberOr($('maxPeak').value, NCC_CONFIG.pdr.maxPeakMps2), 1, 15),
    minStepIntervalMs: clamp(numberOr($('minStepInterval').value, NCC_CONFIG.pdr.minStepIntervalMs), 200, 1000),
    resetThresholdMps2: clamp(numberOr($('resetThreshold').value, NCC_CONFIG.pdr.resetThresholdMps2), 0, 1),
  };
}

function saveProfile() {
  const data = {
    ...profile(),
    manual_heading: normalizeHeading(numberOr($('manualHeading').value, 90)),
    initial_heading: normalizeHeading(numberOr($('initialHeading').value, 90)),
    accuracy_warn: numberOr($('accuracyWarn').value, 50),
    pdr: pdrConfigFromUi(),
    model_vertical_offset: numberOr($('modelVerticalOffset').value, 0),
    model_url: $('modelUrl').value.trim(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(data));
  if (data.model_url) localStorage.setItem(MODEL_URL_KEY, data.model_url);
  log('PROFILE SAVED');
}

function loadProfile() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch {}
  $('userId').value = data.user_id || defaultUserId();
  $('label').value = data.label || 'Mobile User';
  $('gender').value = data.gender || 'unknown';
  $('role').value = data.role || 'visitor';
  $('avatarId').value = data.avatar_id || '';
  $('heightCm').value = data.height_cm ?? 175;
  $('weightKg').value = data.weight_kg ?? 75;
  $('floorId').value = data.floor_id || '';
  $('manualHeading').value = data.manual_heading ?? 90;
  $('initialHeading').value = data.initial_heading ?? data.manual_heading ?? 90;
  $('accuracyWarn').value = data.accuracy_warn ?? 50;
  const pd = { ...NCC_CONFIG.pdr, ...(data.pdr || {}) };
  $('stepLength').value = pd.stepLengthM;
  $('peakThreshold').value = pd.peakThresholdMps2;
  $('maxPeak').value = pd.maxPeakMps2;
  $('minStepInterval').value = pd.minStepIntervalMs;
  $('resetThreshold').value = pd.resetThresholdMps2;
  $('modelVerticalOffset').value = data.model_vertical_offset ?? NCC_CONFIG.model.verticalOffsetM ?? 0;
  $('modelUrl').value = data.model_url || localStorage.getItem(MODEL_URL_KEY) || NCC_CONFIG.model.defaultUrl;

  const storedSession = sessionStorage.getItem(SESSION_KEY) || '';
  if (storedSession) $('sessionCode').value = storedSession;
  const query = new URLSearchParams(location.search);
  const querySession = cleanTopic(query.get('session') || '');
  if (querySession.length >= 20) {
    $('sessionCode').value = querySession;
    sessionStorage.setItem(SESSION_KEY, querySession);
  }

  userPhotoDataUrl = localStorage.getItem(PHOTO_KEY) || null;
  updatePhotoPreview();

  const qrPoint = parseQrUrl(location.href);
  if (qrPoint) {
    setQrCandidate(qrPoint);
    const clean = new URL(location.href);
    for (const key of ['nccqr','id','lon','lat','e','n','h','epsg','floor']) clean.searchParams.delete(key);
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
  }
}

function updatePhotoPreview() {
  const has = Boolean(userPhotoDataUrl);
  $('photoPreview').hidden = !has;
  $('avatarIcon').style.display = has ? 'none' : 'grid';
  $('sendPhoto').disabled = !has;
  $('clearPhoto').disabled = !has;
  if (has) $('photoPreview').src = userPhotoDataUrl;
  $('avatarPreview').textContent = `Avatar: ${$('avatarId').value.trim() || (has ? 'photo-avatar' : 'auto')}`;
  view3d?.setUserPhoto?.(userPhotoDataUrl);
}

function reportError(prefix, error) {
  errorCount += 1;
  $('errorCount').textContent = errorCount;
  $('relayStatus').textContent = `${prefix}: ${error?.message || error}`;
  $('relayStatus').className = 'bad';
  log(`${prefix}: ${error?.message || error}`);
}

function setSource(source, label = '') {
  activeSource = source;
  $('positionSource').textContent = `Position: ${source || '—'}${label ? ` · ${label}` : ''}`;
  $('positionSource').className = source ? 'pill ok' : 'pill';
}

function displayPosition(pos, { source = activeSource, appendPath = true } = {}) {
  if (!pos || !Number.isFinite(pos.easting) || !Number.isFinite(pos.northing)) return;
  const geo = (Number.isFinite(pos.longitude) && Number.isFinite(pos.latitude))
    ? { longitude: pos.longitude, latitude: pos.latitude }
    : utm39ToWgs84(pos.easting, pos.northing);
  const normalized = {
    ...pos,
    longitude: geo.longitude,
    latitude: geo.latitude,
    headingDeg: normalizeHeading(numberOr(pos.headingDeg, currentHeading())),
    h: numberOr(pos.h, numberOr(pos.display_altitude, 0)),
    source,
  };
  lastPosition = normalized;
  $('lat').textContent = normalized.latitude.toFixed(8);
  $('lon').textContent = normalized.longitude.toFixed(8);
  $('utmE').textContent = normalized.easting.toFixed(3);
  $('utmN').textContent = normalized.northing.toFixed(3);
  $('deviceHeading').textContent = `${normalized.headingDeg.toFixed(1)}°`;
  setSource(source || normalized.source || '—', pos.anchorId || '');
  updateHud(normalized);
  map2d?.setPosition(normalized, { appendPath });
  view3d?.setPosition(normalized, { appendPath });
}

function updateHud(pdrOrPosition) {
  const s = pdrOrPosition || {};
  const stepCount = s.stepCount ?? pdr.snapshot().stepCount;
  const distance = s.distanceM ?? pdr.snapshot().distanceM;
  const heading = normalizeHeading(numberOr(s.headingDeg, currentHeading()));
  $('hud').innerHTML = [
    `SOURCE: <b>${String(s.source || activeSource || '—').toUpperCase()}</b>`,
    `E: ${Number.isFinite(s.easting) ? Number(s.easting).toFixed(3) : '—'}`,
    `N: ${Number.isFinite(s.northing) ? Number(s.northing).toFixed(3) : '—'}`,
    `H: ${Number.isFinite(s.h) ? Number(s.h).toFixed(3) : '—'}`,
    `AZ: ${heading.toFixed(1)}°`,
    `STEP: ${stepCount ?? 0}`,
    `DIST: ${Number(distance || 0).toFixed(2)} m`,
  ].join('<br>');
  $('compassArrow').style.setProperty('--heading', `${heading}deg`);
}

function currentHeading() {
  const fused = headingFusion?.heading?.();
  if (Number.isFinite(fused)) return normalizeHeading(fused);
  return normalizeHeading(numberOr($('manualHeading').value, 90));
}

const headingFusion = new HeadingFusion(NCC_CONFIG.pdr, {
  onHeading: (heading, d) => {
    if (!Number.isFinite(heading)) return;
    lastRawHeading = heading;
    pdr?.setHeading?.(heading);
    $('deviceHeading').textContent = `${heading.toFixed(1)}°`;
    $('fusionStatus').textContent = `${d.calibrated ? 'CAL' : 'UNCAL'} · ${d.sensorMode} · mag=${d.magneticQuality}`;
    $('gyroRate').textContent = `${Number(d.gyroRateDps || 0).toFixed(1)} °/s`;
    $('magField').textContent = Number.isFinite(d.magneticFieldUt) ? `${d.magneticFieldUt.toFixed(1)} µT` : '—';
  },
  onDiagnostic: text => log(`SENSOR ${text}`),
});

const pdr = new PdrEngine(NCC_CONFIG.pdr, {
  onHeading: h => {
    $('deviceHeading').textContent = `${h.toFixed(1)}°`;
    updateHud({ ...(pdr.snapshot()), source: activeSource || 'pdr' });
  },
  onSample: () => drawAccelChart(),
  onStep: state => handlePdrStep(state),
  onAnchor: state => handlePdrAnchorState(state),
  onReset: state => {
    handlePdrAnchorState(state);
    displayPdrState(state, false);
    publishPdrState(state, 'pdr-reset').catch(e => reportError('PDR RESET SEND', e));
  },
  onState: state => updatePdrUi(state),
});

function updatePdrUi(state = pdr.snapshot()) {
  $('pdrSteps').textContent = state.stepCount || 0;
  $('pdrDistance').textContent = Number(state.distanceM || 0).toFixed(2);
  $('pdrCadence').textContent = Number(state.cadenceSpm || 0).toFixed(0);
  $('pdrAccel').textContent = Number(state.dynamicAccel || 0).toFixed(2);
  $('startPdr').disabled = !pdr.anchor || !headingFusion.calibrated || state.active;
  $('stopPdr').disabled = !state.active;
  $('resetPdr').disabled = !pdr.anchor;
}

function handlePdrAnchorState(state) {
  const a = state.anchor;
  $('pdrAnchorBanner').textContent = a
    ? `Anchor: ${a.point_id || a.id || 'QR'} · E ${a.e.toFixed(3)} · N ${a.n.toFixed(3)} · H ${a.h.toFixed(3)} m`
    : 'Anchor: ثبت نشده — ابتدا QR را اسکن کنید.';
  $('pdrAnchorBanner').className = a ? 'source-banner ok' : 'source-banner';
  updatePdrUi(state);
}

function displayPdrState(state, appendPath = true) {
  if (!Number.isFinite(state.easting) || !Number.isFinite(state.northing)) return;
  const geo = utm39ToWgs84(state.easting, state.northing);
  displayPosition({
    easting: state.easting,
    northing: state.northing,
    longitude: geo.longitude,
    latitude: geo.latitude,
    h: state.h,
    headingDeg: state.headingDeg,
    stepCount: state.stepCount,
    distanceM: state.distanceM,
    source: 'pdr',
    anchorId: state.anchor?.point_id || state.anchor?.id || null,
  }, { source: 'pdr', appendPath });
  updatePdrUi(state);
}

function queuePdrPublish(state, source = 'pdr') {
  const snapshot = JSON.parse(JSON.stringify(state));
  pdrPublishChain = pdrPublishChain
    .then(() => publishPdrState(snapshot, source))
    .catch(e => reportError('PDR SEND', e));
  return pdrPublishChain;
}

function startPdrHeartbeat() {
  clearInterval(pdrHeartbeatTimer);
  const ms = Math.max(1000, Number(NCC_CONFIG.pdr.pdrHeartbeatMs || 2000));
  pdrHeartbeatTimer = setInterval(() => { if (pdr.active) queuePdrPublish(pdr.snapshot(), 'pdr'); }, ms);
}
function stopPdrHeartbeat() { clearInterval(pdrHeartbeatTimer); pdrHeartbeatTimer = null; }

async function handlePdrStep(state) {
  displayPdrState(state, true);
  // Every accepted step is queued, never dropped by a throttle. The public relay
  // therefore carries the latest PDR coordinate to Backend/Cesium/XR.
  queuePdrPublish(state, 'pdr');
}

async function publishPdrState(state, source = 'pdr') {
  const geo = utm39ToWgs84(state.easting, state.northing);
  return publish({
    latitude: geo.latitude,
    longitude: geo.longitude,
    altitude: null,
    display_altitude: state.h,
    accuracy: null,
    speed: null,
    heading: state.headingDeg,
    utm_easting: state.easting,
    utm_northing: state.northing,
  }, source, {
    pdr_anchor_id: state.anchor?.point_id || state.anchor?.id || null,
    pdr_step_count: state.stepCount,
    pdr_distance_m: state.distanceM,
    pdr_cadence_spm: state.cadenceSpm,
    pdr_step_length_m: numberOr($('stepLength').value, NCC_CONFIG.pdr.stepLengthM),
    pdr_heading_source: headingFusion.snapshot().sensorMode,
    pdr_heading_quality: headingFusion.snapshot().magneticQuality,
    pdr_gyro_rate_dps: headingFusion.snapshot().gyroRateDps,
    pdr_magnetic_field_ut: headingFusion.snapshot().magneticFieldUt,
  });
}

function buildMessage(coords, source = 'gps', extra = {}) {
  const p = profile();
  sequence += 1;
  $('sequence').textContent = sequence;
  const heading = normalizeHeading(numberOr(coords.heading, currentHeading()));
  return {
    type: 'ncc_live_position',
    schema_version: 5,
    position_mode: source,
    sequence,
    profile: p,
    position: {
      source,
      latitude: numberOrNull(coords.latitude),
      longitude: numberOrNull(coords.longitude),
      altitude: source === 'qr' || source.startsWith('pdr') ? null : numberOrNull(coords.altitude),
      display_altitude: numberOrNull(coords.display_altitude ?? extra.display_altitude),
      altitude_accuracy_m: numberOrNull(coords.altitudeAccuracy),
      accuracy_m: (source === 'qr' || source.startsWith('pdr')) ? null : numberOrNull(coords.accuracy),
      speed_mps: source === 'qr' ? 0 : numberOrNull(coords.speed),
      heading_deg: heading,
      utm_easting: numberOrNull(coords.utm_easting ?? extra.utm_easting),
      utm_northing: numberOrNull(coords.utm_northing ?? extra.utm_northing),
      qr_point_id: extra.qr_point_id || null,
      qr_epsg: numberOrNull(extra.qr_epsg),
      pdr_anchor_id: extra.pdr_anchor_id || null,
      pdr_step_count: numberOrNull(extra.pdr_step_count),
      pdr_distance_m: numberOrNull(extra.pdr_distance_m),
      pdr_cadence_spm: numberOrNull(extra.pdr_cadence_spm),
      pdr_step_length_m: numberOrNull(extra.pdr_step_length_m),
      pdr_heading_source: extra.pdr_heading_source || null,
      pdr_heading_quality: extra.pdr_heading_quality || null,
      pdr_gyro_rate_dps: numberOrNull(extra.pdr_gyro_rate_dps),
      pdr_magnetic_field_ut: numberOrNull(extra.pdr_magnetic_field_ut),
    },
    device_id: p.device_id,
    session_id: p.session_id,
    client_timestamp_ms: Date.now(),
    client_timestamp: new Date().toISOString(),
  };
}

async function relayPost(message) {
  const topic = cleanTopic($('sessionCode').value);
  if (topic.length < 20) throw new Error('Session Code معتبر نیست یا خیلی کوتاه است.');
  sessionStorage.setItem(SESSION_KEY, topic);
  const body = JSON.stringify(message);
  if (body.length > MAX_RELAY_MESSAGE_CHARS) throw new Error(`پیام برای Relay بزرگ است (${body.length} chars).`);
  const response = await fetch(`${NCC_CONFIG.relayBase}/${encodeURIComponent(topic)}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body, cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Relay HTTP ${response.status}`);
  sentCount += 1;
  $('sentCount').textContent = sentCount;
  $('lastSend').textContent = new Date().toLocaleTimeString();
  $('relayStatus').className = 'ok';
  return body.length;
}

async function publish(coords, source = 'gps', extra = {}) {
  const message = buildMessage(coords, source, extra);
  if (!Number.isFinite(message.position.latitude) || !Number.isFinite(message.position.longitude)) throw new Error('Latitude/Longitude معتبر نیست.');
  await relayPost(message);
  $('relayStatus').textContent = `Relay: ${source} ارسال شد · ${message.profile.user_id} · seq ${message.sequence}`;
  log(`POSITION ${source} user=${message.profile.user_id} E=${message.position.utm_easting ?? '-'} N=${message.position.utm_northing ?? '-'}`);
  return message;
}

async function publishPhoto() {
  if (!userPhotoDataUrl) throw new Error('ابتدا عکس بگیرید.');
  const p = profile();
  const message = {
    type: 'ncc_user_photo', schema_version: 1, profile: p,
    photo: { data_url: userPhotoDataUrl, captured_at: new Date().toISOString() },
    device_id: p.device_id, session_id: p.session_id, client_timestamp_ms: Date.now(),
  };
  const size = await relayPost(message);
  $('relayStatus').textContent = `Relay: عکس Avatar ارسال شد · ${p.user_id}`;
  log(`PHOTO SENT user=${p.user_id} messageChars=${size}`);
}

async function fileToImage(file) {
  if ('createImageBitmap' in window) { try { return await createImageBitmap(file); } catch {} }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
  URL.revokeObjectURL(url); return img;
}
async function compressFacePhoto(file) {
  const image = await fileToImage(file);
  const iw = image.width || image.naturalWidth, ih = image.height || image.naturalHeight;
  const side = Math.min(iw, ih), sx = (iw - side) / 2, sy = (ih - side) / 2;
  let best = null;
  for (const size of [80,72,64,56,48]) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,size,size); ctx.drawImage(image,sx,sy,side,side,0,0,size,size);
    for (const q of [.72,.62,.52,.42]) {
      const url = canvas.toDataURL('image/jpeg', q); best = url;
      if (url.length <= MAX_RELAY_PHOTO_DATA_URL_CHARS) { image.close?.(); return url; }
    }
  }
  image.close?.(); return best;
}

function pointFromParams(params) {
  if (params.get('nccqr') !== '1') return null;
  const point = {
    point_id: params.get('id') || 'NCC_QR', longitude: Number(params.get('lon')), latitude: Number(params.get('lat')),
    utm_easting: Number(params.get('e')), utm_northing: Number(params.get('n')), height_m: Number(params.get('h')),
    epsg: Number(params.get('epsg') || 32639), floor_id: params.get('floor') || null,
  };
  if (![point.longitude, point.latitude, point.utm_easting, point.utm_northing].every(Number.isFinite)) return null;
  return point;
}
function parseQrUrl(text) {
  try { return pointFromParams(new URL(text, location.href).searchParams); } catch { return null; }
}
function setQrCandidate(point) {
  scannedQrPoint = point;
  $('qrResult').style.display = 'block';
  $('qrPointId').textContent = point.point_id;
  $('qrCoordinates').textContent = `Lon ${point.longitude.toFixed(8)} · Lat ${point.latitude.toFixed(8)}`;
  $('qrUtm').textContent = `EPSG:${point.epsg} · E ${point.utm_easting.toFixed(3)} · N ${point.utm_northing.toFixed(3)}`;
  $('qrHeight').textContent = `H ${Number(point.height_m || 0).toFixed(3)} m${point.floor_id ? ` · ${point.floor_id}` : ''}`;
  $('applyQr').disabled = false; $('cancelQr').disabled = false;
  log(`QR READY ${point.point_id}`);
}
async function ensureQrDecoder() {
  if ('BarcodeDetector' in window) {
    try { qrDetector = new BarcodeDetector({ formats: ['qr_code'] }); return 'barcode'; } catch {}
  }
  if (window.jsQR) return 'jsqr';
  const urls = ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js','https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'];
  for (const url of urls) {
    try {
      await new Promise((resolve, reject) => { const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=reject;document.head.append(s); });
      if (window.jsQR) return 'jsqr';
    } catch {}
  }
  throw new Error('QR decoder در دسترس نیست. از دوربین عادی گوشی برای بازکردن QR URL استفاده کنید.');
}
async function decodeQrCanvas(canvas) {
  if (qrDetector) {
    const rows = await qrDetector.detect(canvas); if (rows?.[0]?.rawValue) return rows[0].rawValue;
  }
  if (window.jsQR) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); const img = ctx.getImageData(0,0,canvas.width,canvas.height);
    return window.jsQR(img.data,img.width,img.height,{ inversionAttempts:'attemptBoth' })?.data || null;
  }
  return null;
}
async function startQrCamera() {
  await ensureQrDecoder();
  qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width:{ideal:1280}, height:{ideal:720} }, audio:false });
  $('qrVideo').srcObject = qrStream; $('qrVideo').style.display='block'; await $('qrVideo').play();
  $('startQr').disabled=true; $('stopQr').disabled=false; qrLoopActive=true;
  const canvas=$('qrCanvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const loop=async()=>{ if(!qrLoopActive)return; const v=$('qrVideo'); if(v.readyState>=2&&v.videoWidth){canvas.width=v.videoWidth;canvas.height=v.videoHeight;ctx.drawImage(v,0,0); try{const raw=await decodeQrCanvas(canvas);const p=raw&&parseQrUrl(raw);if(p){setQrCandidate(p);stopQrCamera();return;}}catch{}} requestAnimationFrame(loop);};
  requestAnimationFrame(loop);
}
function stopQrCamera(){qrLoopActive=false;if(qrStream){for(const t of qrStream.getTracks())t.stop();qrStream=null;}$('qrVideo').srcObject=null;$('qrVideo').style.display='none';$('startQr').disabled=false;$('stopQr').disabled=true;}
async function scanQrImage(file){ await ensureQrDecoder(); const image=await fileToImage(file); const canvas=$('qrCanvas'); const max=1400,scale=Math.min(1,max/Math.max(image.width||image.naturalWidth,image.height||image.naturalHeight)); canvas.width=Math.max(1,Math.round((image.width||image.naturalWidth)*scale));canvas.height=Math.max(1,Math.round((image.height||image.naturalHeight)*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const raw=await decodeQrCanvas(canvas);image.close?.();if(!raw)throw new Error('QR در تصویر پیدا نشد.');const p=parseQrUrl(raw);if(!p)throw new Error('QR متعلق به NCC Position نیست.');setQrCandidate(p);}

function stopGpsLive() { if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId=null; $('stopGps').disabled=true; $('startGps').disabled=false; }
function gpsOptions(){return {enableHighAccuracy:true,timeout:15000,maximumAge:1000};}
function gpsToPosition(pos){
  const c=pos.coords,utm=wgs84ToUtm39(c.longitude,c.latitude);
  return { latitude:c.latitude,longitude:c.longitude,easting:utm.easting,northing:utm.northing,h:numberOr(c.altitude,0),headingDeg:Number.isFinite(c.heading)?normalizeHeading(c.heading):currentHeading(),accuracy:c.accuracy,altitude:c.altitude,altitudeAccuracy:c.altitudeAccuracy,speed:c.speed };
}
function showGps(pos){ latestGps=pos; $('gpsAsAnchor').disabled=false; const p=gpsToPosition(pos); displayPosition(p,{source:'gps',appendPath:true}); const warn=numberOr($('accuracyWarn').value,50); $('viewerStatus').textContent=`GPS · accuracy ${Number(pos.coords.accuracy).toFixed(1)} m${pos.coords.accuracy>warn?' · ضعیف':''}`; return p; }
async function gpsOnceAndSend(){ const pos=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,gpsOptions())); const p=showGps(pos); await publish({latitude:p.latitude,longitude:p.longitude,altitude:p.altitude,display_altitude:p.h,accuracy:p.accuracy,altitudeAccuracy:p.altitudeAccuracy,speed:p.speed,heading:p.headingDeg,utm_easting:p.easting,utm_northing:p.northing},'gps'); }
function startGpsLive(){ stopGpsLive(); gpsWatchId=navigator.geolocation.watchPosition(pos=>{const p=showGps(pos);publish({latitude:p.latitude,longitude:p.longitude,altitude:p.altitude,display_altitude:p.h,accuracy:p.accuracy,altitudeAccuracy:p.altitudeAccuracy,speed:p.speed,heading:p.headingDeg,utm_easting:p.easting,utm_northing:p.northing},'gps').catch(e=>reportError('GPS LIVE SEND',e));},e=>reportError('GPS',e),gpsOptions()); $('stopGps').disabled=false;$('startGps').disabled=true; }

async function requestSensorPermission() {
  let motionOk=true,orientationOk=true;
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') motionOk=(await DeviceMotionEvent.requestPermission())==='granted';
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') orientationOk=(await DeviceOrientationEvent.requestPermission())==='granted';
  sensorPermissionGranted=motionOk&&orientationOk;
  $('motionPermission').textContent=`Motion: ${motionOk?'YES':'NO'}`;$('motionPermission').className=`pill ${motionOk?'ok':'bad'}`;
  $('orientationPermission').textContent=`Heading: ${orientationOk?'YES':'NO'}`;$('orientationPermission').className=`pill ${orientationOk?'ok':'bad'}`;
  bindSensorEvents();
  try { await headingFusion.startOptionalGenericSensors(); } catch (e) { log(`GENERIC SENSOR: ${e.message}`); }
  if(!sensorPermissionGranted) throw new Error('مجوز Motion/Orientation کامل صادر نشد.');
  return true;
}
function bindSensorEvents() {
  if(!motionBound){ window.addEventListener('devicemotion',onMotion,{passive:true}); motionBound=true; }
  if(!orientationBound){ window.addEventListener('deviceorientationabsolute',onOrientation,true); window.addEventListener('deviceorientation',onOrientation,true); orientationBound=true; }
}
function onMotion(event){
  headingFusion.pushMotion(event,event.timeStamp || performance.now());
  const a=event.accelerationIncludingGravity || event.acceleration; if(!a)return;
  pdr.pushAcceleration(a.x,a.y,a.z,event.timeStamp || performance.now());
}
function onOrientation(event){
  headingFusion.pushOrientation(event,event.timeStamp || performance.now());
}
function calibrateHeadingFromUi(){
  const known=normalizeHeading(numberOr($('initialHeading').value,90));
  const snap=headingFusion.calibrate(known);
  pdr.setHeading(known);
  $('manualHeading').value=known.toFixed(1);
  $('fusionStatus').textContent=`CAL · ${snap.sensorMode} · mag=${snap.magneticQuality}`;
  updatePdrUi();
  log(`HEADING CALIBRATED az=${known.toFixed(1)} raw=${Number(snap.absoluteRawDeg ?? NaN).toFixed(1)}`);
}

function drawAccelChart(){
  const canvas=$('accelChart'),r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=Math.max(200,Math.round(r.width*dpr)),h=Math.max(100,Math.round(r.height*dpr));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);ctx.fillStyle='#05121a';ctx.fillRect(0,0,w,h);
  const samples=pdr.samples;if(samples.length<2)return; const threshold=numberOr($('peakThreshold').value,.9),max= Math.max(2.5,threshold*2.5, ...samples.map(s=>Math.abs(s.dynamic))); const y=v=>h/2-v/max*(h*.42);
  ctx.strokeStyle='#24485b';ctx.lineWidth=1*dpr;ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();ctx.strokeStyle='#ffd166';ctx.beginPath();ctx.moveTo(0,y(threshold));ctx.lineTo(w,y(threshold));ctx.stroke();
  ctx.strokeStyle='#4fe0ff';ctx.lineWidth=2*dpr;ctx.beginPath();samples.forEach((s,i)=>{const x=i/(samples.length-1)*w,yy=y(s.dynamic);i?ctx.lineTo(x,yy):ctx.moveTo(x,yy)});ctx.stroke();
  ctx.fillStyle='#65e39a';samples.forEach((s,i)=>{if(!s.step)return;const x=i/(samples.length-1)*w,yy=y(s.dynamic);ctx.beginPath();ctx.arc(x,yy,4*dpr,0,Math.PI*2);ctx.fill();});
}

async function initViewers(){
  map2d=new MobileMap2D($('map2d'),{...NCC_CONFIG.map,qrPoints:NCC_CONFIG.qrPoints},$('viewerStatus'));
  map2d.init().catch(e=>{log(`2D MAP: ${e.message}`);});
  $('modelStatus').textContent='3D به‌صورت Lazy Load است؛ با ورود به تب 3D بارگذاری می‌شود.';
}

async function ensure3D(){
  if(view3d) return view3d;
  if(view3dInitPromise) return view3dInitPromise;
  view3dInitPromise=(async()=>{
    $('modelStatus').textContent='در حال بارگذاری موتور Three.js…';
    const { MobileBuilding3D } = await import('./view3d.js');
    const instance=new MobileBuilding3D($('view3d'),{
      ...NCC_CONFIG.model, transform:NCC_CONFIG.modelRuntimeTransform, qrPoints:NCC_CONFIG.qrPoints,
      verticalOffsetM:numberOr($('modelVerticalOffset').value,0),
    },$('modelStatus'));
    await instance.init();
    instance.setUserPhoto(userPhotoDataUrl);
    instance.setFollow(followUser);
    if(lastPosition) instance.setPosition(lastPosition,{appendPath:false});
    view3d=instance;
    return instance;
  })();
  try{return await view3dInitPromise;}finally{view3dInitPromise=null;}
}

async function setViewerMode(mode){
  viewerMode=mode; const is2d=mode==='2d';
  $('pane2d').hidden=!is2d;$('pane3d').hidden=is2d;$('tab2d').classList.toggle('active',is2d);$('tab3d').classList.toggle('active',!is2d);
  if(!is2d){
    try{await ensure3D();setTimeout(()=>view3d?.renderer?.setSize?.($('view3d').clientWidth,$('view3d').clientHeight,false),50);}
    catch(e){reportError('3D ENGINE',e);setViewerMode('2d');}
  }
}

async function loadModelFromUrl(){ const url=$('modelUrl').value.trim();if(!url)throw new Error('Model URL خالی است.');localStorage.setItem(MODEL_URL_KEY,url);const v=await ensure3D();await v.loadModel(url);await setViewerMode('3d'); }

function applyQrAsAnchor() {
  if(!scannedQrPoint)throw new Error('QR معتبر انتخاب نشده است.');
  stopGpsLive();
  const q=scannedQrPoint;
  pdr.stop();
  pdr.setAnchor({ point_id:q.point_id,e:q.utm_easting,n:q.utm_northing,h:numberOr(q.height_m,0),longitude:q.longitude,latitude:q.latitude,epsg:q.epsg,floor_id:q.floor_id },{keepActive:false});
  pdr.setHeading(currentHeading());
  const state=pdr.snapshot();
  displayPdrState(state,false);
  setSource('qr',q.point_id);
  publish({latitude:q.latitude,longitude:q.longitude,display_altitude:q.height_m,heading:currentHeading(),utm_easting:q.utm_easting,utm_northing:q.utm_northing},'qr',{qr_point_id:q.point_id,qr_epsg:q.epsg,display_altitude:q.height_m}).catch(e=>reportError('QR SEND',e));
  scannedQrPoint=null;$('applyQr').disabled=true;$('cancelQr').disabled=true;$('qrResult').style.display='none';
  log(`PDR ANCHOR ${q.point_id} · اکنون جهت اولیه را ثبت کنید.`);
}

function cancelQr(){scannedQrPoint=null;$('applyQr').disabled=true;$('cancelQr').disabled=true;$('qrResult').style.display='none';}
function applyGpsAsAnchor(){
  if(!latestGps) throw new Error('ابتدا یک موقعیت GPS معتبر دریافت کنید.');
  stopGpsLive();
  const g=gpsToPosition(latestGps);
  pdr.stop();
  pdr.setAnchor({point_id:'GPS_ANCHOR',e:g.easting,n:g.northing,h:numberOr(g.h,0),longitude:g.longitude,latitude:g.latitude,epsg:32639,floor_id:null},{keepActive:false});
  pdr.setHeading(currentHeading());
  displayPdrState(pdr.snapshot(),false);
  setSource('gps-anchor','GPS_ANCHOR');
  log(`PDR GPS ANCHOR E=${g.easting.toFixed(3)} N=${g.northing.toFixed(3)} · برای Indoor از QR استفاده کنید.`);
}


// Events
$('saveProfile').onclick=saveProfile;
$('avatarId').oninput=()=>updatePhotoPreview();
$('takePhoto').onclick=()=>$('photoInput').click();
$('photoInput').onchange=async e=>{try{const f=e.target.files?.[0];if(!f)return;userPhotoDataUrl=await compressFacePhoto(f);if(!userPhotoDataUrl||userPhotoDataUrl.length>3000)throw new Error('فشرده‌سازی عکس کافی نبود.');localStorage.setItem(PHOTO_KEY,userPhotoDataUrl);updatePhotoPreview();log(`PHOTO READY chars=${userPhotoDataUrl.length}`);}catch(err){reportError('PHOTO',err);}finally{e.target.value='';}};
$('sendPhoto').onclick=()=>publishPhoto().catch(e=>reportError('PHOTO SEND',e));
$('clearPhoto').onclick=()=>{userPhotoDataUrl=null;localStorage.removeItem(PHOTO_KEY);updatePhotoPreview();log('LOCAL PHOTO CLEARED');};
$('enableSensors').onclick=()=>requestSensorPermission().then(()=>log('SENSORS ENABLED')).catch(e=>reportError('SENSOR',e));
$('calibrateHeading').onclick=()=>{try{calibrateHeadingFromUi();}catch(e){reportError('HEADING CAL',e);}};
$('clearHeadingCalibration').onclick=()=>{headingFusion.clearCalibration();updatePdrUi();$('fusionStatus').textContent='UNCAL';log('HEADING CALIBRATION CLEARED');};
$('gpsOnce').onclick=()=>gpsOnceAndSend().catch(e=>reportError('GPS ONCE',e));
$('startGps').onclick=()=>{try{startGpsLive();}catch(e){reportError('GPS LIVE',e);}};
$('stopGps').onclick=stopGpsLive;
$('gpsAsAnchor').onclick=()=>{try{applyGpsAsAnchor();}catch(e){reportError('GPS ANCHOR',e);}};
$('startQr').onclick=()=>startQrCamera().catch(e=>reportError('QR CAMERA',e));
$('stopQr').onclick=stopQrCamera;
$('applyQr').onclick=()=>{try{applyQrAsAnchor();}catch(e){reportError('QR APPLY',e);}};
$('cancelQr').onclick=cancelQr;
$('scanQrImage').onclick=()=>$('qrImageInput').click();
$('qrImageInput').onchange=e=>{const f=e.target.files?.[0];if(f)scanQrImage(f).catch(err=>reportError('QR IMAGE',err));e.target.value='';};
$('startPdr').onclick=async()=>{try{if(!sensorPermissionGranted)await requestSensorPermission();if(!headingFusion.calibrated)throw new Error('ابتدا جهت اولیه را ثبت کنید.');pdr.setConfig(pdrConfigFromUi());pdr.setHeading(currentHeading());pdr.start();startPdrHeartbeat();updatePdrUi();setSource('pdr');queuePdrPublish(pdr.snapshot(),'pdr');log('PDR STARTED');}catch(e){reportError('PDR START',e);}};
$('stopPdr').onclick=()=>{pdr.stop();stopPdrHeartbeat();updatePdrUi();queuePdrPublish(pdr.snapshot(),'pdr');log('PDR STOPPED');};
$('resetPdr').onclick=()=>pdr.resetToAnchor();
for(const id of ['stepLength','peakThreshold','maxPeak','minStepInterval','resetThreshold']) $(id).onchange=()=>pdr.setConfig(pdrConfigFromUi());
$('manualHeading').onchange=()=>{
  // Emergency fallback only. Once fusion is calibrated, sensor fusion owns heading.
  if (!headingFusion.calibrated) {
    lastRawHeading=normalizeHeading(numberOr($('manualHeading').value,90));
    pdr.setHeading(lastRawHeading);
  }
};
$('modelVerticalOffset').onchange=()=>{view3d?.setVerticalOffset(numberOr($('modelVerticalOffset').value,0)); if(lastPosition)view3d?.setPosition(lastPosition,{appendPath:false});};
$('loadModelUrl').onclick=()=>loadModelFromUrl().catch(e=>reportError('MODEL',e));
$('pickModelFile').onclick=()=>$('modelFile').click();
$('modelFile').onchange=async e=>{const f=e.target.files?.[0];try{if(f){const v=await ensure3D();await v.loadModel(f);await setViewerMode('3d');}}catch(err){reportError('MODEL FILE',err);}finally{e.target.value='';}};
$('tab2d').onclick=()=>setViewerMode('2d');$('tab3d').onclick=()=>setViewerMode('3d');
$('toggleFollow').onclick=()=>{followUser=!followUser;map2d?.setFollow(followUser);view3d?.setFollow(followUser);$('toggleFollow').textContent=`Follow: ${followUser?'ON':'OFF'}`;};
$('clearTrack').onclick=()=>{map2d?.clearPath();view3d?.clearPath();log('TRACK CLEARED');};
$('fit3d').onclick=async()=>{try{const v=await ensure3D();v.fitModel();}catch(e){reportError('3D FIT',e);}};
window.addEventListener('online',()=>{$('network').textContent='Network: online';$('network').className='pill ok';});
window.addEventListener('offline',()=>{$('network').textContent='Network: offline';$('network').className='pill bad';});
window.addEventListener('pagehide',()=>{stopQrCamera();stopGpsLive();});

async function boot(){
  $('secure').textContent=`Secure Context: ${isSecureContext?'YES':'NO'}`;$('secure').className=`pill ${isSecureContext?'ok':'bad'}`;
  $('network').textContent=`Network: ${navigator.onLine?'online':'offline'}`;$('network').className=`pill ${navigator.onLine?'ok':'bad'}`;
  $('motionPermission').textContent='Motion: tap Enable';$('orientationPermission').textContent='Heading: tap Enable';
  loadProfile();
  pdr.setConfig(pdrConfigFromUi());
  lastRawHeading=normalizeHeading(numberOr($('manualHeading').value,90));pdr.setHeading(lastRawHeading);
  updatePdrUi();
  await initViewers();
  drawAccelChart();
  log('NCC MOBILE STAGE107 READY · QR + PDR + 2D + 3D + LIVE RELAY');
}
boot().catch(e=>reportError('BOOT',e));

const __cardinalTest = projectStepCardinalSelfTest(); if(!__cardinalTest.ok) console.error('PDR CARDINAL SELF TEST FAILED',__cardinalTest); else console.info('[NCC Stage107] PDR cardinal convention OK: 0=N 90=E 180=S 270=W');
