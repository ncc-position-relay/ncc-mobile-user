import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { runtimeUtmToModel, projectStep } from './utm.js';

export class MobileBuilding3D {
  constructor(container, options = {}, statusEl = null) {
    this.container = container;
    this.options = options;
    this.statusEl = statusEl;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.modelRoot = null;
    this.avatar = null;
    this.avatarPhoto = null;
    this.pathLine = null;
    this.pathPoints = [];
    this.qrGroup = null;
    this.follow = true;
    this.transform = options.transform;
    this.verticalOffsetM = Number(options.verticalOffsetM || 0);
    this.loadedModelUrl = null;
    this.resizeObserver = null;
    this.initialized = false;
  }

  #status(text) { if (this.statusEl) this.statusEl.textContent = text; }

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071822);
    scene.fog = new THREE.FogExp2(0x071822, 0.0025);

    const camera = this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 5000);
    camera.position.set(20, 18, 20);

    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    this.container.innerHTML = '';
    this.container.append(renderer.domElement);

    const controls = this.controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1.5, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x335566, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.4); light.position.set(30,50,20); scene.add(light);

    const grid = new THREE.GridHelper(this.options.gridSizeM || 80, this.options.gridDivisions || 40, 0x4a7085, 0x183a49);
    grid.position.y = 0; scene.add(grid);
    const axes = new THREE.AxesHelper(3); scene.add(axes);

    this.#makeQrMarkers();
    this.#makeAvatar();
    this.#makePath();

    const resize = () => {
      const r = this.container.getBoundingClientRect();
      if (!r.width || !r.height) return;
      camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
      renderer.setSize(r.width, r.height, false);
    };
    this.resizeObserver = new ResizeObserver(resize); this.resizeObserver.observe(this.container); resize();

    const animate = () => {
      if (!this.renderer) return;
      requestAnimationFrame(animate);
      controls.update(); renderer.render(scene, camera);
    };
    animate();
    this.#status('3D آماده · در صورت وجود GLB آن را بارگذاری کنید.');
  }

  #makeAvatar() {
    const g = this.avatar = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.75, 6, 12), new THREE.MeshStandardMaterial({ color: 0x37d8e6, roughness: .65 }));
    body.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 12), new THREE.MeshStandardMaterial({ color: 0xf3e2d4, roughness: .8 }));
    head.position.y = 1.42;
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.45, 12), new THREE.MeshStandardMaterial({ color: 0xffd166 }));
    arrow.rotation.x = Math.PI/2; arrow.position.set(0, 1.1, -0.55);
    g.add(body, head, arrow); g.visible = false; this.scene.add(g);
    this.avatarArrow = arrow;
  }

  setUserPhoto(dataUrl) {
    if (this.avatarPhoto) { this.avatar.remove(this.avatarPhoto); this.avatarPhoto.material?.map?.dispose?.(); this.avatarPhoto.material?.dispose?.(); this.avatarPhoto = null; }
    if (!dataUrl) return;
    const texture = new THREE.TextureLoader().load(dataUrl);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = this.avatarPhoto = new THREE.Sprite(material); sprite.scale.set(.62,.62,1); sprite.position.set(0,1.95,0);
    this.avatar.add(sprite);
  }

  #makeQrMarkers() {
    this.qrGroup = new THREE.Group(); this.scene.add(this.qrGroup);
    for (const p of this.options.qrPoints || []) {
      const local = runtimeUtmToModel(p.e, p.n, this.transform);
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(.20,.20,.10,16), new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x442900 }));
      marker.position.set(local.x, Number(p.h || 0) + .05 + this.verticalOffsetM, local.z);
      marker.userData.qrId = p.id; this.qrGroup.add(marker);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,.8,8), new THREE.MeshStandardMaterial({ color: 0xffd166 }));
      pole.position.set(local.x, Number(p.h || 0) + .45 + this.verticalOffsetM, local.z); this.qrGroup.add(pole);
    }
  }

  #makePath() {
    const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const mat = new THREE.LineBasicMaterial({ color: 0x4fe0ff });
    this.pathLine = new THREE.Line(geom, mat); this.pathLine.visible = false; this.scene.add(this.pathLine);
  }

  clearPath() {
    this.pathPoints = []; this.pathLine.visible = false;
  }

  setFollow(value) { this.follow = Boolean(value); }
  setVerticalOffset(value) { this.verticalOffsetM = Number(value || 0); }

  async loadModel(urlOrFile) {
    await this.init();
    if (this.modelRoot) { this.scene.remove(this.modelRoot); this.modelRoot = null; }
    let url = urlOrFile;
    let revoke = null;
    if (urlOrFile instanceof File) { url = URL.createObjectURL(urlOrFile); revoke = url; }
    if (!url) throw new Error('GLB URL/File is empty.');
    this.#status('در حال بارگذاری GLB…');
    try {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
      loader.setDRACOLoader(draco);
      const gltf = await loader.loadAsync(url);
      draco.dispose();
      const root = gltf.scene || gltf.scenes?.[0];
      if (!root) throw new Error('GLB scene not found.');
      this.modelRoot = root;
      root.traverse(o => { if (o.isMesh) { o.frustumCulled = true; o.castShadow = false; o.receiveShadow = false; } });
      this.scene.add(root); root.updateMatrixWorld(true);
      this.fitModel();
      this.loadedModelUrl = typeof urlOrFile === 'string' ? urlOrFile : urlOrFile.name;
      this.#status(`GLB آماده · ${this.loadedModelUrl}`);
      return root;
    } catch (error) {
      this.#status(`GLB load error: ${error.message}. اگر فایل Draco/بسیار سنگین است یک GLB سبک و بدون فشرده‌سازی Draco برای موبایل بسازید.`);
      throw error;
    } finally {
      if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 60_000);
    }
  }

  fitModel() {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * .45, 5);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius, radius*.7, radius));
    this.camera.near = Math.max(.02, radius/500); this.camera.far = Math.max(1000, radius*15); this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setPosition(position, { appendPath = true } = {}) {
    if (!position || !Number.isFinite(position.easting) || !Number.isFinite(position.northing)) return;
    const here = runtimeUtmToModel(position.easting, position.northing, this.transform);
    const y = Number(position.h || 0) + this.verticalOffsetM;
    this.avatar.visible = true; this.avatar.position.set(here.x, y, here.z);

    const nextUtm = projectStep(position.easting, position.northing, 1, position.headingDeg || 0);
    const next = runtimeUtmToModel(nextUtm.easting, nextUtm.northing, this.transform);
    const dx = next.x - here.x, dz = next.z - here.z;
    const yaw = Math.atan2(dx, -dz);
    this.avatar.rotation.y = yaw;

    if (appendPath) {
      const last = this.pathPoints.at(-1);
      const p = new THREE.Vector3(here.x, y + .04, here.z);
      if (!last || last.distanceToSquared(p) > 0.0001) this.pathPoints.push(p);
      if (this.pathPoints.length > 1200) this.pathPoints.shift();
      if (this.pathPoints.length >= 2) {
        this.pathLine.geometry.dispose();
        this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(this.pathPoints);
        this.pathLine.visible = true;
      }
    }

    if (this.follow) {
      const target = new THREE.Vector3(here.x, y + 1.2, here.z);
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.lerp(target, .35);
      this.camera.position.lerp(target.clone().add(offset), .35);
    }
  }
}
