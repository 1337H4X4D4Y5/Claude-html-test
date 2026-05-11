// Height-field water simulation core. Pure JS, runs in browser and Node.
// Exposes HeightField on `window` (browser) or `module.exports` (Node).

(function (root, factory) {
  const exp = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = exp;
  } else {
    Object.assign(root, exp);
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Bump on every change so the loaded build is verifiable.
  const SIM_VERSION = 'sim-26';

  // Map DeviceOrientationEvent (beta, gamma in degrees) plus screen rotation
  // angle (degrees) to a scene-frame gravity vector. Output magnitude equals
  // |gravityMag|. Pure function — testable in isolation.
  //
  // Coordinate convention used in the scene:
  //   +x = right of screen, +y = up, +z = out of screen toward viewer.
  // Phone-frame gravity is derived from the standard tilted-device model:
  //   gx_device =  cos(beta) * sin(gamma)
  //   gy_device = -sin(beta)
  //   gz_device = -cos(beta) * cos(gamma)
  // Then mapped to scene axes (device y is screen-up; we want scene +y up)
  // and rotated by -screenAngle to compensate for portrait/landscape.
  function mapOrientationToGravity(beta, gamma, screenAngle, gravityMag) {
    const DEG = Math.PI / 180;
    const b = (beta || 0) * DEG;
    const g = (gamma || 0) * DEG;
    const cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(g), sg = Math.sin(g);
    // Gravity in device frame.
    const gxDev =  cb * sg;
    const gyDev = -sb;
    const gzDev = -cb * cg;
    // Map device frame (x=right, y=top, z=out-of-screen) to scene frame
    // (x=right, y=up, z=out-of-screen). Device y matches scene y, device z
    // matches scene z, device x matches scene x.
    let sx = gxDev, sy = gyDev, sz = gzDev;
    // Rotate around scene Z by -screenAngle to undo screen rotation.
    const o = (screenAngle || 0) * DEG;
    const co = Math.cos(o), so = Math.sin(o);
    const rx =  co * sx + so * sy;
    const ry = -so * sx + co * sy;
    const rz = sz;
    // Normalize and scale to requested magnitude. Guard near zero.
    const mag = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const mag2 = mag < 1e-6 ? 1 : mag;
    const s = (gravityMag != null ? gravityMag : 9.8) / mag2;
    return { x: rx * s, y: ry * s, z: rz * s };
  }

  function HeightField(n, opts) {
    opts = opts || {};
    this.n = n;
    this.boxSize       = opts.boxSize       != null ? opts.boxSize       : 2.0;
    this.waveC         = opts.waveC         != null ? opts.waveC         : 0.6;
    this.velDamping    = opts.velDamping    != null ? opts.velDamping    : 3.5;
    this.ampDamping    = opts.ampDamping    != null ? opts.ampDamping    : 0.9999;
    this.tiltStiffness = opts.tiltStiffness != null ? opts.tiltStiffness : 10.0;
    this.minVerticalG  = opts.minVerticalG  != null ? opts.minVerticalG  : 3.0;
    this.maxEqAmp      = opts.maxEqAmp      != null ? opts.maxEqAmp      : 0.30;
    this.hmax          = opts.hmax          != null ? opts.hmax          : 0.6;
    this.h     = new Float32Array(n * n);
    this.hPrev = new Float32Array(n * n);
    this.vel   = new Float32Array(n * n);
    this.dx = this.boxSize / (n - 1);
  }

  HeightField.prototype.idx = function (i, j) { return j * this.n + i; };

  HeightField.prototype.poke = function (i, j, amount) {
    if (i < 1 || i >= this.n - 1 || j < 1 || j >= this.n - 1) return;
    this.h[this.idx(i, j)] += amount;
  };

  HeightField.prototype.pokeGaussian = function (ci, cj, amp, sigma) {
    // Apply the delta to BOTH h and hPrev. This shifts the surface position
    // without injecting velocity: the wave equation reads velocity from
    // (h - hPrev)/dt, so writing only to h would create a phantom velocity
    // spike at the poke site every step, which excites the Nyquist mode and
    // produces the comb-of-spikes pattern. With both buffers updated, the
    // poke is a clean position offset that ripples outward smoothly.
    const r = Math.ceil(sigma * 3);
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 1 || i >= this.n - 1 || j < 1 || j >= this.n - 1) continue;
        const w = Math.exp(-(di * di + dj * dj) * inv2s2);
        const delta = amp * w;
        const k = this.idx(i, j);
        this.h[k] += delta;
        this.hPrev[k] += delta;
      }
    }
  };

  // Initialize hPrev = h so a seeded surface starts at rest, not with huge
  // implied velocity (h - hPrev)/dt.
  HeightField.prototype.startAtRest = function () {
    this.hPrev.set(this.h);
  };

  HeightField.prototype.step = function (dt, gx, gy, gz) {
    const n = this.n;
    const h = this.h;
    const hpRef = this.hPrev;
    const vel = this.vel;

    const c2dt2 = this.waveC * this.waveC * dt * dt / (this.dx * this.dx);
    const dt2 = dt * dt;
    const gammaDt = this.velDamping * dt;
    const aCoef = 2 - gammaDt;
    const bCoef = 1 - gammaDt;

    // Tilted equilibrium plane: surface perpendicular to gravity.
    const gyEff = Math.max(Math.abs(gy), this.minVerticalG);
    let slopeX = gx / gyEff;
    let slopeZ = gz / gyEff;
    const maxSlope = this.maxEqAmp / (this.boxSize * 0.5);
    const slopeMag = Math.sqrt(slopeX * slopeX + slopeZ * slopeZ);
    if (slopeMag > maxSlope) {
      const s = maxSlope / slopeMag;
      slopeX *= s;
      slopeZ *= s;
    }

    // Write new heights into a fresh buffer. Using a separate scratch buffer
    // (instead of aliasing hPrev) is critical because the reflective boundary
    // copy needs to read freshly-updated interior cells, not 2-frame-stale ones.
    if (!this._scratch || this._scratch.length !== h.length) {
      this._scratch = new Float32Array(h.length);
    }
    const hNew = this._scratch;

    const halfN = (n - 1) * 0.5;
    const dx = this.dx;
    const k_stiff = this.tiltStiffness;
    const amp = this.ampDamping;

    for (let j = 1; j < n - 1; j++) {
      const wz = (j - halfN) * dx;
      for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const lap = h[k - 1] + h[k + 1] + h[k - n] + h[k + n] - 4 * h[k];
        const wx = (i - halfN) * dx;
        const hEq = slopeX * wx + slopeZ * wz;
        const restore = (hEq - h[k]) * k_stiff;
        const next = (aCoef * h[k] - bCoef * hpRef[k] + c2dt2 * lap + restore * dt2) * amp;
        hNew[k] = next;
      }
    }

    // Reflective boundary, applied in two passes so corners use freshly-set
    // edge values rather than stale ones.
    // Pass 1: top (j=0) and bottom (j=n-1) rows, interior i only.
    for (let i = 1; i < n - 1; i++) {
      hNew[i] = hNew[i + n];                                 // j=0 <- j=1
      hNew[(n - 1) * n + i] = hNew[(n - 2) * n + i];         // j=n-1 <- j=n-2
    }
    // Pass 2: left (i=0) and right (i=n-1) columns, including all four corners.
    for (let j = 0; j < n; j++) {
      hNew[j * n] = hNew[j * n + 1];                         // i=0 <- i=1
      hNew[j * n + (n - 1)] = hNew[j * n + (n - 2)];         // i=n-1 <- i=n-2
    }

    // Clamp + NaN guard.
    const hmax = this.hmax;
    for (let k = 0; k < n * n; k++) {
      let v = hNew[k];
      if (!isFinite(v)) v = 0;
      else if (v > hmax) v = hmax;
      else if (v < -hmax) v = -hmax;
      hNew[k] = v;
    }

    // Vertical velocity for splash detection.
    const invDt = 1 / dt;
    for (let k = 0; k < n * n; k++) {
      vel[k] = (hNew[k] - h[k]) * invDt;
    }

    // Rotate buffers. Old hPrev becomes the scratch slot for next step.
    this._scratch = hpRef;
    this.hPrev = h;
    this.h = hNew;
  };

  // Diagnostic helpers used by tests.
  HeightField.prototype.totalEnergy = function () {
    let e = 0;
    for (let k = 0; k < this.h.length; k++) e += this.h[k] * this.h[k];
    return e;
  };
  HeightField.prototype.maxAbsHeight = function () {
    let m = 0;
    for (let k = 0; k < this.h.length; k++) {
      const a = Math.abs(this.h[k]);
      if (a > m) m = a;
    }
    return m;
  };
  HeightField.prototype.hasNaN = function () {
    for (let k = 0; k < this.h.length; k++) {
      if (!isFinite(this.h[k])) return true;
    }
    return false;
  };

  // ---------- Particle fluid (simple SPH-style) ----------
  // Each particle has position + velocity. Forces per step:
  //   1. Gravity (acceleration in world frame)
  //   2. Short-range repulsion + viscosity from neighbors within interactRadius
  //   3. Wall collisions at +/- boxHalf with restitution
  //   4. Velocity damping each frame
  // Pure JS, no Three.js dependency — testable in isolation.
  function Fluid(n, opts) {
    opts = opts || {};
    this.n             = n;
    this.boxHalf       = opts.boxHalf       != null ? opts.boxHalf       : 0.92;
    this.interactRadius = opts.interactRadius != null ? opts.interactRadius : 0.14;
    this.pressureK     = opts.pressureK     != null ? opts.pressureK     : 60.0;
    this.viscosity     = opts.viscosity     != null ? opts.viscosity     : 0.6;
    // Position-correction strength when two particles overlap. 0 = none,
    // 1 = fully separate to interactRadius in one iteration. Use 0.5 so a
    // pair of overlapping particles converges to the right spacing over a
    // couple of frames without overshooting.
    this.posCorrection = opts.posCorrection != null ? opts.posCorrection : 0.9;
    this.posIterations = opts.posIterations != null ? opts.posIterations : 4;
    this.restitution   = opts.restitution   != null ? opts.restitution   : 0.10;
    this.velDamping    = opts.velDamping    != null ? opts.velDamping    : 0.992;
    this.maxSpeed      = opts.maxSpeed      != null ? opts.maxSpeed      : 9.0;
    this.x  = new Float32Array(n);
    this.y  = new Float32Array(n);
    this.z  = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
  }

  // Place particles randomly in a slab at the bottom of the container, with
  // small random initial velocities. Random placement (not a grid) is essential
  // so the cloud doesn't fall in formation when gravity is applied — uniform
  // grids stay aligned with gravity and collapse into chains. Small velocity
  // jitter adds enough chaos that particles spread laterally as they fall.
  Fluid.prototype.seed = function (seed) {
    let rng = (seed != null ? seed : 1) | 0;
    function rand() { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; }
    const h = this.boxHalf;
    for (let k = 0; k < this.n; k++) {
      this.x[k] = (rand() * 2 - 1) * h * 0.85;
      this.y[k] = -h + rand() * h * 0.9;   // lower 45% of the box
      this.z[k] = (rand() * 2 - 1) * h * 0.85;
      this.vx[k] = (rand() - 0.5) * 0.3;
      this.vy[k] = (rand() - 0.5) * 0.3;
      this.vz[k] = (rand() - 0.5) * 0.3;
    }
  };

  // Build a uniform spatial grid of cell size = interactRadius, with a linked
  // list of particle indices in each cell. Each particle then only needs to
  // check its own cell and the 26 neighbors -> O(n) total instead of O(n^2).
  Fluid.prototype._buildGrid = function () {
    const r = this.interactRadius;
    const span = 2 * this.boxHalf + 2 * r;          // extra padding so out-of-box
    const origin = -this.boxHalf - r;               // particles still land in a cell
    const side = Math.max(1, Math.floor(span / r));
    const cells = side * side * side;
    if (!this._grid || this._grid.length !== cells) {
      this._grid = new Int32Array(cells);
      this._next = new Int32Array(this.n);
    }
    this._gridSide = side;
    this._gridOrigin = origin;
    this._gridCell = span / side;
    const inv = 1 / this._gridCell;
    const grid = this._grid;
    const next = this._next;
    for (let c = 0; c < cells; c++) grid[c] = -1;
    const x = this.x, y = this.y, z = this.z;
    for (let i = 0; i < this.n; i++) {
      let cx = ((x[i] - origin) * inv) | 0;
      let cy = ((y[i] - origin) * inv) | 0;
      let cz = ((z[i] - origin) * inv) | 0;
      if (cx < 0) cx = 0; else if (cx >= side) cx = side - 1;
      if (cy < 0) cy = 0; else if (cy >= side) cy = side - 1;
      if (cz < 0) cz = 0; else if (cz >= side) cz = side - 1;
      const ci = cx + side * (cy + side * cz);
      next[i] = grid[ci];
      grid[ci] = i;
    }
  };

  Fluid.prototype.step = function (dt, gx, gy, gz) {
    const n = this.n;
    const radius = this.interactRadius;
    const radius2 = radius * radius;
    const boxHalf = this.boxHalf;
    const kPress = this.pressureK;
    const visc = this.viscosity;
    const posCorrect = this.posCorrection;
    const rest = this.restitution;
    const damp = this.velDamping;
    const maxSpd2 = this.maxSpeed * this.maxSpeed;
    const x = this.x, y = this.y, z = this.z;
    const vx = this.vx, vy = this.vy, vz = this.vz;

    // 1) Apply gravity.
    for (let i = 0; i < n; i++) {
      vx[i] += gx * dt;
      vy[i] += gy * dt;
      vz[i] += gz * dt;
    }

    // 2) Pairwise repulsion + viscosity via spatial grid (O(n) average).
    this._buildGrid();
    const side = this._gridSide;
    const origin = this._gridOrigin;
    const cell = this._gridCell;
    const inv = 1 / cell;
    const grid = this._grid;
    const next = this._next;
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i], zi = z[i];
      let cxi = ((xi - origin) * inv) | 0;
      let cyi = ((yi - origin) * inv) | 0;
      let czi = ((zi - origin) * inv) | 0;
      if (cxi < 0) cxi = 0; else if (cxi >= side) cxi = side - 1;
      if (cyi < 0) cyi = 0; else if (cyi >= side) cyi = side - 1;
      if (czi < 0) czi = 0; else if (czi >= side) czi = side - 1;
      const cx0 = cxi > 0 ? cxi - 1 : 0;
      const cx1 = cxi < side - 1 ? cxi + 1 : side - 1;
      const cy0 = cyi > 0 ? cyi - 1 : 0;
      const cy1 = cyi < side - 1 ? cyi + 1 : side - 1;
      const cz0 = czi > 0 ? czi - 1 : 0;
      const cz1 = czi < side - 1 ? czi + 1 : side - 1;
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            let j = grid[cx + side * (cy + side * cz)];
            while (j !== -1) {
              if (j > i) {
                const dx = x[j] - xi;
                const dy = y[j] - yi;
                const dz = z[j] - zi;
                const r2 = dx*dx + dy*dy + dz*dz;
                if (r2 < radius2 && r2 > 1e-8) {
                  const r = Math.sqrt(r2);
                  const t = (radius - r) / radius;
                  const nxn = dx / r, nyn = dy / r, nzn = dz / r;
                  // Gentle spring repulsion (provides some "spring" to the fluid).
                  const force = kPress * t * t * dt;
                  vx[i] -= nxn * force; vy[i] -= nyn * force; vz[i] -= nzn * force;
                  vx[j] += nxn * force; vy[j] += nyn * force; vz[j] += nzn * force;
                  // Viscosity: blend a fraction of velocity differences.
                  const dvx = vx[j] - vx[i];
                  const dvy = vy[j] - vy[i];
                  const dvz = vz[j] - vz[i];
                  const vf = visc * t * dt;
                  vx[i] += dvx * vf; vy[i] += dvy * vf; vz[i] += dvz * vf;
                  vx[j] -= dvx * vf; vy[j] -= dvy * vf; vz[j] -= dvz * vf;
                }
              }
              j = next[j];
            }
          }
        }
      }
    }

    // 3) Clamp speed so a one-off close encounter can't fling a particle.
    for (let i = 0; i < n; i++) {
      const sp2 = vx[i]*vx[i] + vy[i]*vy[i] + vz[i]*vz[i];
      if (sp2 > maxSpd2) {
        const s = this.maxSpeed / Math.sqrt(sp2);
        vx[i] *= s; vy[i] *= s; vz[i] *= s;
      }
    }

    // 4) Integrate position.
    for (let i = 0; i < n; i++) {
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      z[i] += vz[i] * dt;
    }

    // 5) Position projection: physically separate any pairs that overlap
    // (r < interactRadius). This is the stable Position-Based Fluids style
    // constraint — particles literally cannot occupy the same space. Without
    // this the spring oscillates indefinitely under gravity load and the pile
    // never settles. Two iterations is enough to resolve most overlaps.
    if (posCorrect > 0) {
      this._buildGrid();
      for (let iter = 0; iter < this.posIterations; iter++) {
        for (let i = 0; i < n; i++) {
          const xi = x[i], yi = y[i], zi = z[i];
          let cxi = ((xi - origin) * inv) | 0;
          let cyi = ((yi - origin) * inv) | 0;
          let czi = ((zi - origin) * inv) | 0;
          if (cxi < 0) cxi = 0; else if (cxi >= side) cxi = side - 1;
          if (cyi < 0) cyi = 0; else if (cyi >= side) cyi = side - 1;
          if (czi < 0) czi = 0; else if (czi >= side) czi = side - 1;
          const cx0 = cxi > 0 ? cxi - 1 : 0;
          const cx1 = cxi < side - 1 ? cxi + 1 : side - 1;
          const cy0 = cyi > 0 ? cyi - 1 : 0;
          const cy1 = cyi < side - 1 ? cyi + 1 : side - 1;
          const cz0 = czi > 0 ? czi - 1 : 0;
          const cz1 = czi < side - 1 ? czi + 1 : side - 1;
          for (let cz = cz0; cz <= cz1; cz++) {
            for (let cy = cy0; cy <= cy1; cy++) {
              for (let cx = cx0; cx <= cx1; cx++) {
                let j = grid[cx + side * (cy + side * cz)];
                while (j !== -1) {
                  if (j > i) {
                    const dx2 = x[j] - x[i];
                    const dy2 = y[j] - y[i];
                    const dz2 = z[j] - z[i];
                    const r22 = dx2*dx2 + dy2*dy2 + dz2*dz2;
                    if (r22 < radius2 && r22 > 1e-8) {
                      const r = Math.sqrt(r22);
                      const overlap = radius - r;
                      const half = overlap * posCorrect * 0.5;
                      const nxn = dx2 / r, nyn = dy2 / r, nzn = dz2 / r;
                      x[i] -= nxn * half; y[i] -= nyn * half; z[i] -= nzn * half;
                      x[j] += nxn * half; y[j] += nyn * half; z[j] += nzn * half;
                    }
                  }
                  j = next[j];
                }
              }
            }
          }
        }
      }
    }

    // 6) Cube wall collisions and global velocity damping.
    for (let i = 0; i < n; i++) {
      if (x[i] < -boxHalf) { x[i] = -boxHalf; vx[i] = -vx[i] * rest; }
      else if (x[i] > boxHalf) { x[i] = boxHalf; vx[i] = -vx[i] * rest; }
      if (y[i] < -boxHalf) { y[i] = -boxHalf; vy[i] = -vy[i] * rest; }
      else if (y[i] > boxHalf) { y[i] = boxHalf; vy[i] = -vy[i] * rest; }
      if (z[i] < -boxHalf) { z[i] = -boxHalf; vz[i] = -vz[i] * rest; }
      else if (z[i] > boxHalf) { z[i] = boxHalf; vz[i] = -vz[i] * rest; }
      vx[i] *= damp; vy[i] *= damp; vz[i] *= damp;
    }
  };

  Fluid.prototype.centerOfMass = function () {
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < this.n; i++) { sx += this.x[i]; sy += this.y[i]; sz += this.z[i]; }
    return { x: sx / this.n, y: sy / this.n, z: sz / this.n };
  };
  Fluid.prototype.totalKE = function () {
    let e = 0;
    for (let i = 0; i < this.n; i++) e += this.vx[i]*this.vx[i] + this.vy[i]*this.vy[i] + this.vz[i]*this.vz[i];
    return 0.5 * e;
  };
  Fluid.prototype.hasNaN = function () {
    for (let i = 0; i < this.n; i++) {
      if (!isFinite(this.x[i]) || !isFinite(this.y[i]) || !isFinite(this.z[i])) return true;
      if (!isFinite(this.vx[i]) || !isFinite(this.vy[i]) || !isFinite(this.vz[i])) return true;
    }
    return false;
  };
  // Per-axis position standard deviation. Lets tests/debug surface a pile
  // that collapsed into a sheet or line: any axis with stdDev << others means
  // the cloud is squashed in that direction.
  Fluid.prototype.spread = function () {
    const n = this.n;
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += this.x[i]; my += this.y[i]; mz += this.z[i]; }
    mx /= n; my /= n; mz /= n;
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.x[i] - mx, dy = this.y[i] - my, dz = this.z[i] - mz;
      sx += dx * dx; sy += dy * dy; sz += dz * dz;
    }
    return {
      stdX: Math.sqrt(sx / n),
      stdY: Math.sqrt(sy / n),
      stdZ: Math.sqrt(sz / n)
    };
  };

  // Variance of nearest-neighbor distances. A rigid crystalline lattice has
  // nearly-uniform NN distances (variance approaches 0). Real fluid has
  // varying NN distances.
  Fluid.prototype.nnStats = function () {
    const n = this.n;
    const nn = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = this.x[j] - this.x[i];
        const dy = this.y[j] - this.y[i];
        const dz = this.z[j] - this.z[i];
        const r2 = dx*dx + dy*dy + dz*dz;
        if (r2 < best) best = r2;
      }
      nn[i] = Math.sqrt(best);
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += nn[i];
    const mean = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = nn[i] - mean; v += d * d; }
    const std = Math.sqrt(v / n);
    return { mean: mean, std: std, cv: std / Math.max(1e-9, mean) };
  };

  Fluid.prototype.allInBox = function () {
    const eps = 1e-3;
    const h = this.boxHalf + eps;
    for (let i = 0; i < this.n; i++) {
      if (Math.abs(this.x[i]) > h || Math.abs(this.y[i]) > h || Math.abs(this.z[i]) > h) return false;
    }
    return true;
  };

  return {
    HeightField: HeightField,
    SIM_VERSION: SIM_VERSION,
    mapOrientationToGravity: mapOrientationToGravity,
    Fluid: Fluid
  };
}));
