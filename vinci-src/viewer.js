/**
 * VINCI - 3D CAD Viewer with Thermal Visualization
 * 
 * Main entry point for the viewer application.
 * Loads CAD models (GLB files) with multi-level LOD support and integrates
 * volumetric thermal data visualization via raymarching and isosurfaces.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import GUI from 'lil-gui';

// Core modules
import { createScene } from './core/scene.js';
import { ensureLogGui, logEvent, getLogGui } from './core/logging.js';
import { registerUpdater, runUpdaters } from './core/updaters.js';

// Visualization modules
import { setupVolumeRaymarch } from './modules/volume_raymarch.js';
import { setupRuntimeIso } from './modules/runtime_iso.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

// List of component folders containing GLB models
const GLB_FOLDERS = [
  'battery', 'chip1', 'chip2', 'chip3', 'chip4', 'chip5', 'chip6',
  'display', 'enclusure', 'pcb_base', 'pcb_front',
  'section1', 'section2', 'section3', 'section4', 'section5', 'section6',
  'thermal_pipe1', 'thermal_pipe2', 'thermal_speaker', 'thermal_together'
];

const GLB_BASE_PATH = './data/glb_files_organized/';
const MANIFEST_PATH = GLB_BASE_PATH + 'manifest.json';
const LOD_MANIFEST_PATH = GLB_BASE_PATH + 'lod_manifest.json';
const BBOXES_PATH = GLB_BASE_PATH + 'bboxes.json';

// Available LOD levels (percentage of original detail)
const LOD_SUFFIXES = ['100', '50', '20', '10', '05', '02', '01'];

// LOD distance multipliers (higher = switch to lower detail at greater distance)
const LOD_DISTANCE_FACTORS = {
  100: 0,   // Full detail always visible when close
  50: 2,
  20: 4,
  5: 8,
  1: 12     // Lowest detail for far distances
};

// Occlusion detection tolerance (in world units)
const OCCLUSION_EPSILON = 1e-6;
// Loading timeout for network requests (milliseconds)
const NETWORK_TIMEOUT = 30000;

// Cache buster interval (set to null to disable, or use a version string instead of Date.now())
const CACHE_BUSTER = () => Date.now();

// Neutral gray color palette for CAD components
const GRAY_PALETTE = [
  '#4a4a4a', '#555555', '#606060', '#6b6b6b', '#767676', '#818181',
  '#8c8c8c', '#969696', '#a0a0a0', '#aaaaaa', '#b4b4b4', '#bebebe',
  '#c6c6c6', '#cecece', '#d4d4d4', '#dadada', '#e0e0e0', '#e6e6e6',
  '#5a5a5a', '#656565', '#707070', '#7b7b7b', '#868686', '#919191'
];

/**
 * Fetch helper with timeout
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}
// =============================================================================
// STATE MANAGEMENT
// =============================================================================

let manifest = null;           // Primary GLB file manifest
let lodManifest = null;        // LOD-specific manifest
let isoStats = null;           // Thermal data statistics
let bboxIndex = null;          // Precomputed bounding boxes
let showBBoxes = false;        // Global bounding box visibility toggle

const loadedModels = {};       // Stores loaded THREE.LOD objects and metadata
let loadedCount = 0;
const totalToLoad = GLB_FOLDERS.length;
const loader = new GLTFLoader();

// UI references
let meshGui = null;
let heatGui = null;

// =============================================================================
// MANIFEST & METADATA LOADERS
// =============================================================================

/**
 * Loads the primary manifest (maps folder names to GLB filenames)
 */
async function loadManifest() {
  if (manifest) return manifest;
  try {
    const res = await fetchWithTimeout(MANIFEST_PATH + '?v=' + CACHE_BUSTER());
    if (!res.ok) throw new Error('Failed to fetch manifest');
    manifest = await res.json();
  } catch (e) {
    console.warn('Manifest not found, will fallback to probing.', e);
    manifest = {};
  }
  return manifest;
}

/**
 * Loads the LOD manifest (maps folder names to LOD levels and files)
 */
async function loadLODManifest() {
  if (lodManifest) return lodManifest;
  try {
    const res = await fetchWithTimeout(LOD_MANIFEST_PATH + '?v=' + CACHE_BUSTER());
    if (!res.ok) throw new Error('Failed to fetch LOD manifest');
    lodManifest = await res.json();
  } catch (e) {
    console.warn('LOD manifest not found, will use fallback probing.', e);
    lodManifest = null;
  }
  return lodManifest;
}

/**
 * Loads thermal statistics from volume metadata
 */
async function loadIsoStats() {
  if (isoStats) return isoStats;
  try {
    const res = await fetchWithTimeout('./data/volume/volume.json?v=' + CACHE_BUSTER());
    if (!res.ok) throw new Error('Failed to fetch volume metadata');
    const meta = await res.json();
    const vmin = meta?.valueRange?.[0] ?? 0;
    const vmax = meta?.valueRange?.[1] ?? 1;
    const mid = (vmin + vmax) * 0.5;
    isoStats = {
      min: vmin,
      max: vmax,
      percentiles: { p10: vmin, p75: mid, p975: vmax }
    };
  } catch (e) {
    console.warn('Failed to load volume statistics.', e);
    isoStats = null;
  }
  return isoStats;
}

/**
 * Loads precomputed bounding boxes for all components
 */
async function loadBBoxes() {
  try {
    const res = await fetchWithTimeout(BBOXES_PATH + '?v=' + CACHE_BUSTER());
    if (!res.ok) return null;
    bboxIndex = await res.json();
    return bboxIndex;
  } catch (e) {
    console.warn('Failed to load bounding boxes.', e);
    return null;
  }
}

// =============================================================================
// LOD MANAGEMENT
// =============================================================================

/**
 * Probes available LOD files for a given folder
 * Returns array of { lod: number, url: string } sorted by detail (high to low)
 */
async function probeLODFiles(folder) {
  const mLOD = await loadLODManifest();
  const results = [];

  // Check LOD manifest first
  if (mLOD && mLOD[folder]) {
    const entry = mLOD[folder];
    if (typeof entry === 'object' && entry !== null) {
      for (const [lodStr, file] of Object.entries(entry)) {
        const lod = parseInt(lodStr, 10);
        const url = GLB_BASE_PATH + folder + '/' + file + '?v=' + CACHE_BUSTER();
        results.push({ lod, url });
      }
      return results.sort((a, b) => b.lod - a.lod);
    }
  }

  // Special case: display.glb (no LOD variants)
  if (folder === 'display') {
    const url = GLB_BASE_PATH + 'display/display.glb?v=' + CACHE_BUSTER();
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) results.push({ lod: 100, url });
    } catch (e) {
      console.warn(`Failed to verify display.glb: ${e.message}`);
    }
    return results;
  }

  // Fallback: check primary manifest
  const m = await loadManifest();
  if (m[folder]) {
    const file = m[folder];
    let lod = 100;
    const match = file.match(/_(\d+)\.glb$/);
    if (match) lod = parseInt(match[1], 10);
    if (file.includes('_05.')) lod = 5;
    if (file.includes('_02.')) lod = 2;
    if (file.includes('_01.')) lod = 1;

    const url = GLB_BASE_PATH + folder + '/' + file + '?v=' + CACHE_BUSTER();
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) results.push({ lod, url });
    } catch (e) {
      console.warn(`Failed to verify ${file}: ${e.message}`);
    }
  }

  // Probe standard LOD file patterns
  for (const suf of LOD_SUFFIXES) {
    const url = GLB_BASE_PATH + folder + '/' + `${folder}_${suf}.glb?v=` + CACHE_BUSTER();
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        const lod = suf === '05' ? 5 : suf === '02' ? 2 : suf === '01' ? 1 : parseInt(suf, 10);
        if (!results.some(r => r.lod === lod)) {
          results.push({ lod, url });
        }
      }
    } catch (e) {
      // Silent fail for probing - expected behavior
    }
  }

  return results.sort((a, b) => b.lod - a.lod);
}

/**
 * Gets the bounding sphere radius for a component (used for LOD distance calculation)
 */
function getFolderRadius(folder) {
  if (!bboxIndex?.items?.[folder]?.bbox) return 0.1;
  
  const bbox = bboxIndex.items[folder].bbox;
  const size = new THREE.Vector3(
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2]
  );
  const radius = size.length() * 0.5;
  return Math.max(radius, 0.05);
}

/**
 * Calculates LOD switch distance based on detail level and component size
 */
function lodDistanceFor(lod, radius) {
  const factor = LOD_DISTANCE_FACTORS[lod] ?? 6;
  return factor * radius;
}

// =============================================================================
// MATERIAL & STYLING
// =============================================================================

/**
 * Assigns a unique gray color to each component for neutral visualization
 */
function grayForFolder(folder) {
  const idxInList = GLB_FOLDERS.indexOf(folder);
  if (idxInList >= 0) {
    return GRAY_PALETTE[idxInList % GRAY_PALETTE.length];
  }
  
  // Hash-based color for unknown folders
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = (hash * 31 + folder.charCodeAt(i)) & 0xffffffff;
  }
  const idx = Math.abs(hash) % GRAY_PALETTE.length;
  return GRAY_PALETTE[idx];
}

/**
 * Applies neutral material styling to mesh objects
 * PCB layers get special polygon offset to prevent z-fighting
 */
function applyMaterialBias(folder, obj) {
  if (!obj.isMesh) return;

  const baseColor = grayForFolder(folder);
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    flatShading: true,
    metalness: 0.0,
    roughness: 0.95
  });

  // Special rendering order for layered components
  const isPCB = (folder === 'pcb_front' || folder === 'pcb_base');
  const isSection = folder.startsWith('section');

  if (isPCB) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    obj.renderOrder = 20;
  } else if (isSection) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    obj.renderOrder = 10;
  }

  obj.material = mat;
  obj.userData = obj.userData || {};
  obj.userData.__folder = folder;
}

/**
 * Reapplies materials to all loaded models (useful after style changes)
 */
function reapplyLookToAllCAD() {
  Object.entries(loadedModels).forEach(([folder, entry]) => {
    const obj = entry?.mesh;
    if (!obj) return;
    obj.traverse(n => {
      if (n.isMesh) applyMaterialBias(folder, n);
    });
  });
}

// =============================================================================
// UI CONSTRUCTION
// =============================================================================

/**
 * Builds the main control panels:
 * - Mesh Visibility Controls (toggles for all CAD components)
 * - Heat Visualization Controls (volume rendering and isosurfaces)
 */
function buildPanels() {
  // Clean up existing panels
  try { if (meshGui?.destroy) meshGui.destroy(); } catch {}
  try { if (heatGui?.destroy) heatGui.destroy(); } catch {}

  // === MESH VISIBILITY PANEL ===
  meshGui = new GUI({ width: 310 });
  meshGui.domElement.style.position = 'absolute';
  meshGui.domElement.style.top = '20px';
  meshGui.domElement.style.right = '20px';
  meshGui.domElement.style.zIndex = '300';
  
  // Set panel title
  try {
    const titleEl = meshGui.domElement.querySelector('.title');
    if (titleEl) titleEl.textContent = 'Mesh Visibility Controls';
  } catch {}

  // Helper to set component visibility
  const setVis = (name, v) => {
    const model = loadedModels[name];
    if (model?.mesh) {
      model.visible = v;
      model.mesh.visible = v;
      if (model.bboxHelper) {
        model.bboxHelper.visible = showBBoxes && v;
      }
    }
  };

  // Bounding box toggle
  const bboxObj = { on: false };
  meshGui.add(bboxObj, 'on')
    .name('Display Bounding Box')
    .onChange(v => {
      showBBoxes = v;
      Object.keys(loadedModels).forEach(name => {
        const entry = loadedModels[name];
        if (entry?.bboxHelper) {
          entry.bboxHelper.visible = showBBoxes && (entry.mesh?.visible ?? true);
        }
      });
    });

  // === SURFACE PRO COMPONENTS FOLDER ===
  const componentsFolder = meshGui.addFolder('Surface Pro Components');

  // Screen (formerly 'display')
  const displayObj = { on: loadedModels['display']?.visible ?? true };
  componentsFolder.add(displayObj, 'on')
    .name('Screen')
    .onChange(v => setVis('display', v));

  // Enclosure and Battery
  ['enclusure', 'battery'].forEach(key => {
    const label = key === 'enclusure' ? 'Enclosure' : 'Battery';
    const obj = { on: loadedModels[key]?.visible ?? true };
    componentsFolder.add(obj, 'on')
      .name(label)
      .onChange(v => setVis(key, v));
  });

  // Chips (unified toggle)
  const chipNames = ['chip1', 'chip2', 'chip3', 'chip4', 'chip5', 'chip6'];
  const chipsObj = { 
    on: chipNames.every(n => loadedModels[n]?.visible ?? true) 
  };
  componentsFolder.add(chipsObj, 'on')
    .name('Chips')
    .onChange(v => chipNames.forEach(n => setVis(n, v)));

  // Thermal components (unified toggle)
  const thermNames = ['thermal_pipe1', 'thermal_pipe2', 'thermal_speaker', 'thermal_together'];
  const thermObj = { 
    on: thermNames.every(n => loadedModels[n]?.visible ?? true) 
  };
  componentsFolder.add(thermObj, 'on')
    .name('Thermal Mgmt and Audio')
    .onChange(v => thermNames.forEach(n => setVis(n, v)));

  // === PCB AND LAYERS SUBFOLDER ===
  const pcbFolder = componentsFolder.addFolder('PCB and Layers');

  // PCB Base and Front
  ['pcb_base', 'pcb_front'].forEach(key => {
    const label = key === 'pcb_base' ? 'PCB Base' : 'PCB Front';
    const obj = { on: loadedModels[key]?.visible ?? true };
    pcbFolder.add(obj, 'on')
      .name(label)
      .onChange(v => setVis(key, v));
  });

  // Layers (sections in reverse order for UI clarity)
  const sectionsRev = ['section6', 'section5', 'section4', 'section3', 'section2', 'section1'];
  sectionsRev.forEach((name, idx) => {
    if (!GLB_FOLDERS.includes(name)) return;
    const obj = { on: loadedModels[name]?.visible ?? true };
    pcbFolder.add(obj, 'on')
      .name(`Layer ${idx + 1}`)
      .onChange(v => setVis(name, v));
  });

  // Open folders by default
  meshGui.open?.();
  componentsFolder.open();
  pcbFolder.open();

  // === HEAT VISUALIZATION PANEL ===
  heatGui = new GUI({ width: 310 });
  heatGui.domElement.style.position = 'absolute';
  heatGui.domElement.style.right = '20px';
  heatGui.domElement.style.zIndex = '300';

  // Set panel title
  try {
    const titleEl = heatGui.domElement.querySelector('.title');
    if (titleEl) titleEl.textContent = 'Heat Visualization Controls';
  } catch {}

  // Position below mesh panel after layout
  setTimeout(() => {
    try {
      const rect = meshGui.domElement.getBoundingClientRect();
      const top = Math.max(20, Math.floor(rect.top + rect.height + 12));
      heatGui.domElement.style.top = `${top}px`;
    } catch {
      heatGui.domElement.style.top = '420px';
    }
    
    ensureLogGui();
    layoutRightPanels();
  }, 0);

  // Setup heat visualization modules
  try {
    const heatMapFolder = heatGui.addFolder('Heat Map');
    setupVolumeRaymarch({ 
      gui: heatMapFolder, 
      scene, 
      renderer, 
      volumeBasePath: './data/volume/', 
      getStats: loadIsoStats,
      wrapInFolder: false 
    });

    const isoFolder = heatGui.addFolder('Isosurfaces');
    setupRuntimeIso({ 
      gui: isoFolder, 
      scene, 
      getStats: loadIsoStats, 
      volumeBasePath: './data/volume/' 
    });

    heatMapFolder.open();
    isoFolder.open();
  } catch (e) {
    console.warn('Heat panel setup failed', e);
  }

  ensureLogGui();
  layoutRightPanels();
}

/**
 * Positions all right-side panels vertically
 */
function layoutRightPanels() {
  try {
    const meshRect = meshGui?.domElement?.getBoundingClientRect();
    const heatRect = heatGui?.domElement?.getBoundingClientRect();

    if (meshRect && heatGui) {
      const top = Math.max(20, Math.floor(meshRect.top + meshRect.height + 12));
      heatGui.domElement.style.top = `${top}px`;
    }

    const logGui = getLogGui();
    if (heatRect && logGui) {
      logGui.domElement.style.top = `${Math.floor(heatRect.top + heatRect.height + 12)}px`;
    }
  } catch {}
}

// =============================================================================
// SCENE INITIALIZATION
// =============================================================================

const loadingScreen = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const progressBar = document.getElementById('progress-bar');

const { scene, camera, renderer, controls } = createScene(
  document.getElementById('canvas-container')
);

// Expose utility functions for modules
try {
  window.__registerUpdater = registerUpdater;
  window.logEvent = logEvent;
} catch {}

// Initialize panels (must happen after loadedModels is declared)
buildPanels();

// Seed log with startup message
logEvent('Viewer initialized – logging active');

// =============================================================================
// MODEL LOADING
// =============================================================================

/**
 * Updates loading UI progress bar
 */
function updateLoadingUI(name) {
  loadedCount++;
  const percent = Math.round((loadedCount / totalToLoad) * 100);
  progressBar.textContent = percent + '%';
  progressBar.style.width = percent + '%';
  loadingStatus.textContent = `Loaded: ${name} (${loadedCount}/${totalToLoad})`;

  if (loadedCount === totalToLoad) {
    setTimeout(() => {
      loadingScreen.style.display = 'none';
      loadBBoxes().then(() => {
        buildBBoxesForLoadedModels();
        fitCameraToLoadedBounds();
      });
    }, 500);
  }
}

/**
 * Loads all GLB models with LOD support
 */
function loadGLBModels() {
  GLB_FOLDERS.forEach(async folder => {
    const lods = await probeLODFiles(folder);
    
    if (!lods || lods.length === 0) {
      updateLoadingUI(folder + ' (not found)');
      logEvent(`No LODs found for ${folder}`);
      return;
    }

    const radius = getFolderRadius(folder);
    const lodObj = new THREE.LOD();
    scene.add(lodObj);

    loadedModels[folder] = {
      mesh: lodObj,
      visible: true,
      lodLevels: [],
      _lastLodIndex: -1,
      _wasInFrustum: undefined
    };

    let remaining = lods.length;
    
    lods.forEach(level => {
      loader.load(
        level.url,
        gltf => {
          // Apply materials to all meshes
          gltf.scene.traverse(obj => applyMaterialBias(folder, obj));
          
          const dist = lodDistanceFor(level.lod, radius);
          lodObj.addLevel(gltf.scene, dist);
          
          loadedModels[folder].lodLevels.push({ lod: level.lod, distance: dist });
          logEvent(`Loaded ${folder} LOD ${level.lod} at dist ${dist.toFixed(3)}`);
          
          if (--remaining === 0) {
            updateLoadingUI(folder);
          }
        },
        undefined,
        err => {
          logEvent(`Failed to load ${folder} LOD ${level.lod}`);
          if (--remaining === 0) {
            updateLoadingUI(folder + ' (partial)');
          }
        }
      );
    });
  });
}

/**
 * Creates visual bounding box helpers for all loaded models
 */
function buildBBoxesForLoadedModels() {
  if (!bboxIndex?.items) return;

  Object.keys(loadedModels).forEach(name => {
    const entry = loadedModels[name];
    if (!entry) return;

    const meta = bboxIndex.items[name];
    if (!meta?.bbox || entry.bboxHelper) return;

    const { min: bmin, max: bmax } = meta.bbox;
    if (!Array.isArray(bmin) || !Array.isArray(bmax)) return;

    const box = new THREE.Box3(
      new THREE.Vector3(bmin[0], bmin[1], bmin[2]),
      new THREE.Vector3(bmax[0], bmax[1], bmax[2])
    );

    const helper = new THREE.Box3Helper(box, new THREE.Color('#ffffff'));
    
    // Draw bbox on top for clarity
    if (helper.material) {
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.material.opacity = 0.95;
    }
    helper.renderOrder = 999;
    helper.visible = showBBoxes && (entry.visible !== false);
    
    scene.add(helper);
    entry.bboxHelper = helper;
  });
}

/**
 * Fits camera to encompass all loaded models
 */
function fitCameraToLoadedBounds() {
  if (!bboxIndex?.items) return;

  const names = Object.keys(loadedModels);
  if (names.length === 0) return;

  let min = new THREE.Vector3(+Infinity, +Infinity, +Infinity);
  let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  // Compute overall bounding box
  for (const name of names) {
    const item = bboxIndex.items[name];
    if (!item?.bbox) continue;

    const { min: bmin, max: bmax } = item.bbox;
    if (!Array.isArray(bmin) || !Array.isArray(bmax)) continue;

    min.min(new THREE.Vector3(bmin[0], bmin[1], bmin[2]));
    max.max(new THREE.Vector3(bmax[0], bmax[1], bmax[2]));
  }

  if (!isFinite(min.x) || !isFinite(max.x)) return;

  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  const radius = size.length() * 0.5;
  
  if (radius <= 0) return;

  // Calculate camera distance to fit bounding sphere
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = (radius / Math.sin(fov / 2)) * 1.2;

  // Maintain current viewing direction
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dir.lengthSq() < OCCLUSION_EPSILON) dir.set(1, 1, 1);
  dir.normalize();

  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.001, distance / 1000);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

// =============================================================================
// RENDER LOOP
// =============================================================================

/**
 * Main animation loop
 * Handles LOD updates, frustum culling, and visibility logic
 */
function animate() {
  requestAnimationFrame(animate);

  // Ensure full viewport rendering
  const fullSize = renderer.getSize(new THREE.Vector2());
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, fullSize.x, fullSize.y);

  // Run per-frame updaters (e.g., auto volume LOD)
  try {
    const now = performance.now();
    runUpdaters({ camera, time: now });
  } catch {}

  // Setup frustum for culling checks
  const frustum = new THREE.Frustum();
  const projScreenMatrix = new THREE.Matrix4();
  projScreenMatrix.multiplyMatrices(
    camera.projectionMatrix, 
    camera.matrixWorldInverse
  );
  frustum.setFromProjectionMatrix(projScreenMatrix);

  // Check enclosure visibility for occlusion logic
  const enclosureVisible = loadedModels['enclusure']?.mesh?.visible && 
                          loadedModels['enclusure']?.visible !== false;
  const screenVisible = loadedModels['display']?.mesh?.visible && 
                       loadedModels['display']?.visible !== false;

  Object.entries(loadedModels).forEach(([name, entry]) => {
    if (!entry?.mesh) return;

    const object = entry.mesh;

    // === LOD UPDATE ===
    if (object.isLOD) {
      object.update(camera);

      // Log LOD switches
      const worldPos = new THREE.Vector3();
      object.getWorldPosition(worldPos);
      const camDist = worldPos.distanceTo(camera.position);

      let idx = 0;
      const levels = object.levels;
      for (let i = 0; i < levels.length; i++) {
        idx = i;
        if (i + 1 < levels.length) {
          if (camDist < levels[i + 1].distance) break;
        }
      }

      if (idx !== entry._lastLodIndex) {
        entry._lastLodIndex = idx;
        const meta = entry.lodLevels?.[idx];
        if (meta) {
          logEvent(`${name} switched to LOD ${meta.lod} (distance ${camDist.toFixed(3)})`);
        }
      }
    }

    // === FRUSTUM CULLING ===
    const wasVisible = entry._wasInFrustum ?? false;
    let inFrustum = false;

    if (bboxIndex?.items?.[name]?.bbox) {
      const { center: c, size: s } = bboxIndex.items[name].bbox;
      if (c && s) {
        const center = new THREE.Vector3(c[0], c[1], c[2])
          .applyMatrix4(object.matrixWorld);
        const radius = new THREE.Vector3(s[0], s[1], s[2]).length() * 0.5;
        inFrustum = frustum.containsPoint(center) || 
                   frustum.intersectsSphere(new THREE.Sphere(center, radius));
      }
    } else {
      // Fallback to runtime bbox calculation
      const box = new THREE.Box3().setFromObject(object);
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
      inFrustum = frustum.containsPoint(center) || 
                 frustum.intersectsSphere(new THREE.Sphere(center, radius));
    }

    if (inFrustum !== wasVisible) {
      entry._wasInFrustum = inFrustum;
      logEvent(`${name} ${inFrustum ? 'entered' : 'left'} view frustum`);
    }

    // === VISIBILITY ENFORCEMENT ===
    const checkboxOn = entry.visible !== false;
    let blocked = false;

    // Occlusion logic: hide internal components when enclosure is visible and camera is outside
    if (checkboxOn && enclosureVisible && screenVisible &&
        !name.startsWith('section') && name !== 'enclusure' &&
        bboxIndex?.items?.['enclusure']?.bbox && bboxIndex?.items?.[name]?.bbox) {
      
      const encBox = bboxIndex.items['enclusure'].bbox;
      const itemBox = bboxIndex.items[name].bbox;

      const encMin = new THREE.Vector3(encBox.min[0], encBox.min[1], encBox.min[2]);
      const encMax = new THREE.Vector3(encBox.max[0], encBox.max[1], encBox.max[2]);
      const itemMin = new THREE.Vector3(itemBox.min[0], itemBox.min[1], itemBox.min[2]);
      const itemMax = new THREE.Vector3(itemBox.max[0], itemBox.max[1], itemBox.max[2]);

  const eps = OCCLUSION_EPSILON; // Numeric tolerance

      // Check if item is inside enclosure
      const insideEnclosure = (
        itemMin.x >= encMin.x - eps && itemMin.y >= encMin.y - eps && itemMin.z >= encMin.z - eps &&
        itemMax.x <= encMax.x + eps && itemMax.y <= encMax.y + eps && itemMax.z <= encMax.z + eps
      );

      // Check if camera is outside enclosure
      const cp = camera.position;
      const camInside = (
        cp.x >= encMin.x - eps && cp.y >= encMin.y - eps && cp.z >= encMin.z - eps &&
        cp.x <= encMax.x + eps && cp.y <= encMax.y + eps && cp.z <= encMax.z + eps
      );

      blocked = insideEnclosure && !camInside && (name !== 'display');
    }

    // Final visibility determination
    const finalVisible = checkboxOn && inFrustum && !blocked;
    object.visible = finalVisible;

    // Update bounding box helper visibility (follows checkbox state, not culling)
    if (entry.bboxHelper) {
      entry.bboxHelper.visible = showBBoxes && (entry.visible !== false);
    }
  });

  renderer.render(scene, camera);
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  layoutRightPanels();
});

// =============================================================================
// STARTUP
// =============================================================================

// Load bounding boxes first, then start model loading
loadBBoxes();
loadGLBModels();
animate();
