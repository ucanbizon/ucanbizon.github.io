# Vinci Viewer

 A clean three.js WebGL viewer for GLB assemblies with LOD, grouped toggles, bounding boxes, runtime isosurfaces, and optional volume raymarching. Designed to run as a static site (GitHub Pages friendly).

## Structure

- `viewer/` – static site root. Open `viewer/index.html`.
- `viewer/data/` – assets (GLBs, bboxes, volume).
- `viewer/modules/` – runtime modules (custom iso, etc.).
- `viewer/workers/` – web workers.

## Run locally

- Quick test (Python):

```powershell
# In the viewer directory
cd viewer
python -m http.server 8080
# Then browse http://localhost:8080/
```

On Windows, if `python` isn’t on PATH, try `py -3 -m http.server 8080`.

## Deploy to GitHub Pages

This repo includes a workflow that publishes the `viewer/` folder as the site root.

1. Push to `main` (or `master`).
2. In the repo Settings → Pages, set Source to “GitHub Actions”.
3. The workflow at `.github/workflows/deploy-pages.yml` will deploy.

- Project Pages URL: `https://<user>.github.io/<repo>/`
- User/Org Pages URL (special repo `<user>.github.io`): `https://<user>.github.io/`

The code uses only relative URLs (e.g., `./data/...`) and resolves worker paths relative to their module with `new URL('../workers/marching_worker.js', import.meta.url)` so it works when hosted under a subpath like `/your-repo/`.

## Notes and tips

- Cache busting: fetches append `?v=Date.now()` to avoid stale assets after a new deploy.
- three.js import map is from a CDN; ensure the page is served over HTTPS. GitHub Pages is HTTPS by default.
- For runtime isosurfaces, place `viewer/data/volume/volume.bin` and `volume.json` (downsampled). Runtime Marching Tetrahedra runs in a web worker.
- Volume raymarching (WebGL2): enable in GUI → Volume. Adjust opacity/steps/window; try Volume LOD (Full/Half/Quarter).
- If you change folder names or data paths, update constants at the top of `viewer/viewer.js`.

### Preparing a downsampled volume for the web

Pick a target size (MiB) based on your hosting and user bandwidth. For GitHub Pages and smooth in-browser use, 30–60 MiB is a good starting point.

Example (Windows PowerShell):

```powershell
py -3 scripts/preprocess_volume.py --input viewer/data/soln_2048x2048x128-001.vtk `
	--out-dir viewer/data/volume --mode volume --target-mib 50
```

This computes an X,Y,Z dimension triple that fits under ~50 MiB (uint8), rounds to friendly multiples (8), downsamples, and writes `volume.bin` and `volume.json` with stride-adjusted spacing.

### Cleanup

The project no longer uses precomputed isosurfaces. Remove any `viewer/data/isos/**` folders if present.

You can still force exact Z Y X with `--target-shape Z Y X` if you prefer.
