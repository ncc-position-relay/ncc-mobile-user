const MAPLIBRE_URLS = [
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js',
];
const MAPLIBRE_CSS_URLS = [
  'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css',
];

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error(`Failed ${url}`)); };
    document.head.append(s);
  });
}

export async function ensureMapLibre() {
  if (window.maplibregl) return window.maplibregl;
  if (!document.querySelector('link[data-ncc-maplibre]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS_URLS[0]; link.dataset.nccMaplibre = '1';
    link.onerror = () => { link.href = MAPLIBRE_CSS_URLS[1]; };
    document.head.append(link);
  }
  let last;
  for (const url of MAPLIBRE_URLS) {
    try { await loadScript(url); if (window.maplibregl) return window.maplibregl; }
    catch (e) { last = e; }
  }
  throw last || new Error('MapLibre unavailable.');
}

function geojsonLine(coords) {
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}
function geojsonPoints(points) {
  return {
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature', properties: { id: p.id }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

export class MobileMap2D {
  constructor(container, config, statusEl = null) {
    this.container = container;
    this.cfg = config;
    this.statusEl = statusEl;
    this.map = null;
    this.userMarker = null;
    this.path = [];
    this.follow = true;
    this.fallback = null;
    this.current = null;
  }

  async init() {
    try {
      const ml = await ensureMapLibre();
      this.map = new ml.Map({
        container: this.container,
        style: {
          version: 8,
          sources: {
            osm: { type: 'raster', tiles: this.cfg.rasterTiles, tileSize: 256, attribution: '© OpenStreetMap contributors' },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: this.cfg.center,
        zoom: this.cfg.zoom,
        minZoom: this.cfg.minZoom,
        maxZoom: this.cfg.maxZoom,
        attributionControl: true,
      });
      this.map.addControl(new ml.NavigationControl({ showCompass: true }), 'top-right');
      await new Promise(resolve => this.map.once('load', resolve));
      this.map.addSource('ncc-path', { type: 'geojson', data: geojsonLine([]) });
      this.map.addLayer({ id: 'ncc-path', type: 'line', source: 'ncc-path', paint: { 'line-color': '#4fe0ff', 'line-width': 5, 'line-opacity': .9 } });
      this.map.addSource('ncc-qr', { type: 'geojson', data: geojsonPoints(this.cfg.qrPoints || []) });
      this.map.addLayer({ id: 'ncc-qr', type: 'circle', source: 'ncc-qr', paint: { 'circle-radius': 8, 'circle-color': '#ffd166', 'circle-stroke-color': '#071822', 'circle-stroke-width': 2 } });
      this.map.addLayer({ id: 'ncc-qr-label', type: 'symbol', source: 'ncc-qr', layout: { 'text-field': ['get','id'], 'text-size': 11, 'text-offset': [0, 1.5] }, paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 2 } });
      this.#makeUserMarker();
      this.#status('MapLibre + OSM آماده');
    } catch (error) {
      this.#status(`Basemap fallback: ${error.message}`);
      this.#initFallback();
    }
  }

  #status(text) { if (this.statusEl) this.statusEl.textContent = text; }

  #makeUserMarker() {
    const el = document.createElement('div');
    el.className = 'ncc-map-user-marker';
    el.innerHTML = '<span class="ncc-map-heading-arrow">▲</span><span class="ncc-map-user-dot"></span>';
    this.userMarker = new window.maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(this.cfg.center)
      .addTo(this.map);
    this.markerEl = el;
  }

  #initFallback() {
    this.container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'ncc-fallback-map';
    this.container.append(canvas);
    this.fallback = canvas;
    const resize = () => {
      const r = this.container.getBoundingClientRect();
      canvas.width = Math.max(320, Math.floor(r.width * devicePixelRatio));
      canvas.height = Math.max(260, Math.floor(r.height * devicePixelRatio));
      canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
      this.#drawFallback();
    };
    new ResizeObserver(resize).observe(this.container); resize();
  }

  setFollow(value) { this.follow = Boolean(value); }
  clearPath() {
    this.path = [];
    if (this.map?.getSource('ncc-path')) this.map.getSource('ncc-path').setData(geojsonLine([]));
    this.#drawFallback();
  }

  setPosition(position, { appendPath = true } = {}) {
    if (!position || !Number.isFinite(position.longitude) || !Number.isFinite(position.latitude)) return;
    this.current = position;
    if (appendPath) {
      const last = this.path.at(-1);
      if (!last || Math.abs(last[0] - position.longitude) > 1e-10 || Math.abs(last[1] - position.latitude) > 1e-10) {
        this.path.push([position.longitude, position.latitude]);
        if (this.path.length > 1200) this.path.shift();
      }
    }
    if (this.map) {
      this.userMarker?.setLngLat([position.longitude, position.latitude]);
      if (this.markerEl) this.markerEl.style.setProperty('--ncc-heading', `${Number(position.headingDeg || 0)}deg`);
      this.map.getSource('ncc-path')?.setData(geojsonLine(this.path));
      if (this.follow) this.map.easeTo({ center: [position.longitude, position.latitude], duration: 250 });
    }
    this.#drawFallback();
  }

  #drawFallback() {
    const c = this.fallback; if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height, dpr = devicePixelRatio || 1;
    ctx.clearRect(0,0,w,h); ctx.fillStyle = '#071822'; ctx.fillRect(0,0,w,h);
    const points = [...(this.cfg.qrPoints || [])];
    if (this.current) points.push({ lon: this.current.longitude, lat: this.current.latitude, id: 'USER' });
    if (!points.length) return;
    const lons = points.map(p=>p.lon), lats=points.map(p=>p.lat);
    let minLon=Math.min(...lons), maxLon=Math.max(...lons), minLat=Math.min(...lats), maxLat=Math.max(...lats);
    const padLon=Math.max((maxLon-minLon)*.25, .00005), padLat=Math.max((maxLat-minLat)*.25,.00005);
    minLon-=padLon; maxLon+=padLon; minLat-=padLat; maxLat+=padLat;
    const xy = (lon,lat)=>[40*dpr+(lon-minLon)/(maxLon-minLon)*(w-80*dpr), h-40*dpr-(lat-minLat)/(maxLat-minLat)*(h-80*dpr)];
    ctx.strokeStyle='#173b4d'; ctx.lineWidth=1*dpr;
    for(let i=0;i<10;i++){const x=i*w/10;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();const y=i*h/10;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    if(this.path.length>1){ctx.strokeStyle='#4fe0ff';ctx.lineWidth=4*dpr;ctx.beginPath();this.path.forEach((p,i)=>{const [x,y]=xy(p[0],p[1]);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();}
    ctx.font=`${11*dpr}px Tahoma`;ctx.textAlign='center';
    for(const p of this.cfg.qrPoints||[]){const [x,y]=xy(p.lon,p.lat);ctx.fillStyle='#ffd166';ctx.beginPath();ctx.arc(x,y,7*dpr,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.fillText(p.id,x,y+20*dpr);}
    if(this.current){const [x,y]=xy(this.current.longitude,this.current.latitude);ctx.fillStyle='#65e39a';ctx.beginPath();ctx.arc(x,y,9*dpr,0,Math.PI*2);ctx.fill();const r=(Number(this.current.headingDeg||0)-90)*Math.PI/180;ctx.strokeStyle='#fff';ctx.lineWidth=3*dpr;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(r)*24*dpr,y+Math.sin(r)*24*dpr);ctx.stroke();}
    ctx.fillStyle='#a9c0cc';ctx.textAlign='left';ctx.fillText('Fallback XY view (basemap library unavailable)',10*dpr,20*dpr);
  }
}
