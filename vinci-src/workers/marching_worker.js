// Marching Tetrahedra isosurface extractor for uint8 volumes.
// Input: dims [x,y,z], spacing [sx,sy,sz], origin [ox,oy,oz], thresh8 (0..255), data (ArrayBuffer of uint8).

function idx(x, y, z, X, Y) {
  return z * (Y * X) + y * X + x;
}

function interpolate(pA, pB, sA, sB, t) {
  const denom = (sB - sA);
  const tt = denom !== 0 ? (t - sA) / denom : 0.5;
  return [
    pA[0] + (pB[0] - pA[0]) * tt,
    pA[1] + (pB[1] - pA[1]) * tt,
    pA[2] + (pB[2] - pA[2]) * tt,
  ];
}

function addTri(positions, normals, a, b, c) {
  // Compute face normal
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  const cx = c[0], cy = c[1], cz = c[2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

// Tetra decomposition using cube diagonal 0->6
const TETS = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 5, 1, 6],
  [0, 4, 5, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
];

// For a tetra (v0,v1,v2,v3), emit triangles based on threshold crossing.
function processTetra(positions, normals, p, s, t) {
  // s: scalar values for 4 vertices; p: positions for 4 vertices; t: threshold
  const above = [s[0] >= t, s[1] >= t, s[2] >= t, s[3] >= t];
  const count = (above[0] ? 1 : 0) + (above[1] ? 1 : 0) + (above[2] ? 1 : 0) + (above[3] ? 1 : 0);
  if (count === 0 || count === 4) return; // no surface

  // Helper to get edge intersection
  function edge(a, b) { return interpolate(p[a], p[b], s[a], s[b], t); }

  if (count === 1 || count === 3) {
    // One vertex on one side -> one triangle.
    // Ensure we treat the case as a single 'above' vertex by flipping if needed.
    let inv = false;
    let v = above.slice();
    if (count === 3) { // flip
      inv = true;
      v = v.map(x => !x);
    }
    const iTop = v.indexOf(true); // the single 'inside' vertex
    const other = [0,1,2,3].filter(i => i !== iTop);
    const a = edge(iTop, other[0]);
    const b = edge(iTop, other[1]);
    const c = edge(iTop, other[2]);
    if (!inv) addTri(positions, normals, a, b, c);
    else addTri(positions, normals, c, b, a); // flip orientation
  } else if (count === 2) {
    // Two on each side -> quad split into two triangles.
    const inside = [], outside = [];
    for (let i = 0; i < 4; i++) (above[i] ? inside : outside).push(i);
    // Crossing edges connect each inside to each outside (4 edges). Build intersection points.
    const pts = [
      edge(inside[0], outside[0]),
      edge(inside[0], outside[1]),
      edge(inside[1], outside[0]),
      edge(inside[1], outside[1]),
    ];
    // Split into two triangles (ordering may not be perfect but is acceptable for visualization)
    addTri(positions, normals, pts[0], pts[1], pts[2]);
    addTri(positions, normals, pts[1], pts[3], pts[2]);
  }
}

self.onmessage = (ev) => {
  const { dims, spacing, origin, thresh8, data, valueRange, qualityStride } = ev.data || {};
  try {
    if (!dims || !data || !spacing) {
      self.postMessage({ positions: [], normals: [] });
      return;
    }
    const X = dims[0] | 0, Y = dims[1] | 0, Z = dims[2] | 0;
    const sx = spacing[0] || 1, sy = spacing[1] || 1, sz = spacing[2] || 1;
    const ox = (origin && origin[0]) || 0, oy = (origin && origin[1]) || 0, oz = (origin && origin[2]) || 0;
    const vol = new Uint8Array(data);
    // Adaptive stride to keep processing time reasonable
    const cells = Math.max(1, (X - 1) * (Y - 1) * (Z - 1));
  let stride = 1;
  if (cells > 8_000_000) stride = 2;
  if (cells > 27_000_000) stride = 3;
  if (qualityStride && qualityStride > 0) stride = Math.max(1, Math.min(4, qualityStride|0));

  const positions = [];
  const normals = [];
  const scalars = []; // per-vertex gradient magnitude for coloring

    // Reusable arrays for cube corners
    const pos = new Array(8);
    const val = new Uint8Array(8);
    const gmag = new Float32Array(8);

    const vmin = valueRange && valueRange[0] != null ? valueRange[0] : 0;
    const vmax = valueRange && valueRange[1] != null ? valueRange[1] : 255;
    const scale = (vmax - vmin) / 255; // convert u8 diffs to physical units

    function gradMagAt(cx, cy, cz) {
      // One-sided at borders, central elsewhere
      const xm1 = Math.max(0, cx - 1), xp1 = Math.min(X - 1, cx + 1);
      const ym1 = Math.max(0, cy - 1), yp1 = Math.min(Y - 1, cy + 1);
      const zm1 = Math.max(0, cz - 1), zp1 = Math.min(Z - 1, cz + 1);
      const fx_u8 = (vol[idx(xp1, cy, cz, X, Y)] - vol[idx(xm1, cy, cz, X, Y)]) / (xp1 - xm1 || 1);
      const fy_u8 = (vol[idx(cx, yp1, cz, X, Y)] - vol[idx(cx, ym1, cz, X, Y)]) / (yp1 - ym1 || 1);
      const fz_u8 = (vol[idx(cx, cy, zp1, X, Y)] - vol[idx(cx, cy, zm1, X, Y)]) / (zp1 - zm1 || 1);
      const fx = (fx_u8 * scale) / (sx || 1);
      const fy = (fy_u8 * scale) / (sy || 1);
      const fz = (fz_u8 * scale) / (sz || 1);
      return Math.hypot(fx, fy, fz);
    }

    function edgeInterpPosVal(a, b, t, sVals, pPos, gVals) {
      const sA = sVals[a], sB = sVals[b];
      const pA = pPos[a], pB = pPos[b];
      const gA = gVals[a], gB = gVals[b];
      const denom = (sB - sA);
      const tt = denom !== 0 ? (t - sA) / denom : 0.5;
      const px = pA[0] + (pB[0] - pA[0]) * tt;
      const py = pA[1] + (pB[1] - pA[1]) * tt;
      const pz = pA[2] + (pB[2] - pA[2]) * tt;
      const gv = gA + (gB - gA) * tt;
      return [[px, py, pz], gv];
    }

    function addTriWithScalar(a, b, c) {
      addTri(positions, normals, a[0], b[0], c[0]);
      scalars.push(a[1], b[1], c[1]);
    }

    for (let z = 0; z < Z - 1; z += stride) {
      for (let y = 0; y < Y - 1; y += stride) {
        for (let x = 0; x < X - 1; x += stride) {
          // Sample 8 corners
          const x1 = Math.min(x + stride, X - 1);
          const y1 = Math.min(y + stride, Y - 1);
          const z1 = Math.min(z + stride, Z - 1);

          const corners = [
            [x,  y,  z ], // 0
            [x1, y,  z ], // 1
            [x1, y1, z ], // 2
            [x,  y1, z ], // 3
            [x,  y,  z1], // 4
            [x1, y,  z1], // 5
            [x1, y1, z1], // 6
            [x,  y1, z1], // 7
          ];

          for (let i = 0; i < 8; i++) {
            const cx = corners[i][0], cy = corners[i][1], cz = corners[i][2];
            val[i] = vol[idx(cx, cy, cz, X, Y)];
            pos[i] = [ox + cx * sx, oy + cy * sy, oz + cz * sz];
            gmag[i] = gradMagAt(cx, cy, cz);
          }

          // Process 6 tets in this cube
          for (let ti = 0; ti < 6; ti++) {
            const tet = TETS[ti];
            const p = [pos[tet[0]], pos[tet[1]], pos[tet[2]], pos[tet[3]]];
            const s = [val[tet[0]], val[tet[1]], val[tet[2]], val[tet[3]]];
            const g = [gmag[tet[0]], gmag[tet[1]], gmag[tet[2]], gmag[tet[3]]];
            // Process tetra and emit triangles with interpolated gradient magnitude
            const above = [s[0] >= thresh8, s[1] >= thresh8, s[2] >= thresh8, s[3] >= thresh8];
            const count = (above[0]?1:0)+(above[1]?1:0)+(above[2]?1:0)+(above[3]?1:0);
            if (count === 0 || count === 4) continue;
            const edge = (a,b)=>edgeInterpPosVal(a,b,thresh8,s,p,g);
            if (count === 1 || count === 3) {
              let inv = false;
              let v = above.slice();
              if (count === 3) { inv = true; v = v.map(x=>!x); }
              const iTop = v.indexOf(true);
              const other = [0,1,2,3].filter(i=>i!==iTop);
              const A = edge(iTop, other[0]);
              const B = edge(iTop, other[1]);
              const C = edge(iTop, other[2]);
              if (!inv) addTriWithScalar(A,B,C); else addTriWithScalar(C,B,A);
            } else if (count === 2) {
              const inside=[], outside=[]; for (let i=0;i<4;i++) (above[i]?inside:outside).push(i);
              const P0 = edge(inside[0], outside[0]);
              const P1 = edge(inside[0], outside[1]);
              const P2 = edge(inside[1], outside[0]);
              const P3 = edge(inside[1], outside[1]);
              addTriWithScalar(P0,P1,P2);
              addTriWithScalar(P1,P3,P2);
            }
          }
        }
      }
    }

    self.postMessage({ positions, normals, scalars });
  } catch (e) {
    // On any error, return empty to avoid crashing the main thread
    self.postMessage({ positions: [], normals: [], scalars: [] });
  }
};
