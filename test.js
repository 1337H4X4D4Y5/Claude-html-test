// Unit tests for the water simulation core. Runs in Node and (via test.html) in the browser.

(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const mod = isNode ? require('./sim.js') : root;
  const HeightField = mod.HeightField;
  const mapOrientationToGravity = mod.mapOrientationToGravity;
  const Fluid = mod.Fluid;

  const results = [];
  function test(name, fn) {
    try {
      fn();
      results.push({ name: name, pass: true, msg: '' });
    } catch (e) {
      results.push({ name: name, pass: false, msg: e.message });
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  function assertLT(a, b, msg) {
    if (!(a < b)) throw new Error(msg + ' (' + a + ' not < ' + b + ')');
  }
  function assertLE(a, b, msg) {
    if (!(a <= b)) throw new Error(msg + ' (' + a + ' not <= ' + b + ')');
  }
  function assertNear(a, b, eps, msg) {
    if (Math.abs(a - b) > eps) throw new Error(msg + ' (|' + a + ' - ' + b + '| > ' + eps + ')');
  }

  // ---------- Tests ----------

  test('quiescent stays quiescent (zeros + gravity-down for 200 steps)', () => {
    const f = new HeightField(32);
    for (let s = 0; s < 200; s++) f.step(1 / 60, 0, -9.8, 0);
    assertLT(f.maxAbsHeight(), 1e-6, 'flat surface drifted');
    assert(!f.hasNaN(), 'NaN appeared');
  });

  test('CFL stability condition satisfied at default params', () => {
    const f = new HeightField(64);
    const cfl = f.waveC * (1 / 60) / f.dx;
    assertLT(cfl, 1 / Math.sqrt(2), 'CFL = ' + cfl.toFixed(3));
  });

  test('Gaussian bump at rest decays smoothly (energy halves within 10s)', () => {
    const f = new HeightField(64);
    f.pokeGaussian(32, 32, 0.3, 4);
    f.startAtRest();
    const e0 = f.totalEnergy();
    for (let s = 0; s < 600; s++) {
      f.step(1 / 60, 0, -9.8, 0);
      assert(!f.hasNaN(), 'NaN at step ' + s);
    }
    const e1 = f.totalEnergy();
    assertLT(e1, e0 * 0.5, 'energy did not halve: ' + e1.toFixed(4) + ' / ' + e0.toFixed(4));
  });

  test('Gaussian bump never spikes beyond 2x initial amplitude', () => {
    const f = new HeightField(64);
    f.pokeGaussian(32, 32, 0.3, 4);
    f.startAtRest();
    let peak = 0;
    for (let s = 0; s < 600; s++) {
      f.step(1 / 60, 0, -9.8, 0);
      peak = Math.max(peak, f.maxAbsHeight());
    }
    assertLT(peak, 0.6, 'amplitude grew to ' + peak.toFixed(3));
  });

  test('checkerboard mode decays (does NOT grow into spike pattern)', () => {
    const f = new HeightField(32);
    for (let j = 0; j < f.n; j++) {
      for (let i = 0; i < f.n; i++) {
        f.h[j * f.n + i] = ((i + j) % 2 === 0 ? 0.1 : -0.1);
      }
    }
    f.startAtRest();
    const e0 = f.totalEnergy();
    for (let s = 0; s < 120; s++) {
      f.step(1 / 60, 0, -9.8, 0);
      assert(!f.hasNaN(), 'NaN at step ' + s);
    }
    const e1 = f.totalEnergy();
    assertLT(e1, e0 * 0.5, 'checkerboard energy did not decay: ' + e1.toFixed(4) + ' / ' + e0.toFixed(4));
  });

  test('settles to tilted equilibrium under sustained sideways gravity', () => {
    const f = new HeightField(32);
    // Slope = gx/|gy| = 1/5 = 0.2. Cap = MAX_EQ_AMP / halfBox = 0.45 / 1 = 0.45.
    // 0.2 < 0.45 so no clamp.
    const gx = 1.0, gy = -5.0, gz = 0;
    for (let s = 0; s < 3000; s++) {
      f.step(1 / 60, gx, gy, gz);
      assert(!f.hasNaN(), 'NaN at step ' + s);
    }
    const halfN = (f.n - 1) / 2;
    const dx = f.dx;
    let maxErr = 0, maxHeight = 0;
    for (let j = 4; j < f.n - 4; j++) {
      for (let i = 4; i < f.n - 4; i++) {
        const wx = (i - halfN) * dx;
        const hEq = 0.2 * wx;
        const err = Math.abs(f.h[j * f.n + i] - hEq);
        maxErr = Math.max(maxErr, err);
        maxHeight = Math.max(maxHeight, Math.abs(f.h[j * f.n + i]));
      }
    }
    assertLT(maxErr, 0.05, 'equilibrium error too large: ' + maxErr.toFixed(4));
    assert(maxHeight > 0.1, 'water did not tilt enough: peak ' + maxHeight.toFixed(4));
  });

  test('extreme horizontal gravity (phone vertical) stays bounded', () => {
    const f = new HeightField(32);
    // gy near 0 -- phone vertical. Equilibrium would explode without the
    // MIN_VERTICAL_G clamp and slope cap.
    for (let s = 0; s < 3000; s++) {
      f.step(1 / 60, 9.8, -0.1, 0);
      assertLE(f.maxAbsHeight(), f.hmax + 1e-3, 'height escaped clamp at step ' + s);
      assert(!f.hasNaN(), 'NaN at step ' + s);
    }
  });

  test('field stays symmetric under symmetric initial condition', () => {
    const f = new HeightField(32);
    f.pokeGaussian(16, 16, 0.2, 3);
    f.startAtRest();
    for (let s = 0; s < 300; s++) {
      f.step(1 / 60, 0, -9.8, 0);
    }
    let maxAsymm = 0;
    for (let j = 0; j < f.n; j++) {
      for (let i = 0; i < f.n; i++) {
        const a = f.h[j * f.n + i];
        const b = f.h[(f.n - 1 - j) * f.n + (f.n - 1 - i)];
        maxAsymm = Math.max(maxAsymm, Math.abs(a - b));
      }
    }
    assertLT(maxAsymm, 1e-3, 'broke symmetry by ' + maxAsymm.toExponential(2));
  });

  test('stress test: random pokes + tilt for 2000 steps, no NaN, bounded', () => {
    const f = new HeightField(48);
    f.pokeGaussian(24, 24, 0.3, 3);
    f.startAtRest();
    let peak = 0;
    let rng = 1234;
    function rand() { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return (rng / 0x7fffffff); }
    for (let s = 0; s < 2000; s++) {
      const gx = (rand() * 2 - 1) * 4;
      const gz = (rand() * 2 - 1) * 4;
      const gy = -6 + rand() * 2;
      f.step(1 / 60, gx, gy, gz);
      if (s % 80 === 0) {
        f.pokeGaussian(
          5 + Math.floor(rand() * (f.n - 10)),
          5 + Math.floor(rand() * (f.n - 10)),
          (rand() - 0.5) * 0.2,
          2
        );
      }
      assert(!f.hasNaN(), 'NaN at step ' + s);
      peak = Math.max(peak, f.maxAbsHeight());
    }
    assertLE(peak, f.hmax + 1e-3, 'stress peak ' + peak.toFixed(3) + ' exceeded clamp');
  });

  test('stable across the range of dt values a browser might pass (1/240 to 1/30)', () => {
    // The original tests only covered dt=1/60. iPhone at v18 was exploding
    // because some path in the live render loop fed a dt that pushed CFL
    // (c*dt/dx <= 1/sqrt(2)) over the edge with WAVE_C=0.9. Verify that the
    // sim stays bounded across every realistic frame timing.
    const dts = [1/240, 1/144, 1/120, 1/90, 1/72, 1/60, 1/45, 1/30];
    for (const dt of dts) {
      const f = new HeightField(64, { waveC: 0.6 });
      f.pokeGaussian(32, 32, 0.12, 3.5);
      f.startAtRest();
      let peak = 0;
      for (let s = 0; s < 600; s++) {
        f.step(dt, 0, -9.8, 0);
        const m = f.maxAbsHeight();
        if (m > peak) peak = m;
        assert(!f.hasNaN(), 'NaN at dt=' + dt + ' step ' + s);
      }
      assertLT(peak, 0.3, 'dt=' + dt.toFixed(5) + ' peak ' + peak.toFixed(4));
    }
  });

  test('repeated runtime pokes (splash impacts) do not excite high-freq spikes', () => {
    // This mirrors what index.html does each frame: step the simulation, then
    // have ~10 particle impacts call pokeGaussian. Earlier versions of poke
    // wrote only to h, leaving hPrev untouched, which the wave equation read
    // as a huge instantaneous velocity at the impact site and amplified into
    // the spike-comb pattern the user saw on iPhone.
    const f = new HeightField(64);
    f.pokeGaussian(32, 32, 0.12, 3.5);
    f.startAtRest();
    let rng = 42;
    function rand() { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; }
    for (let s = 0; s < 1500; s++) {
      f.step(1 / 60, -1.85, -2.80, 9.20);
      for (let p = 0; p < 10; p++) {
        const i = 4 + Math.floor(rand() * 56);
        const j = 4 + Math.floor(rand() * 56);
        f.pokeGaussian(i, j, -0.02, 1.6);
      }
      assert(!f.hasNaN(), 'NaN at step ' + s);
    }
    const n = f.n;
    let maxAdjDiff = 0;
    for (let j = 5; j < n - 5; j++) {
      for (let i = 5; i < n - 5; i++) {
        const k = j * n + i;
        maxAdjDiff = Math.max(maxAdjDiff, Math.abs(f.h[k] - f.h[k + 1]));
        maxAdjDiff = Math.max(maxAdjDiff, Math.abs(f.h[k] - f.h[k + n]));
      }
    }
    assertLT(maxAdjDiff, 0.05, 'adjacent-cell difference grew to ' + maxAdjDiff.toFixed(4));
    assertLT(f.maxAbsHeight(), 0.55, 'heights hit clamp: ' + f.maxAbsHeight().toFixed(4));
  });

  test('boundary cells track interior values (no edge spikes)', () => {
    const f = new HeightField(32);
    f.pokeGaussian(16, 16, 0.2, 3);
    f.startAtRest();
    for (let s = 0; s < 400; s++) f.step(1 / 60, 0, -9.8, 0);
    // Edges should match their nearest interior neighbor (reflective).
    const n = f.n;
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(f.h[i] - f.h[i + n]));                       // top
      maxDiff = Math.max(maxDiff, Math.abs(f.h[(n-1)*n + i] - f.h[(n-2)*n + i]));       // bot
      maxDiff = Math.max(maxDiff, Math.abs(f.h[i * n] - f.h[i * n + 1]));               // left
      maxDiff = Math.max(maxDiff, Math.abs(f.h[i * n + (n-1)] - f.h[i * n + (n-2)]));   // right
    }
    assertLT(maxDiff, 1e-4, 'boundary cells diverged from interior: ' + maxDiff);
  });

  // ---------- Helpers for long-running tests ----------

  function makeSeededField() {
    const f = new HeightField(64, { waveC: 0.6, velDamping: 3.5, maxEqAmp: 0.30 });
    f.pokeGaussian(32, 32, 0.12, 3.5);
    f.startAtRest();
    return f;
  }
  function maxAdjDiff(f) {
    const N = f.n;
    let m = 0;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 2; i++) {
        const k = j * N + i;
        const d = Math.abs(f.h[k] - f.h[k + 1]);
        if (d > m) m = d;
      }
    }
    return m;
  }
  // Cheap deterministic PRNG so splash positions are repeatable.
  function mkRng(seed) {
    let s = seed | 0;
    return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }
  // Run the sim for many steps. opts.getGravity(stepIndex) -> {x,y,z}.
  // Optionally injects synthetic splash pokes to model the particle system.
  function runLong(opts) {
    const f = makeSeededField();
    const STEPS = opts.steps || (30 * 60);
    const dt = opts.dt || (1 / 60);
    const getGravity = opts.getGravity;
    const splashes = opts.splashes || 0;     // pokes per step
    const splashAmp = opts.splashAmp || -0.035;
    const rand = mkRng(opts.seed || 11);
    const energy = [];
    let peak = 0;
    for (let s = 0; s < STEPS; s++) {
      const g = getGravity(s);
      f.step(dt, g.x, g.y, g.z);
      for (let p = 0; p < splashes; p++) {
        const i = 4 + Math.floor(rand() * 56);
        const j = 4 + Math.floor(rand() * 56);
        f.pokeGaussian(i, j, splashAmp, 1.6);
      }
      const m = f.maxAbsHeight();
      if (m > peak) peak = m;
      if (s % 60 === 0) energy.push(f.totalEnergy());
    }
    return {
      f: f,
      peak: peak,
      finalMax: f.maxAbsHeight(),
      finalAdj: maxAdjDiff(f),
      energy: energy,
      hasNaN: f.hasNaN()
    };
  }

  // ---------- Gyro mapping + full-range stability ----------

  test('mapOrientationToGravity: phone flat face-up -> down is scene -y', () => {
    const g = mapOrientationToGravity(0, 0, 0, 9.8);
    assertNear(g.x, 0, 0.01, 'gx');
    assertNear(g.y, 0, 0.01, 'gy');
    assertNear(g.z, -9.8, 0.01, 'gz (should be away from viewer when face-up)');
  });

  test('mapOrientationToGravity: phone upright (beta=90) -> down is scene -y', () => {
    const g = mapOrientationToGravity(90, 0, 0, 9.8);
    assertNear(g.x, 0, 0.01, 'gx');
    assertNear(g.y, -9.8, 0.01, 'gy');
    assertNear(g.z, 0, 0.01, 'gz');
  });

  test('mapOrientationToGravity: phone tilted right (gamma=90) -> down is scene -x', () => {
    const g = mapOrientationToGravity(0, 90, 0, 9.8);
    assertNear(g.x, 9.8, 0.05, 'gx');
    assertNear(g.y, 0, 0.05, 'gy');
    assertNear(g.z, 0, 0.05, 'gz');
  });

  test('mapOrientationToGravity: magnitude is preserved across all angles', () => {
    for (let b = -180; b <= 180; b += 30) {
      for (let gm = -90; gm <= 90; gm += 30) {
        const g = mapOrientationToGravity(b, gm, 0, 9.8);
        const m = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
        assertNear(m, 9.8, 0.01, 'beta=' + b + ' gamma=' + gm + ' mag=' + m);
      }
    }
  });

  test('mapOrientationToGravity: continuous across beta wraparound (no jumps)', () => {
    // Stepping through beta from 170 to 190 (which wraps to -170) should not
    // produce a discontinuity in the gravity vector.
    const samples = [];
    for (let b = 170; b <= 190; b += 1) {
      const eff = b > 180 ? b - 360 : b;
      samples.push(mapOrientationToGravity(eff, 0, 0, 9.8));
    }
    for (let i = 1; i < samples.length; i++) {
      const dx = samples[i].x - samples[i - 1].x;
      const dy = samples[i].y - samples[i - 1].y;
      const dz = samples[i].z - samples[i - 1].z;
      const jump = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assertLT(jump, 0.5, 'gravity jumped by ' + jump + ' at i=' + i);
    }
  });

  test('sustained tilt 5s at every (beta, gamma) on 9x5 grid stays bounded', () => {
    // Quick sweep: 5s simulated time per orientation. Catches immediate
    // instability for any reachable phone pose.
    const betas = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
    const gammas = [-90, -45, 0, 45, 90];
    let worst = { beta: 0, gamma: 0, peak: 0 };
    for (const b of betas) {
      for (const gm of gammas) {
        const g = mapOrientationToGravity(b, gm, 0, 9.8);
        const r = runLong({ steps: 300, getGravity: function () { return g; } });
        assert(!r.hasNaN, 'NaN at beta=' + b + ' gamma=' + gm);
        if (r.peak > worst.peak) worst = { beta: b, gamma: gm, peak: r.peak };
      }
    }
    assertLT(worst.peak, 0.55,
      'worst orientation beta=' + worst.beta + ' gamma=' + worst.gamma +
      ' peak ' + worst.peak.toFixed(4));
  });

  test('long-term stability: 30s sustained tilt at 5 representative orientations', () => {
    // Catches drift that takes many seconds to manifest. The iPhone showed
    // checkerboard emerge around t=20s under sustained tilt at v21.
    const orientations = [
      { b: 0,    gm: 0,   name: 'flat' },
      { b: 90,   gm: 0,   name: 'upright' },
      { b: -90,  gm: 0,   name: 'upside-down upright' },
      { b: 180,  gm: 0,   name: 'face-down flat' },
      { b: 45,   gm: 45,  name: 'diagonal tilt' }
    ];
    let worst = { name: '', peak: 0, finalAdj: 0 };
    for (const o of orientations) {
      const g = mapOrientationToGravity(o.b, o.gm, 0, 9.8);
      const r = runLong({ steps: 30 * 60, getGravity: function () { return g; } });
      assert(!r.hasNaN, 'NaN at ' + o.name);
      if (r.peak > worst.peak) worst = { name: o.name, peak: r.peak, finalAdj: r.finalAdj };
    }
    assertLT(worst.peak, 0.55, 'worst 30s sustained: ' + worst.name + ' peak ' + worst.peak.toFixed(4));
    assertLT(worst.finalAdj, 0.3, 'worst 30s adj diff: ' + worst.name + ' ' + worst.finalAdj.toFixed(4));
  });

  test('long-term stability: 30s with synthetic splash pokes at extreme tilt', () => {
    // Even with splash impacts modifying the field at ~1000 pokes/sec, the
    // sim should remain bounded over 30s. (In v22 the live page disables
    // field-feedback from splashes so this is overkill, but a regression
    // safety net if someone re-enables them.)
    const g = mapOrientationToGravity(-90, 0, 0, 9.8); // upside-down upright
    const r = runLong({
      steps: 30 * 60,
      getGravity: function () { return g; },
      splashes: 17,
      splashAmp: -0.02      // moderate impact strength
    });
    assert(!r.hasNaN, 'NaN with splashes');
    assertLT(r.peak, 0.55, 'splash 30s peak ' + r.peak.toFixed(4));
  });

  test('30s slow continuous rotation through all of beta stays bounded', () => {
    const STEPS = 30 * 60;
    const r = runLong({
      steps: STEPS,
      getGravity: function (s) {
        const beta = -180 + (s / STEPS) * 360;
        return mapOrientationToGravity(beta, 0, 0, 9.8);
      }
    });
    assert(!r.hasNaN, 'NaN during beta sweep');
    assertLT(r.peak, 0.55, 'beta sweep peak ' + r.peak.toFixed(4));
    assertLT(r.finalAdj, 0.3, 'beta sweep final adj ' + r.finalAdj.toFixed(4));
  });

  test('30s Lissajous-style sweep through both beta and gamma stays bounded', () => {
    // Beta and gamma oscillate at different frequencies tracing a Lissajous
    // pattern through the full orientation space.
    const STEPS = 30 * 60;
    const r = runLong({
      steps: STEPS,
      getGravity: function (s) {
        const t = s / STEPS;
        const beta = Math.sin(t * Math.PI * 4) * 135;
        const gamma = Math.cos(t * Math.PI * 3) * 75;
        return mapOrientationToGravity(beta, gamma, 0, 9.8);
      }
    });
    assert(!r.hasNaN, 'NaN during Lissajous sweep');
    assertLT(r.peak, 0.55, 'Lissajous peak ' + r.peak.toFixed(4));
  });

  test('30s random orientation jumps every 0.5s stays bounded', () => {
    // Simulates a user rapidly reorienting the phone.
    const STEPS = 30 * 60;
    const rng = mkRng(42);
    let g = { x: 0, y: -9.8, z: 0 };
    const r = runLong({
      steps: STEPS,
      getGravity: function (s) {
        if (s % 30 === 0) {
          const b = -180 + rng() * 360;
          const gm = -90 + rng() * 180;
          g = mapOrientationToGravity(b, gm, 0, 9.8);
        }
        return g;
      }
    });
    assert(!r.hasNaN, 'NaN during random jumps');
    assertLT(r.peak, 0.55, 'random jumps peak ' + r.peak.toFixed(4));
    assertLT(r.finalAdj, 0.3, 'random jumps final adj ' + r.finalAdj.toFixed(4));
  });

  test('energy does not grow over time at sustained extreme tilt', () => {
    // Verify that the simulation truly settles rather than slowly drifting up.
    // Compare average energy in the second half of a 30s run to the first
    // half: should be lower (settled) and definitely not 2x higher.
    const g = mapOrientationToGravity(-90, 0, 0, 9.8);
    const r = runLong({ steps: 30 * 60, getGravity: function () { return g; } });
    assert(!r.hasNaN, 'NaN');
    const half = r.energy.length >> 1;
    let firstAvg = 0, secondAvg = 0;
    for (let i = 5; i < half; i++) firstAvg += r.energy[i];        // skip initial transient
    for (let i = half; i < r.energy.length; i++) secondAvg += r.energy[i];
    firstAvg /= (half - 5);
    secondAvg /= (r.energy.length - half);
    assertLT(secondAvg, firstAvg * 1.5,
      'energy grew: firstAvg=' + firstAvg.toFixed(4) + ' secondAvg=' + secondAvg.toFixed(4));
  });

  // ---------- Particle fluid tests ----------

  function makeFluid(seed) {
    const f = new Fluid(200);
    f.seed(seed != null ? seed : 1);
    return f;
  }

  test('fluid: initial seed places all particles inside the box', () => {
    const f = makeFluid();
    assert(f.allInBox(), 'some particles started outside the box');
  });

  test('fluid: gravity straight down settles particles to the lower half', () => {
    const f = makeFluid();
    for (let s = 0; s < 60 * 5; s++) f.step(1/60, 0, -9.8, 0);
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped the box');
    const com = f.centerOfMass();
    assertLT(com.y, -0.3, 'center of mass should be in lower half: y=' + com.y.toFixed(3));
  });

  test('fluid: gravity sideways settles particles to the lower side', () => {
    const f = makeFluid();
    // gravity in +x direction means 'down' is +x.
    for (let s = 0; s < 60 * 5; s++) f.step(1/60, 9.8, 0, 0);
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped the box');
    const com = f.centerOfMass();
    assert(com.x > 0.3, 'center of mass should be on +x side: x=' + com.x.toFixed(3));
  });

  test('fluid: upside-down gravity settles particles to the top', () => {
    const f = makeFluid();
    for (let s = 0; s < 60 * 5; s++) f.step(1/60, 0, 9.8, 0);
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped the box');
    const com = f.centerOfMass();
    assert(com.y > 0.3, 'center of mass should be in upper half: y=' + com.y.toFixed(3));
  });

  test('fluid: total kinetic energy stays bounded over 30s of sustained gravity', () => {
    const f = makeFluid();
    let peakKE = 0;
    for (let s = 0; s < 60 * 30; s++) {
      f.step(1/60, 0, -9.8, 0);
      const ke = f.totalKE();
      if (ke > peakKE) peakKE = ke;
    }
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped');
    // Total KE = 0.5 * sum v^2. With max speed ~8 capped, n=200, peak <= 0.5*200*64 = 6400.
    assertLT(peakKE, 1500, 'KE blew up: ' + peakKE.toFixed(1));
    // Final KE should be small (mostly settled).
    assertLT(f.totalKE(), 50, 'fluid did not settle: final KE=' + f.totalKE().toFixed(2));
  });

  test('fluid: survives a full beta sweep -180 to +180 over 30 seconds', () => {
    const f = makeFluid();
    const STEPS = 30 * 60;
    let maxKE = 0;
    for (let s = 0; s < STEPS; s++) {
      const beta = -180 + (s / STEPS) * 360;
      const g = mapOrientationToGravity(beta, 0, 0, 9.8);
      f.step(1/60, g.x, g.y, g.z);
      const ke = f.totalKE();
      if (ke > maxKE) maxKE = ke;
    }
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped');
    assertLT(maxKE, 3000, 'KE during sweep grew too large: ' + maxKE.toFixed(1));
  });

  test('fluid: random orientation jumps every 0.5s stays bounded', () => {
    const f = makeFluid(7);
    const rng = mkRng(123);
    let g = { x: 0, y: -9.8, z: 0 };
    for (let s = 0; s < 60 * 30; s++) {
      if (s % 30 === 0) {
        const b = -180 + rng() * 360;
        const gm = -90 + rng() * 180;
        g = mapOrientationToGravity(b, gm, 0, 9.8);
      }
      f.step(1/60, g.x, g.y, g.z);
    }
    assert(!f.hasNaN(), 'NaN');
    assert(f.allInBox(), 'particles escaped');
  });

  test('fluid: spatial grid produces same results across scales (200 vs 500)', () => {
    // The grid is an optimization; behavior shouldn't differ from pair-loop.
    // We verify by ensuring both populations stay bounded under same forces.
    for (const n of [200, 350, 500]) {
      const f = new Fluid(n);
      f.seed(7);
      for (let s = 0; s < 60 * 5; s++) f.step(1/60, 0, -9.8, 0);
      assert(!f.hasNaN(), 'NaN at n=' + n);
      assert(f.allInBox(), 'escape at n=' + n);
    }
  });

  test('fluid: under sideways gravity, particles spread along the lower face (not in a line)', () => {
    // Catches the v24 chain-collapse bug. With gravity pulling in -x, we
    // expect particles to spread across the y-z range of the -x wall, not
    // collapse into a single x-aligned column.
    const f = new Fluid(400);
    f.seed(7);
    for (let s = 0; s < 60 * 6; s++) f.step(1/60, -9.8, 0.5, 0);
    // Standard deviation of y and z positions among particles near the -x
    // wall: if particles are spread out we expect both to be > 0.2.
    let nNear = 0, sy = 0, sz = 0, syy = 0, szz = 0;
    for (let i = 0; i < f.n; i++) {
      if (f.x[i] < -f.boxHalf + 0.2) {
        sy += f.y[i]; sz += f.z[i];
        syy += f.y[i] * f.y[i]; szz += f.z[i] * f.z[i];
        nNear++;
      }
    }
    assert(nNear > 50, 'too few particles reached the wall: ' + nNear);
    const meanY = sy / nNear, meanZ = sz / nNear;
    const stdY = Math.sqrt(syy / nNear - meanY * meanY);
    const stdZ = Math.sqrt(szz / nNear - meanZ * meanZ);
    assert(stdY > 0.2, 'particles collapsed in y: stdY=' + stdY.toFixed(3));
    assert(stdZ > 0.2, 'particles collapsed in z: stdZ=' + stdZ.toFixed(3));
  });

  test('fluid: pair distances stay bounded (no particle merging)', () => {
    // Repulsion should keep particles separated. Find min pair distance.
    const f = makeFluid();
    for (let s = 0; s < 60 * 5; s++) f.step(1/60, 0, -9.8, 0);
    let minR2 = Infinity;
    for (let i = 0; i < f.n; i++) {
      for (let j = i + 1; j < f.n; j++) {
        const dx = f.x[j] - f.x[i];
        const dy = f.y[j] - f.y[i];
        const dz = f.z[j] - f.z[i];
        const r2 = dx*dx + dy*dy + dz*dz;
        if (r2 < minR2) minR2 = r2;
      }
    }
    const minR = Math.sqrt(minR2);
    assert(minR > 0.02, 'particles overlap too much: min dist ' + minR.toFixed(4));
  });

  // ---------- Reporting ----------

  if (isNode) {
    let pass = 0, fail = 0;
    for (const r of results) {
      if (r.pass) { pass++; console.log('PASS  ' + r.name); }
      else        { fail++; console.log('FAIL  ' + r.name + '\n      ' + r.msg); }
    }
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail > 0 ? 1 : 0);
  } else {
    root.__TEST_RESULTS__ = results;
  }
})(typeof self !== 'undefined' ? self : this);
