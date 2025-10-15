/**
 * VOLUME RAYMARCHING MODULE
 * 
 * Implements GPU-based volumetric rendering using 3D textures and GLSL raymarching.
 * Provides interactive controls for opacity, sampling quality, windowing, and automatic LOD.
 * 
 * Features:
 * - WebGL2-based Data3DTexture for efficient volume storage
 * - Front-to-back alpha compositing with early ray termination
 * - Dynamic windowing (min/max) for highlighting temperature ranges
 * - Automatic LOD switching based on camera distance
 * - Green-Yellow-Red colormap for thermal visualization
 */

import * as THREE from 'three';
import { setTooltip } from './gui_utils.js';

export function setupVolumeRaymarch({ 
  gui, 
  scene, 
  renderer, 
  volumeBasePath, 
  getStats, 
  wrapInFolder = true 
}) {
  const folder = wrapInFolder ? gui.addFolder('Heat Map') : gui;
  if (wrapInFolder && folder?.open) folder.open();

  const createdCtrls = [];
  const log = (msg) => {
    try {
      window.logEvent ? window.logEvent(msg) : console.log(msg);
    } catch {
      console.log(msg);
    }
  };

  // Check WebGL2 support (required for 3D textures)
  if (!renderer?.capabilities?.isWebGL2) {
    log('Volume: WebGL2 not available; 3D texture raymarch disabled.');
    return folder;
  }

  // =============================================================================
  // STATE
  // =============================================================================

  let volume = null;        // Current active volume (may be downsampled)
  let baseVolume = null;    // Original full-resolution volume
  let stats = null;         // Thermal statistics from metadata
  let mesh = null;          // THREE.Mesh with custom ShaderMaterial
  let lastAutoLOD = null;   // Track last auto LOD level to avoid spam

  const state = {
    enabled: false,
    opacity: 0.15,
    steps: 128,
    lod: 'Full',          // Internal tracking (auto-managed)
    winMin: 30,           // Window minimum (°C)
    winMax: 55,           // Window maximum (°C)
    resetWindow: () => {
      if (!volume) return;
      state.winMin = volume.valueRange?.[0] ?? 0;
      state.winMax = volume.valueRange?.[1] ?? 1;
      winMinCtrl.updateDisplay?.();
      winMaxCtrl.updateDisplay?.();
      applyUniforms();
    }
  };

  // =============================================================================
  // UI CONTROLS
  // =============================================================================

  // Enable/Disable toggle
  const enabledCtrl = folder.add(state, 'enabled')
    .name('Enabled')
    .onChange(async (v) => {
      if (v) {
        if (!volume) await loadVolume();
        if (volume && !mesh) mesh = createVolumeMesh(volume);
        if (mesh && !scene.children.includes(mesh)) scene.add(mesh);
        if (mesh) {
          mesh.visible = true;
          log('Volume: Enabled');
        } else {
          state.enabled = false;
        }
      } else {
        if (mesh) {
          mesh.visible = false;
          log('Volume: Disabled');
        }
      }
    });
  createdCtrls.push(enabledCtrl);
  setTooltip(enabledCtrl, 'Toggle volume raymarching on/off');

  // Opacity control
  const opacityCtrl = folder.add(state, 'opacity', 0.01, 1.0, 0.01)
    .name('Opacity')
    .onChange(applyUniforms);
  createdCtrls.push(opacityCtrl);
  setTooltip(opacityCtrl, 'Alpha per-sample within the window; higher = denser/less transparent');

  // Sampling steps control
  const stepsCtrl = folder.add(state, 'steps', 16, 512, 1)
    .name('Steps')
    .onChange(applyUniforms);
  createdCtrls.push(stepsCtrl);
  setTooltip(stepsCtrl, 'Number of ray samples; higher = smoother but slower');

  // Windowing controls (subfolder for organization)
  const windowFolder = folder.addFolder('Windowing');
  if (windowFolder?.open) windowFolder.open();

  let winMinCtrl = windowFolder.add(state, 'winMin', 30, 55, 0.1)
    .name('Window min (°C)')
    .onChange(() => {
      if (state.winMin > state.winMax) {
        state.winMin = state.winMax;
        winMinCtrl.updateDisplay?.();
      }
      applyUniforms();
    });

  let winMaxCtrl = windowFolder.add(state, 'winMax', 30, 55, 0.1)
    .name('Window max (°C)')
    .onChange(() => {
      if (state.winMax < state.winMin) {
        state.winMax = state.winMin;
        winMaxCtrl.updateDisplay?.();
      }
      applyUniforms();
    });

  createdCtrls.push(winMinCtrl, winMaxCtrl);
  setTooltip(winMinCtrl, 'Lower bound of the window (display range)');
  setTooltip(winMaxCtrl, 'Upper bound of the window (display range)');

  const resetCtrl = windowFolder.add(state, 'resetWindow')
    .name('Reset window');
  createdCtrls.push(resetCtrl);
  setTooltip(resetCtrl, 'Reset window to full data range');

  // Load statistics in background
  (async () => {
    try {
      stats = await getStats?.();
    } catch {}
  })();

  // =============================================================================
  // AUTO LOD SYSTEM
  // =============================================================================

  /**
   * Register automatic LOD updater based on camera distance
   * Switches between Full, Half, and Quarter resolution for performance
   */
  try {
    const register = window.__registerUpdater;
    register?.(({ camera }) => {
      if (!mesh || !camera || !state.enabled) return;

      const center = new THREE.Vector3();
      mesh.getWorldPosition(center);
      const dist = center.distanceTo(camera.position);

      // Distance thresholds for LOD switching
      let desired = 'Full';
      if (dist > 0.70) desired = 'Quarter';
      else if (dist > 0.45) desired = 'Half';

      if (desired !== lastAutoLOD) {
        lastAutoLOD = desired;
        if (state.lod !== desired) {
          state.lod = desired;
          (async () => {
            log(`Auto volume LOD: ${desired} (distance ${dist.toFixed(3)})`);
            if (!baseVolume) {
              try {
                await loadVolume();
              } catch {}
            }
            if (baseVolume) await rebuildLOD();
          })();
        }
      }
    });
  } catch {}

  // =============================================================================
  // VOLUME DATA LOADING
  // =============================================================================

  /**
   * Loads volume metadata (JSON) and binary data
   */
  async function loadVolume() {
    try {
      const metaRes = await fetch(volumeBasePath + 'volume.json?v=' + Date.now());
      const meta = await metaRes.json();
      const binRes = await fetch(volumeBasePath + 'volume.bin?v=' + Date.now());
      const buf = await binRes.arrayBuffer();

      const dims = meta.dimensions || meta.dims;
      baseVolume = {
        dims,
        spacing: meta.spacing,
        origin: meta.origin || [0, 0, 0],
        valueRange: meta.valueRange,
        data: new Uint8Array(buf)
      };
      volume = baseVolume;

      // Initialize window range
      if (state.winMin === undefined || state.winMax === undefined) {
        state.winMin = volume.valueRange?.[0] ?? 0;
        state.winMax = volume.valueRange?.[1] ?? 1;
      }

      // Update slider domains dynamically based on value range
      const v0 = volume.valueRange?.[0] ?? 30;
      const v1 = volume.valueRange?.[1] ?? 55;
      const span = Math.max(1e-6, Math.abs(v1 - v0));
      const pad = Math.max(0.5, span * 0.1);
      const rangeMin = Math.min(v0, v1) - pad;
      const rangeMax = Math.max(v0, v1) + pad;

      if (winMinCtrl?.min && winMinCtrl?.max) {
        winMinCtrl.min(rangeMin);
        winMinCtrl.max(rangeMax);
      }
      if (winMaxCtrl?.min && winMaxCtrl?.max) {
        winMaxCtrl.min(rangeMin);
        winMaxCtrl.max(rangeMax);
      }

      winMinCtrl.updateDisplay?.();
      winMaxCtrl.updateDisplay?.();

      log('Volume: Loaded volume.bin/json for raymarching.');

      if (state.lod !== 'Full') {
        await rebuildLOD();
      } else {
        const dims = volume.dims || [0, 0, 0];
        log(`Volume mesh switched to Full (dims ${dims[0]}x${dims[1]}x${dims[2]})`);
      }
    } catch (e) {
      console.warn('Failed to load volume for raymarch', e);
      log('Volume: Failed to load (volume.json / volume.bin).');
    }
  }

  // =============================================================================
  // 3D TEXTURE CREATION
  // =============================================================================

  /**
   * Creates a THREE.Data3DTexture from volume data
   */
  function createVolumeTexture(vol) {
    const [X, Y, Z] = vol.dims;
    const tex = new THREE.Data3DTexture(vol.data, X, Y, Z);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  // =============================================================================
  // LOD DOWNSAMPLING
  // =============================================================================

  /**
   * Rebuilds volume at current LOD level by downsampling base volume
   */
  async function rebuildLOD() {
    if (!baseVolume) return;

    const level = state.lod;
    const stride = level === 'Half' ? 2 : level === 'Quarter' ? 4 : 1;

    if (stride === 1) {
      volume = baseVolume;
    } else {
      log(`Volume: Building ${level} LOD (stride ${stride}) ...`);
      volume = downsampleVolume(baseVolume, stride);
      log(`Volume: LOD ready: ${volume.dims[0]}x${volume.dims[1]}x${volume.dims[2]}`);
    }

    // Update mesh texture if it exists
    if (mesh?.material?.isShaderMaterial) {
      const tex = createVolumeTexture(volume);
      mesh.material.uniforms.uVolume.value = tex;
      mesh.material.uniforms.uDims.value.set(volume.dims[0], volume.dims[1], volume.dims[2]);

      // Recompute size and center to preserve world scale
      const [X, Y, Z] = volume.dims;
      const [sx, sy, sz] = volume.spacing;
      const [ox, oy, oz] = volume.origin;
      const size = new THREE.Vector3((X - 1) * sx, (Y - 1) * sy, (Z - 1) * sz);
      const center = new THREE.Vector3(ox + 0.5 * size.x, oy + 0.5 * size.y, oz + 0.5 * size.z);

      mesh.position.copy(center);
      mesh.scale.copy(size);
      mesh.material.needsUpdate = true;
    }

    const dims = volume.dims || [0, 0, 0];
    log(`Volume mesh switched to ${level} (dims ${dims[0]}x${dims[1]}x${dims[2]})`);
  }

  /**
   * Downsamples volume by averaging blocks of voxels
   */
  function downsampleVolume(src, stride) {
    const X = src.dims[0], Y = src.dims[1], Z = src.dims[2];
    const nx = Math.max(1, Math.floor((X + stride - 1) / stride));
    const ny = Math.max(1, Math.floor((Y + stride - 1) / stride));
    const nz = Math.max(1, Math.floor((Z + stride - 1) / stride));

    const dst = new Uint8Array(nx * ny * nz);
    const data = src.data;
    const block = stride;

    let di = 0;
    for (let z = 0; z < Z; z += block) {
      const z1 = Math.min(Z, z + block);
      for (let y = 0; y < Y; y += block) {
        const y1 = Math.min(Y, y + block);
        for (let x = 0; x < X; x += block) {
          const x1 = Math.min(X, x + block);

          // Average block
          let sum = 0, cnt = 0;
          for (let zz = z; zz < z1; zz++) {
            const zoff = zz * (Y * X);
            for (let yy = y; yy < y1; yy++) {
              const yoff = yy * X;
              for (let xx = x; xx < x1; xx++) {
                sum += data[zoff + yoff + xx];
                cnt++;
              }
            }
          }
          dst[di++] = cnt ? Math.round(sum / cnt) : 0;
        }
      }
    }

    // Update spacing to preserve physical world size
    const spacing = [
      src.spacing[0] * stride,
      src.spacing[1] * stride,
      src.spacing[2] * stride
    ];

    return {
      dims: [nx, ny, nz],
      spacing,
      origin: src.origin,
      valueRange: src.valueRange,
      data: dst
    };
  }

  // =============================================================================
  // MESH & SHADER CREATION
  // =============================================================================

  /**
   * Creates the volume rendering mesh with custom raymarching shader
   */
  function createVolumeMesh(vol) {
    const texture = createVolumeTexture(vol);
    const [X, Y, Z] = vol.dims;
    const [sx, sy, sz] = vol.spacing;
    const [ox, oy, oz] = vol.origin;

    // Physical size in world units
    const size = new THREE.Vector3((X - 1) * sx, (Y - 1) * sy, (Z - 1) * sz);
    const center = new THREE.Vector3(
      ox + 0.5 * size.x,
      oy + 0.5 * size.y,
      oz + 0.5 * size.z
    );

    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      depthTest: false,  // Render unoccluded
      side: THREE.FrontSide,
      uniforms: {
        uVolume: { value: texture },
        uDims: { value: new THREE.Vector3(X, Y, Z) },
        uValueMin: { value: vol.valueRange?.[0] ?? 0 },
        uValueMax: { value: vol.valueRange?.[1] ?? 1 },
        uWinMin: { value: state.winMin },
        uWinMax: { value: state.winMax },
        uOpacity: { value: state.opacity },
        uSteps: { value: state.steps },
        uInvModel: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Vector3() },
        uBoxMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
        uBoxMax: { value: new THREE.Vector3(0.5, 0.5, 0.5) }
      },
      vertexShader: `
        out vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        precision highp sampler3D;
        
        in vec3 vWorldPos;
        out vec4 out_FragColor;
        
        uniform sampler3D uVolume;
        uniform vec3 uDims;
        uniform float uValueMin, uValueMax;
        uniform float uWinMin, uWinMax;
        uniform float uOpacity;
        uniform int uSteps;
        uniform mat4 uInvModel;
        uniform vec3 uCameraWorld;
        uniform vec3 uBoxMin;
        uniform vec3 uBoxMax;

        // Green-Yellow-Red thermal colormap
        vec3 colormapGYR(float v) {
          float t = clamp((v - uWinMin) / max(1e-6, (uWinMax - uWinMin)), 0.0, 1.0);
          vec3 green  = vec3(0.184, 0.800, 0.443);
          vec3 yellow = vec3(0.945, 0.769, 0.200);
          vec3 red    = vec3(0.905, 0.298, 0.235);
          
          if (t <= 0.5) {
            return mix(green, yellow, t * 2.0);
          } else {
            return mix(yellow, red, (t - 0.5) * 2.0);
          }
        }

        // Ray-AABB intersection (returns tmin, tmax)
        vec2 rayBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
          vec3 t0 = (bmin - ro) / rd;
          vec3 t1 = (bmax - ro) / rd;
          vec3 tsmaller = min(t0, t1);
          vec3 tbigger  = max(t0, t1);
          float tmin = max(max(tsmaller.x, tsmaller.y), tsmaller.z);
          float tmax = min(min(tbigger.x, tbigger.y), tbigger.z);
          return vec2(tmin, tmax);
        }

        // Hash-based jitter to reduce banding artifacts
        float hash31(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }

        void main() {
          // Transform to object space
          vec3 camObj = (uInvModel * vec4(uCameraWorld, 1.0)).xyz;
          vec3 posObj = (uInvModel * vec4(vWorldPos, 1.0)).xyz;
          vec3 rd = normalize(posObj - camObj);

          // Intersect ray with unit cube
          vec2 hit = rayBox(camObj, rd, uBoxMin, uBoxMax);
          if (hit.y <= 0.0) discard;

          float t0 = max(0.0, hit.x) + 1e-4;
          float t1 = hit.y;
          
          int N = uSteps;
          float dt = (t1 - t0) / float(N);
          vec4 acc = vec4(0.0);
          float jitter = hash31(vWorldPos) * dt;

          // Front-to-back raymarching with early termination
          for (int i = 0; i < 1024; ++i) {
            if (i >= N) break;
            
            vec3 p = camObj + rd * (t0 + jitter + float(i) * dt);
            vec3 uvw = (p - uBoxMin) / (uBoxMax - uBoxMin);
            
            if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) continue;

            // Sample volume and convert to physical units
            float s = texture(uVolume, uvw).r;
            float val = uValueMin + s * (uValueMax - uValueMin);

            // Apply windowing
            float a = uOpacity * smoothstep(uWinMin, uWinMax, val);
            vec3 c = colormapGYR(val);

            // Composite
            acc.rgb += (1.0 - acc.a) * a * c;
            acc.a   += (1.0 - acc.a) * a;

            if (acc.a > 0.98) break;  // Early ray termination
          }

          out_FragColor = acc;
        }
      `
    });

    const m = new THREE.Mesh(geom, mat);
    m.position.copy(center);
    m.scale.copy(size);
    m.renderOrder = 900;  // Draw above CAD models

    // Update dynamic uniforms before each render
    m.onBeforeRender = (renderer, sceneArg, camera, geometry, material) => {
      if (!material?.uniforms) return;
      material.uniforms.uCameraWorld.value.copy(camera.position);
      material.uniforms.uInvModel.value.copy(
        new THREE.Matrix4().copy(m.matrixWorld).invert()
      );
    };

    applyUniformsTo(mat);
    return m;
  }

  // =============================================================================
  // UNIFORM UPDATES
  // =============================================================================

  /**
   * Applies current state to shader uniforms
   */
  function applyUniformsTo(material) {
    if (!material) return;
    material.uniforms.uOpacity.value = state.opacity;
    material.uniforms.uSteps.value = Math.max(1, Math.floor(state.steps));
    if (state.winMin !== undefined) material.uniforms.uWinMin.value = state.winMin;
    if (state.winMax !== undefined) material.uniforms.uWinMax.value = state.winMax;
    if (mesh) {
      const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      material.uniforms.uInvModel.value.copy(inv);
    }
  }

  /**
   * Updates uniforms on the active mesh material
   */
  function applyUniforms() {
    if (mesh?.material?.isShaderMaterial) {
      applyUniformsTo(mesh.material);
      mesh.material.needsUpdate = true;
    }
  }

  return folder;
}
