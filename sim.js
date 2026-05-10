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
  const SIM_VERSION = 'sim-14';

  function HeightField(n, opts) {
    opts = opts || {};
    this.n = n;
    this.boxSize       = opts.boxSize       != null ? opts.boxSize       : 2.0;
    this.waveC         = opts.waveC         != null ? opts.waveC         : 0.9;
    this.velDamping    = opts.velDamping    != null ? opts.velDamping    : 2.4;
    this.ampDamping    = opts.ampDamping    != null ? opts.ampDamping    : 0.9999;
    this.tiltStiffness = opts.tiltStiffness != null ? opts.tiltStiffness : 10.0;
    this.minVerticalG  = opts.minVerticalG  != null ? opts.minVerticalG  : 3.0;
    this.maxEqAmp      = opts.maxEqAmp      != null ? opts.maxEqAmp      : 0.45;
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

  return { HeightField: HeightField, SIM_VERSION: SIM_VERSION };
}));
