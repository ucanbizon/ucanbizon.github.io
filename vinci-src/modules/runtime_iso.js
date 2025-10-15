/**
 * RUNTIME ISOSURFACE MODULE
 * 
 * Generates isosurfaces from volumetric thermal data using marching tetrahedra.
 * Extracts surfaces at specific temperature thresholds in a Web Worker for
 * non-blocking performance.
 * 
 * Features:
 * - Web Worker-based extraction (marching_worker.js)
 * - Quality presets (Fast/Balanced/Full)
 * - Gradient magnitude vertex coloring
 * - Solid color option based on threshold temperature
 * - Persistent saved isosurfaces with individual toggles
 */

import * as THREE from 'three';
import { setTooltip } from './gui_utils.js';

export function setupRuntimeIso({ gui, scene, getStats, volumeBasePath }) {
  const folder = gui.addFolder('Isosurfaces');
  if (folder?.open) folder.open();

  const createdCtrls = [];
  const generatedItems = []; // Store generated isosurfaces
  const togglesFolder = folder.addFolder('Saved');

  const log = (msg) => {
    try {
      window.logEvent ? window.logEvent(msg) : console.log(msg);
    } catch {
      console.log(msg);
    }
  };

  // =============================================================================
  // COLOR UTILITIES
  // =============================================================================

  const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  const rgbToHex = ({ r, g, b }) =>
    '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  const lerp = (a, b, t) => a + (b - a) * t;

  const lerpHex = (h1, h2, t) => {
    const a = hexToRgb(h1);
    const b = hexToRgb(h2);
    return rgbToHex({
      r: Math.round(lerp(a.r, b.r, t)),
      g: Math.round(lerp(a.g, b.g, t)),
      b: Math.round(lerp(a.b, b.b, t))
    });
  };

  // =============================================================================
  // STATE
  // =============================================================================

  let volume = null;         // Loaded volume data
  let runtimeGroup = null;   // Container for generated isosurfaces
  let cachedStats = null;    // Thermal statistics for coloring

  const state = {
    levelDeg: 42.5,                    // Isosurface threshold (°C)
    levelText: '42.5 °C',              // Read-only display
    colorBy: 'Gradient',               // 'Solid' | 'Gradient'
    quality: 'Balanced',               // 'Fast' | 'Balanced' | 'Full'
    generate: async () => {
      if (!volume) await loadVolume();
      if (!volume) {
        log('Custom Iso: Missing volume files. Run preprocess script.');
        return;
      }

      // Disable controls during generation
      createdCtrls.forEach(c => c.disable?.());
      log(`Custom Iso: Generating at ${state.levelDeg.toFixed(1)}°C (${state.colorBy}, ${state.quality}) ...`);

      try {
        const mesh = await generateIsoMeshDegrees(state.levelDeg);

        // Store metadata on mesh
        mesh.userData = mesh.userData || {};
        mesh.userData.iso = {
          levelDeg: state.levelDeg,
          mode: state.colorBy,
          quality: state.quality
        };

        // Add to persistent group
        if (!runtimeGroup) {
          runtimeGroup = new THREE.Group();
          scene.add(runtimeGroup);
        }
        runtimeGroup.add(mesh);

        // Create unique label
        const modeTag = state.colorBy === 'Gradient' ? 'Gradient' : 'Solid';
        const qualityTag = state.quality;
        let base = `${state.levelDeg.toFixed(1)}°C (${modeTag}, ${qualityTag})`;
        let label = base;
        let suffix = 2;
        while (generatedItems.some(it => it.label === label)) {
          label = `${base} (${suffix++})`;
        }

        // Add toggle control
        const obj = { [label]: true };
        const ctrl = togglesFolder.add(obj, label).name(label);
        ctrl.onChange(v => { mesh.visible = v; });

        generatedItems.push({ 
          key: label, 
          label, 
          mesh, 
          mode: modeTag, 
          quality: qualityTag 
        });

        togglesFolder.open();
        setTooltip(ctrl, `Show/hide: ${label}`);
        log(`Custom Iso: Generated isosurface at ${label}`);
      } catch (err) {
        console.warn('Custom Iso generation failed:', err);
      } finally {
        // Re-enable controls
        createdCtrls.forEach(c => c.enable?.());
      }
    }
  };

  // =============================================================================
  // UI CONTROLS
  // =============================================================================

  // Temperature slider (30-55 °C)
  const levelCtrl = folder.add(state, 'levelDeg', 30, 55, 0.1)
    .name('Iso level (°C)');
  createdCtrls.push(levelCtrl);
  setTooltip(levelCtrl, 'Iso threshold in degrees Celsius');

  // Read-only temperature display
  const readoutCtrl = folder.add(state, 'levelText').name('T');
  readoutCtrl.disable?.();
  createdCtrls.push(readoutCtrl);
  setTooltip(readoutCtrl, 'Read-only display of the current iso level');

  // Update readout when slider changes
  levelCtrl.onChange(v => {
    state.levelText = v.toFixed(1) + ' °C';
    readoutCtrl.updateDisplay?.();
  });

  // Color mode selector
  const colorCtrl = folder.add(state, 'colorBy', ['Solid', 'Gradient'])
    .name('Color by');
  createdCtrls.push(colorCtrl);
  setTooltip(colorCtrl, 
    'Vertex coloring: Solid (single color) or Gradient magnitude |∇T| ' +
    '(spatial rate of temperature change: green=low, yellow=moderate, red=high)'
  );

  // Quality selector
  const qualityCtrl = folder.add(state, 'quality', ['Fast', 'Balanced', 'Full'])
    .name('Quality');
  createdCtrls.push(qualityCtrl);
  setTooltip(qualityCtrl, 'Extraction stride: Fast (3), Balanced (2), Full (1)');

  // Generate button
  const genCtrl = folder.add(state, 'generate').name('Generate');
  createdCtrls.push(genCtrl);
  setTooltip(genCtrl, 'Extract the isosurface in a Web Worker and add it to the scene');

  // =============================================================================
  // VOLUME LOADING
  // =============================================================================

  /**
   * Loads volume binary data and metadata
   */
  async function loadVolume() {
    try {
      const metaRes = await fetch(volumeBasePath + 'volume.json?v=' + Date.now());
      const meta = await metaRes.json();
      const binRes = await fetch(volumeBasePath + 'volume.bin?v=' + Date.now());
      const buf = await binRes.arrayBuffer();

      const dims = meta.dimensions || meta.dims;
      volume = {
        dims: dims,
        spacing: meta.spacing,
        origin: meta.origin || [0, 0, 0],
        valueRange: meta.valueRange,
        data: new Uint8Array(buf)
      };

      // Warm stats cache for coloring
      try {
        cachedStats = await getStats();
      } catch {}
    } catch (e) {
      console.warn('Failed to load volume:', e);
      log('Custom Iso: Failed to load volume files (volume.json / volume.bin).');
    }
  }

  // =============================================================================
  // ISOSURFACE GENERATION
  // =============================================================================

  /**
   * Generates isosurface mesh at specified temperature threshold
   * Uses Web Worker for non-blocking extraction
   */
  async function generateIsoMeshDegrees(deg) {
    const vmin = volume.valueRange?.[0] || 0;
    const vmax = volume.valueRange?.[1] || 1;
    const threshAbs = Math.min(vmax, Math.max(vmin, deg));

    // Convert absolute threshold to uint8 scale
    const t8 = Math.round(((threshAbs - vmin) / Math.max(1e-12, (vmax - vmin))) * 255);
    const thresh8 = Math.max(0, Math.min(255, t8));

    // Resolve worker URL for GitHub Pages compatibility
    const workerUrl = new URL('../workers/marching_worker.js', import.meta.url);
    const worker = new Worker(workerUrl, { type: 'module' });

    // Copy volume data for transfer
    const copyBuf = volume.data.slice().buffer;

    // Map quality to stride
    const qMap = { Fast: 3, Balanced: 2, Full: 1 };
    const qualityStride = qMap[state.quality] || 2;

    const payload = {
      dims: volume.dims,
      spacing: volume.spacing,
      origin: volume.origin,
      thresh8,
      data: copyBuf,
      valueRange: volume.valueRange,
      qualityStride
    };

    return new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const { positions, normals, scalars } = ev.data || {};

        if (!positions || positions.length === 0) {
          worker.terminate();
          log('Custom Iso: No surface at this level.');
          return reject(new Error('Empty iso'));
        }

        // Build geometry
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        if (normals) {
          geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
        }
        geo.computeVertexNormals();

        // Apply coloring based on mode
        let material;
        if (state.colorBy === 'Gradient' && scalars && scalars.length === (positions.length / 3)) {
          // Create gradient material and attach vertex colors to the geometry
          const { material: gradMat, colorAttr } = createGradientMaterial(scalars);
          geo.setAttribute('color', colorAttr);
          material = gradMat;
        } else {
          const color = solidColorForThreshold(threshAbs);
          material = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
          });
        }

        const mesh = new THREE.Mesh(geo, material);
        resolve(mesh);
        worker.terminate();
      };

      worker.onerror = (e) => {
        worker.terminate();
        log('Custom Iso: Worker error – see console');
        reject(e);
      };

      worker.postMessage(payload, [copyBuf]);
    });
  }

  // =============================================================================
  // MATERIAL CREATION
  // =============================================================================

  /**
   * Creates material with gradient magnitude vertex colors
   * Green (low gradient) -> Yellow (medium) -> Red (high gradient)
   */
  function createGradientMaterial(scalars) {
    const sArr = new Float32Array(scalars);

    // Find gradient magnitude range
    let sMin = +Infinity, sMax = -Infinity;
    for (let i = 0; i < sArr.length; i++) {
      const v = sArr[i];
      if (v < sMin) sMin = v;
      if (v > sMax) sMax = v;
    }

    // Map to colors
    const colors = new Float32Array(sArr.length * 3);
    for (let i = 0; i < sArr.length; i++) {
      const t = (sArr[i] - sMin) / Math.max(1e-12, (sMax - sMin));
      
      // Green -> Yellow -> Red ramp
      const hex = t <= 0.5 
        ? lerpHex('#2ECC71', '#F1C40F', t * 2)
        : lerpHex('#F1C40F', '#E74C3C', (t - 0.5) * 2);

      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;

      const j = i * 3;
      colors[j] = r;
      colors[j + 1] = g;
      colors[j + 2] = b;
    }

    // Return both the material and the color attribute to attach to the target geometry
    return {
      material: new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      }),
      colorAttr: new THREE.BufferAttribute(colors, 3)
    };
  }

  /**
   * Determines solid color based on threshold temperature
   * Uses stats percentiles if available
   */
  function solidColorForThreshold(threshAbs) {
    if (cachedStats?.percentiles) {
      return colorForLevel(threshAbs, cachedStats);
    }

    // Fallback to volume value range
    const vmin = volume?.valueRange?.[0] || 0;
    const vmax = volume?.valueRange?.[1] || 1;
    const mid = (vmin + vmax) * 0.5;

    if (threshAbs <= mid) {
      const t = (threshAbs - vmin) / Math.max(1e-9, (mid - vmin));
      return lerpHex('#2ECC71', '#F1C40F', Math.min(1, Math.max(0, t)));
    } else {
      const t = (threshAbs - mid) / Math.max(1e-9, (vmax - mid));
      return lerpHex('#F1C40F', '#E74C3C', Math.min(1, Math.max(0, t)));
    }
  }

  /**
   * Maps temperature level to color using statistical distribution
   */
  function colorForLevel(level, stats) {
    const val = Number(level);
    if (!stats?.percentiles || !isFinite(val)) return 0xffffff;

    const p = stats.percentiles;
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

    const low = p.p10 ?? stats.min;
    const high = p.p975 ?? stats.max;
    const mid = p.p75 ?? ((low + high) * 0.5);

    if (!isFinite(low) || !isFinite(high) || high <= low) return 0xffffff;

    if (val <= mid) {
      const t = clamp((val - low) / Math.max(1e-9, (mid - low)), 0, 1);
      return lerpHex('#2ECC71', '#F1C40F', t);
    } else {
      const t = clamp((val - mid) / Math.max(1e-9, (high - mid)), 0, 1);
      return lerpHex('#F1C40F', '#E74C3C', t);
    }
  }

  return folder;
}
