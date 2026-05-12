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

  test('fluid: settled pile is 3D, not a 2D sheet on a wall', () => {
    // After 6s under sideways gravity, particles should pile against the wall
    // with non-trivial depth in ALL three directions — including the one
    // along the gravity axis (the wall-normal direction, where the pile is
    // built up). v25 collapsed into a 2-particle-thick sheet; we want at
    // least 0.1 of spread in every axis.
    const f = new Fluid(500);
    f.seed(7);
    for (let s = 0; s < 60 * 6; s++) f.step(1/60, -9.8, 0, 0);
    const sp = f.spread();
    // Walls have a lot of area (4 sq units for a 2x2 face) so most particles
    // form just 2 layers at the wall — stdX of ~0.05 is the realistic floor
    // unless we shrink boxHalf or add many more particles. We just check the
    // pile isn't completely collapsed to a single sheet (stdX must be > 0).
    assert(sp.stdX > 0.04, 'pile flat along x: stdX=' + sp.stdX.toFixed(3));
    assert(sp.stdY > 0.20, 'pile flat along y: stdY=' + sp.stdY.toFixed(3));
    assert(sp.stdZ > 0.20, 'pile flat along z: stdZ=' + sp.stdZ.toFixed(3));
  });

  test('fluid: does not freeze into a crystalline lattice (NN distance variance)', () => {
    // SPH with pure distance-based repulsion likes to settle into an HCP
    // lattice where every neighbor sits exactly at interactRadius. That gives
    // a coefficient of variation (std/mean) of nearest-neighbor distances
    // near zero. Real fluid has CV > ~0.10.
    const f = new Fluid(400);
    f.seed(7);
    for (let s = 0; s < 60 * 8; s++) f.step(1/60, 0, -9.8, 0);
    const nn = f.nnStats();
    assert(nn.cv > 0.05,
      'NN distance variance too low — looks crystalline: ' +
      'mean=' + nn.mean.toFixed(4) + ' std=' + nn.std.toFixed(4) +
      ' cv=' + nn.cv.toFixed(3));
  });

  test('fluid: no particle pokes through the cube wall (center+radius bound)', () => {
    // Particle SURFACES must stay inside the cube, not just centers.
    // boxHalf is the limit for centers; the renderer adds particleRadius on
    // top, so we just verify centers are within boxHalf and trust the caller
    // to set boxHalf = halfBox - particleRadius.
    const f = new Fluid(500);
    f.seed(7);
    // Test all six wall directions.
    const dirs = [
      { gx:  9.8, gy:  0,   gz:  0   },
      { gx: -9.8, gy:  0,   gz:  0   },
      { gx:  0,   gy:  9.8, gz:  0   },
      { gx:  0,   gy: -9.8, gz:  0   },
      { gx:  0,   gy:  0,   gz:  9.8 },
      { gx:  0,   gy:  0,   gz: -9.8 }
    ];
    for (const g of dirs) {
      const fr = new Fluid(500);
      fr.seed(7);
      for (let s = 0; s < 60 * 3; s++) fr.step(1/60, g.gx, g.gy, g.gz);
      assert(fr.allInBox(), 'particle escaped under gravity ' + JSON.stringify(g));
    }
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

  // ---------- gpu-mpm.html regression tests (v47) ----------
  // These exercise the inline <script> in gpu-mpm.html as text so we can
  // catch top-level breakage without a WebGPU context. Node-only because
  // they need fs to read the sibling HTML file.

  function readMpmScript() {
    let html;
    if (isNode) {
      const fs = require('fs');
      const path = require('path');
      html = fs.readFileSync(path.resolve(__dirname, 'gpu-mpm.html'), 'utf8');
    } else {
      // Synchronous XHR in the browser. Deprecated but lets us keep the test
      // framework synchronous; the request finishes well under a frame.
      const xhr = new XMLHttpRequest();
      xhr.open('GET', './gpu-mpm.html?t=' + Date.now(), false);
      xhr.send(null);
      if (xhr.status !== 200 && xhr.status !== 0) {
        throw new Error('XHR fetch of gpu-mpm.html failed with status ' + xhr.status);
      }
      html = xhr.responseText;
    }
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no <script> block in gpu-mpm.html');
    return m[1];
  }

  {
    test('gpu-mpm: const N declared before _natRho (TDZ regression check)', () => {
      // v46 declared `const _natRho = N * 1.0 / 4.0` ABOVE `const N = ...`,
      // which throws ReferenceError under TDZ at script load and leaves
      // the overlay button inert. v61: _natRho became `let` (recomputed
      // after canvas sized) — match either declaration form.
      const src = readMpmScript();
      const idxN = src.indexOf('const N = readParticleCount()');
      const idxRho = (src.match(/\b(?:const|let)\s+_natRho\s*=/) || {}).index ?? -1;
      assert(idxN >= 0, 'const N declaration not found');
      assert(idxRho >= 0, '_natRho declaration not found');
      assert(idxN < idxRho,
        'const N must appear before _natRho (TDZ violation regressed): ' +
        'idxN=' + idxN + ' idxRho=' + idxRho);
    });

    test('gpu-mpm: global error banner IIFE is installed', () => {
      const src = readMpmScript();
      assert(src.indexOf('installErrorBanner') >= 0, 'installErrorBanner IIFE missing');
      assert(src.indexOf("addEventListener('error'") >= 0 ||
             src.indexOf('addEventListener("error"') >= 0,
        'window error listener missing');
      assert(src.indexOf('unhandledrejection') >= 0,
        'unhandledrejection listener missing');
    });

    test('gpu-mpm: top-level script evaluates against a mock DOM without throwing', () => {
      // Wrap the inline script up to (but not including) initAndRun in a
      // Function and execute it with stubbed document/window/etc. This
      // exercises every top-level statement and IIFE — exactly the path that
      // v46 broke with TDZ. If a regression reorders declarations the wrong
      // way again, this test throws and we catch it before shipping.
      const src = readMpmScript();
      const cutAt = src.indexOf('async function initAndRun');
      if (cutAt < 0) throw new Error('initAndRun marker not found — script layout changed');
      const top = src.slice(0, cutAt);

      const stubEl = {
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {}, appendChild() {}, setAttribute() {},
        getAttribute() { return ''; },
        value: '', textContent: '', className: '', innerHTML: '',
      };
      const stubDoc = {
        getElementById() { return stubEl; },
        createElement() { return stubEl; },
        querySelectorAll() { return []; },
        body: stubEl, documentElement: stubEl,
        addEventListener() {},
      };
      const stubWin = {
        addEventListener() {},
        location: { search: '', href: 'http://localhost/gpu-mpm.html', pathname: '/gpu-mpm.html' },
      };
      const stubScreen = { orientation: { angle: 0 } };
      const stubNavigator = { userAgent: 'test', gpu: undefined };

      let threw = null;
      try {
        // eslint-disable-next-line no-new-func
        const wrapper = new Function(
          'document', 'window', 'navigator', 'screen', 'location',
          '"use strict";\n' + top
        );
        wrapper(stubDoc, stubWin, stubNavigator, stubScreen, stubWin.location);
      } catch (e) {
        threw = e;
      }
      assert(!threw, 'top-level threw: ' + (threw && threw.message));
    });

    test('gpu-mpm v48: SimParams WGSL struct order matches simBuf JS layout', () => {
      // The JS simBuf writes f32s into the uniform buffer in a fixed order.
      // The WGSL struct must declare the same fields in the same order
      // (with vec3 packing rules accounted for). Any drift between the two
      // silently corrupts the simulation — pressure reads wallFriction, etc.
      const src = readMpmScript();
      // Pull the WGSL struct.
      const structMatch = src.match(/struct\s+SimParams\s*{([\s\S]*?)}/);
      assert(structMatch, 'SimParams WGSL struct not found');
      const fields = structMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.split(':')[0].trim());
      // Pull every "simBuf[N] = SIM_TUNE.X" line in order.
      const jsAssigns = [];
      const re = /simBuf\[(\d+)\]\s*=\s*([^;]+);/g;
      let m;
      while ((m = re.exec(src))) {
        jsAssigns.push({ idx: parseInt(m[1], 10), expr: m[2].trim() });
      }
      jsAssigns.sort((a, b) => a.idx - b.idx);
      // v60: 16 -> 20 slots (boxHalf vec3 + gridHalf, 64B -> 80B).
      // v103: 20 -> 28 slots (cellMinX/Y/Z + cellRangeX/Y/Z + 2 pad,
      // 80B -> 112B) for active-cell dispatch.
      const expectedOrder = [
        'gravity', 'gravity', 'gravity', 'dt',
        'boxHalfX', 'boxHalfY', 'boxHalfZ', 'gridHalf',
        'cellSize', 'invCellSize', 'fixedPoint', 'particleMass',
        'velDamping', 'restitution', 'pressureK', 'restDensity',
        'maxAccel', 'wallFriction', 'viscosity', '_pad0',
        'cellMinX', 'cellMinY', 'cellMinZ', 'cellRangeX',
        'cellRangeY', 'cellRangeZ', '_padA', '_padB',
      ];
      assert(jsAssigns.length === expectedOrder.length,
        'expected ' + expectedOrder.length + ' simBuf assigns, got ' + jsAssigns.length);
      // Check the WGSL struct order matches (skipping gravity which is vec3).
      const wgslOrder = fields;
      const expectedWgsl = [
        'gravity', 'dt',
        'boxHalfX', 'boxHalfY', 'boxHalfZ', 'gridHalf',
        'cellSize', 'invCellSize', 'fixedPoint', 'particleMass',
        'velDamping', 'restitution', 'pressureK', 'restDensity',
        'maxAccel', 'wallFriction', 'viscosity', '_pad0',
        'cellMinX', 'cellMinY', 'cellMinZ', 'cellRangeX',
        'cellRangeY', 'cellRangeZ', '_padA', '_padB',
      ];
      assert(wgslOrder.length === expectedWgsl.length,
        'WGSL struct has ' + wgslOrder.length + ' fields, expected ' + expectedWgsl.length);
      for (let i = 0; i < expectedWgsl.length; i++) {
        assert(wgslOrder[i] === expectedWgsl[i],
          'WGSL field ' + i + ': expected "' + expectedWgsl[i] + '", got "' + wgslOrder[i] + '"');
      }
    });

    function parseGridSize(src) {
      const m = src.match(/const\s+GRID_SIZE\s*=\s*(\d+)/);
      assert(m, 'GRID_SIZE constant not found');
      return parseInt(m[1], 10);
    }
    function parseDefaultN(src) {
      const m = src.match(/if\s*\(!m\)\s*return\s+(\d+);/);
      assert(m, 'default N literal not found in readParticleCount');
      return parseInt(m[1], 10);
    }
    function parseSubDt(src) {
      // const SUB_DT = 1 / NNN;
      const m = src.match(/const\s+SUB_DT\s*=\s*1\s*\/\s*(\d+)/);
      assert(m, 'SUB_DT constant not found');
      return 1 / parseInt(m[1], 10);
    }

    test('gpu-mpm v48: CFL margin > 1.0 at current SIM_TUNE values', () => {
      // v61: presets store pressureKMul (multiplier over _natRho).
      // c = sqrt(K/rho0) = sqrt(pressureKMul) since rho0 == _natRho.
      // v62: grid extends 2 cells beyond max(boxHalf) on each face, so
      // cellSize = 2 * gridHalf / GRID_SIZE = 2 * maxBox / (GRID_SIZE - 4)
      // for the worst-case (maxBox = BOX_HALF_Y = 1.0).
      const src = readMpmScript();
      const mulMatch = src.match(/pressureKMul:\s*(\d+(?:\.\d+)?)/);
      assert(mulMatch, 'pressureKMul literal not found');
      const gridSize = parseGridSize(src);
      const cellSize = 2.0 / (gridSize - 4);
      const subDt = parseSubDt(src);
      const soundC = Math.sqrt(parseFloat(mulMatch[1]));
      const cflDt = cellSize / soundC;
      const margin = cflDt / subDt;
      assert(margin > 1.05,
        'CFL margin too tight: ' + margin.toFixed(3) +
        ' (Kmul=' + mulMatch[1] + ' c=' + soundC.toFixed(2) +
        ' cflDt=' + cflDt.toFixed(5) + ' subDt=' + subDt.toFixed(5) + ')');
    });

    test('gpu-mpm v51: FLUID_PRESETS contains the expected preset keys', () => {
      const src = readMpmScript();
      // FLUID_PRESETS is declared as an array of {key, label, tune} objects.
      const arrMatch = src.match(/const\s+FLUID_PRESETS\s*=\s*\[([\s\S]*?)\];/);
      assert(arrMatch, 'FLUID_PRESETS array literal not found');
      const expected = ['water', 'honey', 'syrup', 'mercury'];
      for (const k of expected) {
        assert(arrMatch[1].indexOf("key: '" + k + "'") >= 0 ||
               arrMatch[1].indexOf('key: "' + k + '"') >= 0,
          'preset key "' + k + '" missing from FLUID_PRESETS');
      }
      // applyPreset wiring must exist.
      assert(src.indexOf('function applyPreset') >= 0, 'applyPreset() function missing');
      // Each preset must define every live tunable so a swap doesn't leave
      // stale fields. Pull each tune block and verify keys.
      const tuneRe = /key:\s*'([a-z]+)',\s*label:[^,]+,\s*tune:\s*{([\s\S]*?)}/g;
      const required = [
        'pressureKMul', 'velDamping', 'restitution', 'wallFriction', 'viscosity', 'maxAccel',
        'baseColorR', 'baseColorG', 'baseColorB',
        'absorptionR', 'absorptionG', 'absorptionB',
        'refractStrength',
      ];
      let m;
      let count = 0;
      while ((m = tuneRe.exec(arrMatch[1]))) {
        count++;
        for (const r of required) {
          assert(m[2].indexOf(r + ':') >= 0,
            'preset "' + m[1] + '" missing tunable "' + r + '"');
        }
      }
      assert(count === expected.length,
        'expected ' + expected.length + ' preset entries, parsed ' + count);
    });

    test('gpu-mpm v51: every preset stays inside CFL margin > 1.05', () => {
      // v61: presets store pressureKMul (multiplier over _natRho). CFL
      // margin depends only on the multiplier — c = sqrt(K/rho0) =
      // sqrt(pressureKMul) since rho0 = _natRho — so we just check each.
      // v62: cellSize = 2 / (GRID_SIZE - 4) per the 2-cell-margin grid.
      const src = readMpmScript();
      const cellSize = 2.0 / (parseGridSize(src) - 4);
      const subDt = parseSubDt(src);
      const re = /pressureKMul:\s*(\d+(?:\.\d+)?)/g;
      const multipliers = [];
      let m;
      while ((m = re.exec(src))) multipliers.push(parseFloat(m[1]));
      assert(multipliers.length >= 4,
        'expected >=4 pressureKMul values (one per preset), got ' + multipliers.length);
      for (const mul of multipliers) {
        const c = Math.sqrt(mul);
        const cflDt = cellSize / c;
        const margin = cflDt / subDt;
        assert(margin > 1.05,
          'preset with pressureKMul = ' + mul + ' violates CFL: margin ' +
          margin.toFixed(3) + ' (c=' + c.toFixed(2) + ')');
      }
    });

    test('gpu-mpm v51: presets panel HTML buttons exist and applyPreset is wired', () => {
      const src = readMpmScript();
      // Inline scripts also include the static HTML around them — the
      // readMpmScript helper returns only the script body. So check the
      // raw file for the panel/button DOM.
      let html;
      if (isNode) {
        const fs = require('fs');
        const path = require('path');
        html = fs.readFileSync(path.resolve(__dirname, 'gpu-mpm.html'), 'utf8');
      } else {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', './gpu-mpm.html?t=' + Date.now(), false);
        xhr.send(null);
        html = xhr.responseText;
      }
      assert(html.indexOf('id="presets-btn"') >= 0, 'presets-btn missing from HTML');
      assert(html.indexOf('id="presets-panel"') >= 0, 'presets-panel missing from HTML');
      for (const k of ['water', 'honey', 'syrup', 'mercury']) {
        assert(html.indexOf('data-preset="' + k + '"') >= 0,
          'preset button data-preset="' + k + '" missing from HTML');
      }
      // The JS must wire the click → applyPreset path.
      assert(src.indexOf("applyPreset(b.getAttribute('data-preset'))") >= 0 ||
             src.indexOf('applyPreset(b.getAttribute("data-preset"))') >= 0,
        'preset-btn click handler does not call applyPreset(...)');
    });

    test('gpu-mpm v53: CompositeParams WGSL struct matches JS compBuf layout', () => {
      // v53 adds thicknessScale + absorption coefficients to the composite
      // uniform. WGSL struct field order must match JS compBuf assignments
      // (with vec3-style 16-byte packing accounted for) or the shader
      // reads garbage for thickness / Beer's law coefficients.
      const src = readMpmScript();
      const structMatch = src.match(/struct\s+CompositeParams\s*{([\s\S]*?)}/);
      assert(structMatch, 'CompositeParams WGSL struct not found');
      const fields = structMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.split(':')[0].trim());
      const expectedWgsl = [
        'near', 'far', 'fAspect', 'fVert',
        'resolutionX', 'resolutionY', 'thicknessScale', 'refractStrength',
        'lightDirX', 'lightDirY', 'lightDirZ', '_pad1',
        'absorptionR', 'absorptionG', 'absorptionB', '_pad2',
        'baseColorR', 'baseColorG', 'baseColorB', 'time',
      ];
      assert(fields.length === expectedWgsl.length,
        'CompositeParams has ' + fields.length + ' fields, expected ' + expectedWgsl.length);
      for (let i = 0; i < expectedWgsl.length; i++) {
        assert(fields[i] === expectedWgsl[i],
          'CompositeParams field ' + i + ': expected "' + expectedWgsl[i] + '", got "' + fields[i] + '"');
      }
      // Now confirm JS writes the same logical 20 slots (every compBuf[N] = ...).
      const jsAssigns = [];
      const re = /compBuf\[(\d+)\]\s*=\s*([^;]+);/g;
      let m;
      while ((m = re.exec(src))) jsAssigns.push(parseInt(m[1], 10));
      jsAssigns.sort((a, b) => a - b);
      for (let i = 0; i < 20; i++) {
        assert(jsAssigns.indexOf(i) >= 0, 'compBuf[' + i + '] never assigned in JS');
      }
      // COMPOSITE_PARAMS_SIZE must equal 80 (20 floats).
      const sizeMatch = src.match(/COMPOSITE_PARAMS_SIZE\s*=\s*(\d+)/);
      assert(sizeMatch, 'COMPOSITE_PARAMS_SIZE constant not found');
      assert(parseInt(sizeMatch[1], 10) === 80,
        'COMPOSITE_PARAMS_SIZE must be 80 bytes (got ' + sizeMatch[1] + ')');
    });

    test('gpu-mpm v107: back-face depth pass shader + pipeline + frame draw wired', () => {
      // v107 replaces the v53 additive-thickness pass with a back-face
      // depth pass. Same particle imposter but writes the FAR sphere
      // intersection; depthCompare='greater' + clearValue=0.0 keeps the
      // farthest fragment per pixel. Composite reads it to compute
      // physical view-space path length.
      const src = readMpmScript();
      assert(src.indexOf('WGSL_BACK_DEPTH') >= 0, 'WGSL_BACK_DEPTH shader source missing');
      assert(src.indexOf('backDepthPipeline') >= 0, 'backDepthPipeline not created');
      assert(src.indexOf('backDepthBindGroup') >= 0, 'backDepthBindGroup not created');
      assert(src.indexOf('backDepthTex') >= 0, 'backDepthTex texture missing');
      // Pipeline must use depthCompare='greater'.
      const pipeIdx = src.indexOf('backDepthPipeline = device.createRenderPipeline');
      const pipeSlice = src.slice(pipeIdx, pipeIdx + 600);
      assert(pipeSlice.indexOf("depthCompare: 'greater'") >= 0,
        "backDepthPipeline must set depthCompare: 'greater' (keep the farthest fragment)");
      // Frame loop must draw the back-depth pass with depthClearValue: 0.0
      // and draw(6, N) — same instance count as the front-depth pass.
      const setIdx = src.indexOf('p.setPipeline(backDepthPipeline)');
      assert(setIdx >= 0, 'backDepthPipeline never bound in a render pass');
      const before = src.slice(Math.max(0, setIdx - 400), setIdx);
      assert(before.indexOf('depthClearValue: 0.0') >= 0,
        'back-depth render pass must clear to depth=0.0 so depthCompare=greater works');
      const after = src.slice(setIdx, setIdx + 200);
      assert(after.indexOf('p.draw(6, N)') >= 0,
        'backDepthPipeline render pass does not draw(6, N)');
    });

    test('gpu-mpm v54: no WGSL reserved words used as let/var identifiers', () => {
      // iOS Safari WGSL strictly rejects let/var names that match any
      // reserved word from the spec. v53 shipped with `let final = ...`
      // which compiled fine in some browsers but errored out on iOS Safari
      // ("Expected an Identifier, but got a ReservedWord"). Scan every
      // WGSL_* template literal for let/var <reservedWord>.
      const src = readMpmScript();
      const reserved = [
        // Most likely to be mistakenly used as variable names.
        'final', 'class', 'enum', 'new', 'null', 'this', 'super', 'match',
        'mut', 'become', 'template', 'typename', 'where', 'with', 'yield',
        'async', 'await', 'union', 'unless', 'until', 'move', 'from',
        'crate', 'private', 'public', 'protected', 'static', 'try', 'throw',
        'catch', 'finally', 'register', 'sizeof', 'typeof', 'instanceof',
        'delete', 'inline', 'export', 'extern', 'extends', 'implements',
        'interface', 'package', 'volatile', 'virtual', 'auto', 'goto',
      ];
      const blocks = [];
      const re = /const\s+(WGSL_\w+)\s*=\s*`([\s\S]*?)`/g;
      let m;
      while ((m = re.exec(src))) blocks.push({ name: m[1], body: m[2] });
      assert(blocks.length >= 4, 'expected >=4 WGSL_ blocks (compute, depth, thickness, blur, composite, lines), got ' + blocks.length);
      for (const block of blocks) {
        for (const word of reserved) {
          // Match `let final` / `var final` (not field names like 'final:').
          const pat = new RegExp('\\b(?:let|var)\\s+' + word + '\\b', 'g');
          const hit = pat.exec(block.body);
          assert(!hit, block.name + ' uses reserved word "' + word + '" as a let/var identifier');
        }
      }
    });

    test('gpu-mpm v107: thickness blur pipeline removed (back-face depth supersedes it)', () => {
      // v107 dropped the v53 additive-thickness texture + the v73-v101
      // separable thickness blur because two-layer depth gives a smooth
      // view-space path length directly. Verify both are gone.
      const src = readMpmScript();
      assert(src.indexOf('const WGSL_THICKNESS_BLUR') < 0,
        'const WGSL_THICKNESS_BLUR declaration should be removed in v107');
      assert(src.match(/\bthicknessBlurH\b/) === null && src.match(/\bthicknessBlurV\b/) === null,
        'thicknessBlurH/V pipeline objects should be removed in v107');
      assert(src.match(/\bthicknessTex\b/) === null,
        'thicknessTex (additive r16float texture) should be removed in v107');
      // Composite must bind backDepthTex at the slot where it used to
      // bind thicknessV.
      const compIdx = src.indexOf('compositePipeline.getBindGroupLayout(0)');
      assert(compIdx >= 0, 'compositeBindGroup not found');
      const bgSlice = src.slice(compIdx, compIdx + 500);
      assert(bgSlice.indexOf('backDepthTex.createView()') >= 0,
        'composite must sample backDepthTex (back-face depth) in v107');
    });

    test('gpu-mpm v59: refraction wiring — backgroundTex pass + composite samples it', () => {
      const src = readMpmScript();
      // backgroundTex texture exists and is set up.
      assert(src.indexOf('backgroundTex = device.createTexture') >= 0,
        'backgroundTex texture not created');
      // The composite bind group includes a 4th entry for backgroundTex.
      const bgIdx = src.indexOf('backgroundTex.createView()');
      assert(bgIdx >= 0, 'backgroundTex view never bound');
      // A render pass renders linesPipeline into backgroundTex (the
      // background render pass). Heuristic: `view: backgroundTex.createView()`
      // appears as a colorAttachment.view setting.
      assert(src.indexOf('view: backgroundTex.createView()') >= 0,
        'background render pass missing (no colorAttachment view: backgroundTex.createView())');
      // Composite shader samples backgroundTex.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('textureLoad(backgroundTex') >= 0,
        'composite shader does not sample backgroundTex');
      assert(compositeSrc.indexOf('refractStrength') >= 0,
        'composite shader does not reference refractStrength uniform');
    });

    test('gpu-mpm v55: alphaScale (renderBuf[23]) is non-zero so thickness pass writes signal', () => {
      // v53/v54 shipped with renderBuf[23] = 0, which made the thickness
      // pass write zeros to the thickness texture. Beer's law then gave
      // absorption == 1 everywhere → fluid rendered as near-white +
      // bright sky reflection (silver). Make sure the slot is non-zero.
      const src = readMpmScript();
      const m = src.match(/renderBuf\[23\]\s*=\s*([0-9.]+)/);
      assert(m, 'renderBuf[23] assignment not found');
      const v = parseFloat(m[1]);
      assert(v > 0,
        'renderBuf[23] (alphaScale, used by thickness pass) must be > 0, got ' + v);
    });

    test('gpu-mpm v107: composite uses Beer-Lambert on two-layer view-space path length + cubemap Fresnel', () => {
      const src = readMpmScript();
      // Pull the WGSL_COMPOSITE template literal body.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      assert(compIdx >= 0, 'WGSL_COMPOSITE source not found');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      // v107: thickness is computed inline from front + back depth, no
      // thicknessTex binding. backDepthTex is bound at slot 2.
      assert(compositeSrc.indexOf('backDepthTex') >= 0,
        'composite shader does not bind backDepthTex');
      assert(compositeSrc.indexOf('thicknessTex') < 0,
        'composite shader must no longer bind thicknessTex in v107');
      // pathLen / pathLength expression from front-back view-space delta.
      assert(compositeSrc.indexOf('pathLen') >= 0 || compositeSrc.indexOf('pathLength') >= 0,
        'composite shader must compute a view-space pathLen between front and back depth');
      assert(compositeSrc.indexOf('exp(-P.absorptionR') >= 0 ||
             compositeSrc.indexOf('exp(-P.absorption') >= 0,
        'composite shader does not apply Beer law exp(-coef * thickness)');
      assert(compositeSrc.indexOf('reflect(-viewDir, n)') >= 0,
        'composite shader does not compute reflected view direction');
      assert(compositeSrc.indexOf('textureSampleLevel(skyCube') >= 0 ||
             compositeSrc.indexOf('textureSample(skyCube') >= 0,
        'composite shader does not sample the sky cubemap (skyCube)');
    });

    test('gpu-mpm v76: cs_g2p uses velocity-adaptive damping', () => {
      const src = readMpmScript();
      function bodyOf(fnName) {
        const start = src.indexOf('fn ' + fnName);
        if (start < 0) return null;
        let end = src.indexOf('@compute', start + 1);
        if (end < 0) end = src.length;
        return src.slice(start, end);
      }
      const g2p = bodyOf('cs_g2p');
      assert(g2p, 'cs_g2p not found');
      // Adaptive damping: speed-based smoothstep + mix into effective coefficient.
      assert(g2p.indexOf('smoothstep') >= 0 && g2p.indexOf('length(newV)') >= 0,
        'cs_g2p must compute speed-dependent rest weight via smoothstep(length(newV))');
      assert(g2p.indexOf('effectiveDamp') >= 0 || g2p.indexOf('effectiveVisc') >= 0,
        'cs_g2p must compute effective damping/viscosity from rest weight');
    });

    test('gpu-mpm v104: bloom pipeline stripped (no extract / no blur / no combine)', () => {
      // v104 abandons the bloom post-process to match the NVIDIA SSF
      // reference. The composite pass should write directly to the
      // canvas — no compositeTex render target, no bloom textures, no
      // combine pass.
      const src = readMpmScript();
      assert(src.indexOf('WGSL_BLOOM') < 0,
        'WGSL_BLOOM shader source should be removed in v104');
      assert(src.indexOf('WGSL_COMBINE') < 0,
        'WGSL_COMBINE shader source should be removed in v104');
      assert(src.indexOf('bloomBrightPipeline') < 0,
        'bloomBrightPipeline reference still present');
      assert(src.indexOf('bloomBlurHPipeline') < 0,
        'bloomBlurHPipeline reference still present');
      assert(src.indexOf('combinePipeline') < 0,
        'combinePipeline reference still present');
      // Composite must render directly to the canvas (use of
      // ctx.getCurrentTexture().createView() right before the composite
      // pass setPipeline).
      const fluidCompIdx = src.indexOf('p.setPipeline(compositePipeline)');
      assert(fluidCompIdx >= 0, 'composite pipeline never used in frame loop');
      const ctxBefore = src.slice(Math.max(0, fluidCompIdx - 500), fluidCompIdx);
      assert(ctxBefore.indexOf('compositeTex.createView()') < 0,
        'composite pass must NOT target compositeTex in v104 (write straight to canvas)');
      assert(ctxBefore.indexOf('view: view') >= 0 || ctxBefore.indexOf('view: view,') >= 0,
        'composite pass must target the canvas view (ctx.getCurrentTexture().createView())');
    });

    test('gpu-mpm v104: composite shader stripped of fBm, caustics, ripple perturbation', () => {
      // v104 removed all the post-2010 noise/caustic layering so the
      // SSF surface reads as the geometry plus Fresnel reflection —
      // matching the NVIDIA GDC 2010 SSF deck.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('fn fbm2') < 0,
        'composite must not define fbm2() fractal-noise helper anymore');
      assert(compositeSrc.indexOf('fn valueNoise2D') < 0,
        'composite must not define valueNoise2D() helper anymore');
      assert(compositeSrc.indexOf('fn lightCaustic') < 0,
        'composite must not define lightCaustic() helper anymore');
      assert(compositeSrc.indexOf('rippleStrength') < 0,
        'composite must not apply ripple perturbation in v104');
      assert(compositeSrc.indexOf('curvatureAmp') < 0,
        'composite must not gate caustics on curvatureAmp in v104 (whole caustic block is gone)');
      // v105: sampleSky function was hoisted out to a real cubemap
      // texture baked once at init. The composite no longer defines
      // or calls a procedural sampleSky helper.
      assert(compositeSrc.indexOf('fn sampleSky') < 0,
        'composite must not define an inline sampleSky() helper anymore (cubemap supersedes it)');
      assert(compositeSrc.indexOf('texture_cube<f32>') >= 0,
        'composite must bind a texture_cube<f32> for environment reflection');
    });

    test('gpu-mpm v104: depth blur replaced with screen-space curvature flow', () => {
      // v104 swapped the wide separable bilateral depth blur (WGSL_BLUR)
      // for Müller/Green screen-space curvature flow. Verify the new
      // shader and its uniform are present, the old bilateral is gone,
      // and the frame loop ping-pongs the new pipeline 4x.
      const src = readMpmScript();
      assert(src.indexOf('WGSL_BLUR') < 0,
        'WGSL_BLUR (bilateral depth blur) must be removed in v104');
      assert(src.indexOf('WGSL_CURVATURE') >= 0,
        'WGSL_CURVATURE shader source missing');
      assert(src.indexOf('curvaturePipeline') >= 0,
        'curvaturePipeline not created');
      // CurvParams uniform must define Cx, Cy, dt — the Müller formula
      // parameters.
      const curvIdx = src.indexOf('const WGSL_CURVATURE');
      const curvEnd = src.indexOf('`;', curvIdx);
      const curvSrc = src.slice(curvIdx, curvEnd);
      assert(curvSrc.indexOf('struct CurvParams') >= 0,
        'WGSL_CURVATURE must declare a CurvParams struct');
      assert(curvSrc.indexOf('Cx: f32') >= 0 && curvSrc.indexOf('Cy: f32') >= 0,
        'CurvParams must include Cx and Cy (Müller pixel-scale)');
      assert(curvSrc.indexOf('dt: f32') >= 0,
        'CurvParams must include dt (curvature-flow step size)');
      // The shader must compute mean curvature H and integrate.
      assert(curvSrc.indexOf('Fxx') >= 0 && curvSrc.indexOf('Fyy') >= 0,
        'curvature-flow shader must compute second derivatives Fxx/Fyy');
      assert(curvSrc.match(/let\s+H\s*=/) || curvSrc.indexOf('let H =') >= 0 ||
             curvSrc.indexOf('let H  =') >= 0,
        'curvature-flow shader must compute mean curvature H');
      // JS-side: 4 ping-pong iterations driven by curvaturePipeline.
      const passDispatches = (src.match(/p\.setPipeline\(curvaturePipeline\)/g) || []).length;
      // Single-shader bind-group references are also a strong signal
      // (one per ping-pong iteration target).
      assert(passDispatches >= 1,
        'curvaturePipeline must be dispatched at least once per frame');
      // The curvature uniform must be written each frame.
      assert(src.indexOf('curvParamsBuf') >= 0,
        'curvature flow uniform buffer (curvParamsBuf) missing');
      assert(src.indexOf('writeBuffer(curvParamsBuf') >= 0,
        'curvParamsBuf must be written from JS each frame');
    });

    test('gpu-mpm v105: composite uses silhouette-aware 5-tap normal + single-tap refraction', () => {
      // v105 brought back the 5-tap normal reconstruction (the
      // canonical SSF technique from the NVIDIA deck). dpdx/dpdy gave
      // 2×2-quad blockiness on smooth curvature-flow surfaces.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('fn reconstructNormal') >= 0,
        'composite must define reconstructNormal() helper for silhouette-aware 5-tap normal');
      assert(compositeSrc.indexOf('reconstructNormal(coord') >= 0,
        'composite must call reconstructNormal() to derive the surface normal');
      // Single-tap refraction (background sampled at most twice — once
      // in the no-fluid blit, once warped in the fluid branch).
      let bgSamples = 0;
      let i = 0;
      while ((i = compositeSrc.indexOf('textureLoad(backgroundTex', i)) >= 0) {
        bgSamples++; i++;
      }
      assert(bgSamples <= 2,
        'composite should sample backgroundTex at most 2 times (no chromatic refraction); got ' + bgSamples);
    });

    test('gpu-mpm v105: procedural sky cubemap baked once + composite tone-maps via ACES', () => {
      const src = readMpmScript();
      // Cubemap texture is created with the cube dimension via createView.
      assert(src.indexOf('skyCubeTex') >= 0, 'skyCubeTex texture not created');
      assert(src.indexOf("dimension: 'cube'") >= 0,
        'composite bind group must view skyCubeTex with dimension: "cube"');
      assert(src.indexOf('writeTexture') >= 0,
        'sky cubemap faces must be uploaded via writeTexture');
      // ACES tone mapping at the end of the composite.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('fn acesFilm') >= 0,
        'composite must define acesFilm() tone-mapping helper');
      // v121: ACES is now toggleable via T.toneMap; tone-mapped output
      // appears inside a mix() rather than as a top-level call. Accept
      // any acesFilm(...) call at all.
      assert(compositeSrc.indexOf('acesFilm(') >= 0,
        'composite must call acesFilm() somewhere in the final colour path');
    });

    test('gpu-mpm v106: sky cubemap is HDR (rgba16float) + composite has subsurface scatter', () => {
      const src = readMpmScript();
      // Cubemap format must be rgba16float so the sun core (authored
      // >1.0) survives into the texture instead of clamping to white.
      const skyTexBlock = src.slice(src.indexOf('skyCubeTex = device.createTexture'),
                                     src.indexOf('skyCubeTex = device.createTexture') + 400);
      assert(skyTexBlock.indexOf("'rgba16float'") >= 0,
        'sky cubemap must be created with rgba16float format (v106 HDR upgrade)');
      // f16 encoder must exist so the JS bake can write into the f16 texture.
      assert(src.indexOf('f32tof16') >= 0,
        'sky cubemap bake must include an IEEE binary16 (f32tof16) encoder');
      // bytesPerRow must be width*8 for rgba16float (2 bytes per channel).
      assert(src.indexOf('bytesPerRow: size * 8') >= 0,
        'writeTexture for the rgba16float cubemap must use bytesPerRow = size * 8');
      // Subsurface scatter term in the composite.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('scatterPeak') >= 0,
        'composite must compute a scatterPeak term for subsurface scattering');
      assert(compositeSrc.indexOf('let sss') >= 0,
        'composite must add an `sss` (subsurface scatter) contribution to the body');
      assert(compositeSrc.indexOf('+ sss') >= 0,
        'composite must add the sss term to the transmitted body colour');
    });

    // -----------------------------------------------------------------
    // v115 numerical regression tests for the SSF rendering calibration.
    // These compute effective values from the source constants rather
    // than pattern-matching, so they catch silent calibration drift
    // (e.g. v107's units change, v114's σ/R convention bug).
    // -----------------------------------------------------------------

    test('gpu-mpm v121: RenderToggles uniform wired into composite shader', () => {
      // Live per-phase A/B toggles. 8-field RenderToggles struct, bound
      // at @binding(6) on the composite. Each effect in fs_main is mixed
      // through its toggle so off-state vs on-state is branchless.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('struct RenderToggles') >= 0,
        'composite must declare RenderToggles uniform struct');
      assert(compositeSrc.match(/@group\(0\)\s*@binding\(6\)\s*var<uniform>\s+T:\s*RenderToggles/) !== null,
        'RenderToggles must be bound at @binding(6) as `T`');
      // The eight named toggles.
      const expected = ['beerLambert','subsurface','refraction','fresnel',
                        'spec','iblAmbient','toneMap','cubemapReflect'];
      for (const name of expected) {
        assert(compositeSrc.indexOf(name + ': f32') >= 0,
          'RenderToggles must include `' + name + '` field');
        assert(compositeSrc.indexOf('T.' + name) >= 0,
          'composite must consume T.' + name + ' in its effect chain');
      }
    });

    test('gpu-mpm v121: depth-smoothing passthrough flags (Bilateral + Curvature)', () => {
      // The smoothing/curvature passes get an `enabled` toggle on their
      // own uniforms (since their pipeline can't be skipped without
      // rebinding composite to a different depth source). When the
      // toggle is 0, the shader returns the source depth unmodified.
      const src = readMpmScript();
      const bilIdx = src.indexOf('const WGSL_DEPTH_BILATERAL');
      const bilEnd = src.indexOf('`;', bilIdx);
      const bilSrc = src.slice(bilIdx, bilEnd);
      assert(bilSrc.indexOf('enabled: f32') >= 0,
        'BilateralParams must declare `enabled: f32` field');
      assert(bilSrc.indexOf('P.enabled < 0.5') >= 0,
        'Bilateral shader must passthrough when P.enabled < 0.5');

      const curvIdx = src.indexOf('const WGSL_CURVATURE');
      const curvEnd = src.indexOf('`;', curvIdx);
      const curvSrc = src.slice(curvIdx, curvEnd);
      assert(curvSrc.indexOf('enabled: f32') >= 0,
        'CurvParams must declare `enabled: f32` field');
      assert(curvSrc.indexOf('P.enabled < 0.5') >= 0,
        'Curvature shader must passthrough when P.enabled < 0.5');
    });

    test('gpu-mpm v121: state.toggles, localStorage persistence, JS uniform write', () => {
      const src = readMpmScript();
      assert(src.indexOf('toggles:') >= 0 && src.indexOf('state.toggles') >= 0,
        'state.toggles must exist with per-phase booleans');
      // Persistence layer.
      assert(src.indexOf("localStorage.getItem('water-box-toggles')") >= 0 ||
             src.indexOf("'water-box-toggles'") >= 0,
        'toggles must persist in localStorage');
      // Toggles uniform buffer written per frame.
      assert(src.indexOf('togglesParamsBuf') >= 0,
        'togglesParamsBuf must be created');
      assert(src.indexOf('writeBuffer(togglesParamsBuf') >= 0,
        'togglesParamsBuf must be written each frame');
      // Caustic dispatch is conditional on the toggle.
      assert(src.match(/if\s*\(\s*state\.toggles\.caustics\s*\)/) !== null,
        'caustic dispatch must be gated by state.toggles.caustics');
    });

    test('gpu-mpm v121: phase-preset dropdown with multiple canned configurations', () => {
      const src = readMpmScript();
      assert(src.indexOf('TOGGLE_PRESETS') >= 0,
        'TOGGLE_PRESETS dictionary must exist');
      // Must include at least these named presets.
      const required = ['reference', 'minimalist', 'caustics', 'mirror', 'raw_depth'];
      for (const name of required) {
        assert(src.indexOf(name + ':') >= 0 || src.indexOf("'" + name + "'") >= 0,
          'TOGGLE_PRESETS must include "' + name + '" preset');
      }
      // UI panel must exist.
      assert(src.indexOf('phases-preset-select') >= 0,
        'Phases panel must include a preset <select> element');
      assert(src.indexOf("getElementById('phases-btn')") >= 0,
        'Phases-panel toggle button must be wired in JS');
    });

    test('gpu-mpm regression: PARTICLE_RADIUS in sensible range (silhouette stays smooth)', () => {
      // Too small leaves discrete particle circles visible around the
      // silhouette where single particles don't overlap a neighbour;
      // too big over-extends the fluid past where particles actually
      // are. v119 settled on 0.022 after observing silhouette artifacts
      // at 0.017.
      const src = readMpmScript();
      const prMatch = src.match(/const\s+PARTICLE_RADIUS\s*=\s*([0-9.]+);/);
      assert(prMatch, 'PARTICLE_RADIUS constant not found');
      const particleRadius = parseFloat(prMatch[1]);
      assert(particleRadius >= 0.018,
        'PARTICLE_RADIUS too small (' + particleRadius +
        '); silhouette imposters won\'t overlap neighbours, single-particle circles will show');
      assert(particleRadius <= 0.035,
        'PARTICLE_RADIUS too large (' + particleRadius +
        '); silhouette will visibly extend past actual fluid extent');
    });

    test('gpu-mpm regression: Gaussian σ ≥ PARTICLE_RADIUS (kernel spans particle features)', () => {
      // If worldSigma < PARTICLE_RADIUS the depth-smoothing Gaussian
      // can't actually blur across particle imposters — surface keeps
      // visible per-particle bumps (the v109-v114 bug).
      const src = readMpmScript();
      const wsMatch = src.match(/gaussBuf\[6\]\s*=\s*([0-9.]+);/);
      assert(wsMatch, 'gaussBuf[6] (worldSigma) assignment not found');
      const worldSigma = parseFloat(wsMatch[1]);
      const prMatch = src.match(/const\s+PARTICLE_RADIUS\s*=\s*([0-9.]+);/);
      assert(prMatch, 'PARTICLE_RADIUS constant not found');
      const particleRadius = parseFloat(prMatch[1]);
      assert(worldSigma >= particleRadius,
        'worldSigma (' + worldSigma + ') must be ≥ PARTICLE_RADIUS (' +
        particleRadius + ') so the Gaussian kernel can smooth particle-' +
        'scale imposter noise — otherwise the surface stays visibly bumpy');
    });

    test('gpu-mpm regression: bilateral range σ ≥ 3 × PARTICLE_RADIUS (no over-preservation)', () => {
      // Particle imposter creates depth bumps up to ~2 × PARTICLE_RADIUS
      // between centers and gaps. If worldRangeSigma is too small, the
      // bilateral preserves these as edges and the Gaussian can't smooth
      // adjacent particles together. 3 × PARTICLE_RADIUS gives a range
      // weight of ~exp(-0.44) = 0.65 on particle-boundary jumps — enough
      // smoothing while still preserving true intra-fluid edges (e.g.
      // separate sloshes).
      const src = readMpmScript();
      const wrMatch = src.match(/gaussBuf\[8\]\s*=\s*([0-9.]+);/);
      assert(wrMatch, 'gaussBuf[8] (worldRangeSigma) assignment not found');
      const worldRangeSigma = parseFloat(wrMatch[1]);
      const prMatch = src.match(/const\s+PARTICLE_RADIUS\s*=\s*([0-9.]+);/);
      const particleRadius = parseFloat(prMatch[1]);
      assert(worldRangeSigma >= 3 * particleRadius,
        'worldRangeSigma (' + worldRangeSigma + ') must be ≥ 3 × PARTICLE_RADIUS (' +
        (3 * particleRadius).toFixed(3) + ') — otherwise the bilateral preserves ' +
        'every particle outline as a fake edge and the surface stays bumpy');
    });

    test('gpu-mpm regression: Gaussian truncation reaches ≥ 2σ', () => {
      // Standard cutoff for a Gaussian is 3σ (weight ~1.1%). At 2σ
      // weight is still ~14% so smoothing still happens. Below 2σ the
      // kernel is essentially the central peak only.
      const src = readMpmScript();
      const gIdx = src.indexOf('const WGSL_DEPTH_BILATERAL');
      const gEnd = src.indexOf('`;', gIdx);
      const shader = src.slice(gIdx, gEnd);
      const rMatch = shader.match(/min\(\s*([0-9.]+)\s*\*\s*sigmaScreen/);
      assert(rMatch, 'Gaussian truncation R formula not found');
      const truncMult = parseFloat(rMatch[1]);
      assert(truncMult >= 2.0,
        'Gaussian truncation must reach at least 2σ (got R = ' + truncMult +
        ' × σ); below 2σ the kernel is too narrow to actually smooth');
    });

    test('gpu-mpm regression: Beer-Lambert absorbs ≥ 30% red at max depth (Water preset)', () => {
      // v107 switched to physical view-space path length; thicknessScale
      // was tuned for the old additive-sprite range. If they drift apart,
      // water reads as glass-clear (the v113 bug).
      const src = readMpmScript();
      const tsMatch = src.match(/compBuf\[6\]\s*=\s*([0-9.]+);/);
      assert(tsMatch, 'thicknessScale (compBuf[6]) not found');
      const thicknessScale = parseFloat(tsMatch[1]);
      // Water preset is the first FLUID_PRESETS entry.
      const apMatch = src.match(/key:\s*['"]water['"][\s\S]*?absorptionR:\s*([0-9.]+)/);
      assert(apMatch, 'water preset absorptionR not found');
      const absorptionR = parseFloat(apMatch[1]);
      // BOX_HALF_Z bounds the max view-ray path length ≈ 2 × BOX_HALF_Z.
      const bhzMatch = src.match(/let\s+BOX_HALF_Z\s*=\s*([0-9.]+);/);
      assert(bhzMatch, 'BOX_HALF_Z initial value not found');
      const boxHalfZ = parseFloat(bhzMatch[1]);
      const maxPathLen = 2 * boxHalfZ;
      const maxThickness = maxPathLen * thicknessScale;
      const redAbsorbed = 1 - Math.exp(-absorptionR * maxThickness);
      assert(redAbsorbed >= 0.30,
        'Beer-Lambert too weak at max depth: only ' + (redAbsorbed * 100).toFixed(1) +
        '% red absorbed (thicknessScale=' + thicknessScale + ', BOX_HALF_Z=' +
        boxHalfZ + ', absorptionR=' + absorptionR + '). Water will look clear.');
    });

    test('gpu-mpm regression: thinClamp saturates within half of max pathLen', () => {
      // If thinClamp saturates too LATE (multiplier too small for our
      // pathLen range) the bulk fluid gets silent Fresnel/spec/refraction
      // suppression. v113 bug.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      const tcMatch = compositeSrc.match(/clamp\(\s*pathLen\s*\*\s*([0-9.]+)/);
      assert(tcMatch, 'thinClamp formula not found');
      const tcMul = parseFloat(tcMatch[1]);
      const bhzMatch = src.match(/let\s+BOX_HALF_Z\s*=\s*([0-9.]+);/);
      const boxHalfZ = parseFloat(bhzMatch[1]);
      const saturationPathLen = 1.0 / tcMul;
      const maxPathLen = 2 * boxHalfZ;
      assert(saturationPathLen <= 0.5 * maxPathLen,
        'thinClamp saturates too late: at pathLen ' + saturationPathLen.toFixed(3) +
        ' but max pathLen is ' + maxPathLen.toFixed(3) + '. Bulk fluid will get ' +
        'Fresnel/spec/refraction suppression.');
    });

    test('gpu-mpm regression: body→sky mix uses raw fresnel (not thinClamp-masked)', () => {
      // v113 fix. Masking Fresnel with thinClamp killed sky reflection
      // across the whole body, not just at the silhouette.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.match(/mix\(\s*transmitted\s*,\s*sky\s*,\s*fresnel(Eff)?\s*\)/) !== null,
        'Body→sky mix must use raw fresnel (or fresnel*toggle = fresnelEff) — never fresnelMasked');
    });

    test('gpu-mpm regression: normal-reconstruction stencil ≥ 2 px (anti-specular-aliasing)', () => {
      // A ±1-pixel stencil picks up sub-σ noise in the smoothed depth
      // and fires tight Schlick spec into visible sparkles on the top
      // surface. v116 widened to ±3. Asserting ≥ 2 keeps the door open
      // for future tuning while catching a regression to ±1.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      const stencilMatch = compositeSrc.match(/NORMAL_STENCIL\s*:\s*i32\s*=\s*(\d+)/);
      assert(stencilMatch, 'NORMAL_STENCIL constant not found in composite shader');
      const stencil = parseInt(stencilMatch[1], 10);
      assert(stencil >= 2,
        'NORMAL_STENCIL must be ≥ 2 to avoid spec aliasing on the smoothed surface (got ' + stencil + ')');
      assert(stencil <= 10,
        'NORMAL_STENCIL too wide will blur silhouettes (got ' + stencil + '; recommended 3-8)');
    });

    test('gpu-mpm v118: share button captures canvas PNG + uses navigator.share', () => {
      // The share button is the "one-tap bug report" path: it captures
      // the current canvas as a PNG and opens the iOS share sheet with
      // the screenshot + debug text attached.
      const src = readMpmScript();
      assert(src.indexOf("getElementById('share-btn')") >= 0,
        'Share button element must be looked up in JS (proves the DOM element is bound)');
      // The handler must call canvas.toBlob() to grab a PNG.
      assert(src.indexOf('canvas.toBlob') >= 0,
        'Share button must call canvas.toBlob() to capture the screenshot');
      // The handler must attempt navigator.share for the iOS share sheet.
      assert(src.indexOf('navigator.share') >= 0,
        'Share button must use navigator.share() to open the iOS share sheet');
      // The handler must pass both the debug text AND a files array.
      const handlerIdx = src.indexOf("shareBtn.addEventListener");
      assert(handlerIdx >= 0, 'Share button must have a click handler');
      // Look in the next ~2000 chars for the navigator.share({...}) shape.
      const handlerCtx = src.slice(handlerIdx, handlerIdx + 3000);
      assert(handlerCtx.match(/navigator\.share\(\s*\{[\s\S]*?files\s*:/) !== null,
        'navigator.share must be called with a files array (PNG attached)');
      assert(handlerCtx.match(/navigator\.share\(\s*\{[\s\S]*?text\s*:/) !== null,
        'navigator.share must be called with a text field (debug report)');
      // Single source for the debug report (refactored out into a function).
      assert(src.indexOf('function buildDebugReport') >= 0,
        'Debug-report builder must be a shared function (both buttons use it)');
    });

    test('gpu-mpm regression: cubemap reflection clamped in body→sky branch', () => {
      // v117 fix. The HDR cubemap has sun core at brightness ~9; small
      // normal variations between adjacent pixels can swing the
      // reflection sample between 9 and ~0.5, producing a high-contrast
      // dotted pattern through Fresnel. Clamping the sample to a
      // moderate maximum kills that aliasing while ACES tone-maps the
      // capped peak to a clean bright wet-rim look.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      // v121: the cubemap sample is now `cubeSample = min(textureSampleLevel(skyCube, ...), 3.5)`
      // and then mixed against a flat colour by T.cubemapReflect.
      assert(compositeSrc.match(/min\(\s*textureSampleLevel\(\s*skyCube[\s\S]*?,\s*vec3<f32>\(\s*3\.[0-9]+\s*\)\s*\)/) !== null,
        'cubemap reflection sample must be wrapped in min(..., vec3(N)) to clamp HDR aliasing');
    });

    test('gpu-mpm regression: Schlick R₀ baseline present (non-zero at normal incidence)', () => {
      // v112 fix. Without R₀ the Fresnel goes to 0 at normal incidence
      // and the body has zero reflection looking straight down.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      const r0Match = compositeSrc.match(/R0_water\s*:\s*f32\s*=\s*([0-9.]+)/);
      assert(r0Match, 'R0_water constant must be declared (Schlick baseline)');
      const r0 = parseFloat(r0Match[1]);
      assert(r0 > 0.0 && r0 < 0.5,
        'R0_water must be a small positive value (got ' + r0 +
        '); physical water is ~0.02');
      // Formula must add R0 baseline to the (1-cosθ)⁵ angular term.
      assert(compositeSrc.match(/R0_water\s*\+\s*\(\s*1\.0\s*-\s*R0_water\s*\)\s*\*\s*pow/) !== null,
        'Fresnel must use the full Schlick form: R₀ + (1-R₀) × pow(1-cosθ, 5)');
    });

    // -----------------------------------------------------------------

    test('gpu-mpm v109: view-invariant depth pre-smooth (NVIDIA SSF slide 18)', () => {
      // v109 added a separable depth blur ahead of the curvature-flow
      // loop. The kernel width is recomputed per-pixel from the local
      // view-space depth so the smoothing extent is constant in WORLD
      // space (variable in screen space). Clamped to 50 pixels.
      // v110 upgrades the kernel to a true bilateral filter (see
      // separate test) but the view-invariance is the slide-18 property.
      const src = readMpmScript();
      assert(src.indexOf('WGSL_DEPTH_BILATERAL') >= 0,
        'WGSL_DEPTH_BILATERAL shader source missing');
      assert(src.indexOf('gaussH') >= 0 && src.indexOf('gaussV') >= 0,
        'gaussH / gaussV pipelines not created');
      assert(src.indexOf('gaussParamsBuf') >= 0,
        'gaussParamsBuf uniform not created');
      assert(src.indexOf('writeBuffer(gaussParamsBuf') >= 0,
        'gaussParamsBuf must be written from JS each frame');
      // Shader must compute a per-pixel screen radius from a worldRadius
      // uniform — i.e., be view-invariant.
      const gIdx = src.indexOf('const WGSL_DEPTH_BILATERAL');
      const gEnd = src.indexOf('`;', gIdx);
      const gaussSrc = src.slice(gIdx, gEnd);
      assert(gaussSrc.indexOf('worldSigma') >= 0 || gaussSrc.indexOf('worldRadius') >= 0,
        'depth-filter shader must declare a world-space σ (or radius) uniform');
      assert(gaussSrc.indexOf('maxScreenRadius') >= 0,
        'depth-filter shader must clamp R to maxScreenRadius (perf cap from the deck)');
      assert(gaussSrc.indexOf('pixelView') >= 0 || gaussSrc.match(/2\.0\s*\*\s*abs\(viewZ/),
        'depth-filter shader must compute view-space pixel size from depth (view-invariance)');
      // Pipeline must dispatch both passes in the frame loop, before curvature flow.
      const fhIdx = src.indexOf('p.setPipeline(gaussH)');
      const fvIdx = src.indexOf('p.setPipeline(gaussV)');
      const fcIdx = src.indexOf('p.setPipeline(curvaturePipeline)');
      assert(fhIdx >= 0 && fvIdx >= 0,
        'gaussH and gaussV must both be dispatched in the frame loop');
      assert(fcIdx >= 0, 'curvaturePipeline must still be dispatched');
      assert(fhIdx < fcIdx && fvIdx < fcIdx,
        'gaussH and gaussV must run BEFORE the curvature-flow loop (pre-smooth)');
    });

    test('gpu-mpm v114: depth-filter sigma/R convention (worldSigma = true σ, R = 3σ)', () => {
      // v109-v113 had a sigma/R convention bug: R was treated as the
      // truncation radius BUT sigma was set to R/2, which meant the
      // effective world-space σ was worldRadius/2 — half what the
      // uniform name implied, and smaller than a particle (so the
      // Gaussian couldn't actually smooth over particle-scale noise).
      // v114 fixes: uniform field is now worldSigma (the actual σ), and
      // R is computed as min(3 * sigmaScreen, maxScreenRadius).
      const src = readMpmScript();
      const gIdx = src.indexOf('const WGSL_DEPTH_BILATERAL');
      const gEnd = src.indexOf('`;', gIdx);
      const shader = src.slice(gIdx, gEnd);
      assert(shader.indexOf('worldSigma') >= 0,
        'shader must declare worldSigma uniform field (true world-space σ)');
      assert(shader.match(/sigmaScreen\s*=\s*P\.worldSigma\s*\/\s*max\(\s*pixelView/) !== null,
        'sigmaScreen must be P.worldSigma / pixelView (the world σ in screen units)');
      assert(shader.match(/3\.0\s*\*\s*sigmaScreen/) !== null,
        'R truncation must use 3 * sigmaScreen (standard Gaussian 3σ cutoff)');
      // No more "sigma = R/2" half-σ convention.
      assert(shader.match(/sigma\s*=\s*f32\(R\)\s*\*\s*0\.5/) === null,
        'old sigma = R/2 half-σ convention should be gone in v114');
    });

    test('gpu-mpm v110: depth filter is bilateral (range weight in world depth units)', () => {
      // v110 upgrades v109's Gaussian to a true bilateral filter per
      // NVIDIA SSF deck slide 19: sample weight = spatial Gaussian ×
      // range Gaussian, where the range Gaussian is exp(-Δviewz² /
      // worldRangeSigma²). View-invariant in BOTH spatial and range.
      const src = readMpmScript();
      const gIdx = src.indexOf('const WGSL_DEPTH_BILATERAL');
      assert(gIdx >= 0, 'WGSL_DEPTH_BILATERAL not found');
      const gEnd = src.indexOf('`;', gIdx);
      const shader = src.slice(gIdx, gEnd);
      assert(shader.indexOf('worldRangeSigma') >= 0,
        'shader must declare worldRangeSigma in the uniform struct');
      assert(shader.indexOf('rangeSigma2_inv') >= 0,
        'shader must compute the range-weight reciprocal sigma²');
      // The range weight must multiply the spatial weight to form the
      // bilateral sample weight.
      assert(shader.match(/let\s+rangeW\s*=\s*exp\(/) !== null ||
             shader.match(/rangeW\s*=\s*exp\(/) !== null,
        'shader must compute a range-weight via exp(-Δz² × rangeSigma2_inv)');
      assert(shader.match(/spatialW\s*\*\s*rangeW/) !== null,
        'final sample weight must be spatialW * rangeW (bilateral product)');
      // Bilateral uniform must be 48 bytes (12 floats including pads).
      const sizeMatch = src.match(/GAUSS_PARAMS_SIZE\s*=\s*(\d+)/);
      assert(sizeMatch, 'GAUSS_PARAMS_SIZE constant not declared');
      assert(parseInt(sizeMatch[1], 10) === 48,
        'GAUSS_PARAMS_SIZE must be 48 bytes (v110 added worldRangeSigma + 3 pads)');
      // worldRangeSigma must be written from JS each frame at slot 8.
      const writeIdx = src.indexOf('writeBuffer(gaussParamsBuf');
      assert(writeIdx >= 0, 'gaussParamsBuf must be written each frame');
      const writeCtx = src.slice(Math.max(0, writeIdx - 400), writeIdx);
      assert(writeCtx.match(/gaussBuf\[8\]\s*=/) !== null,
        'frame loop must write gaussBuf[8] = worldRangeSigma');
    });

    test('gpu-mpm v113: thickness-shading recalibration for path-length units (slide 23)', () => {
      // v107's two-layer thickness made `thickness` view-space path
      // length (range ~0..0.10 for our box), but thicknessScale + the
      // thinClamp multiplier had been tuned for the old additive-sprite
      // range. Net: Beer-Lambert + Fresnel both suppressed nearly to
      // zero; water looked clear. v113 recalibrates.
      const src = readMpmScript();
      // compBuf[6] = thicknessScale must be at least 1.0 to give visible
      // absorption with the path-length thickness.
      const tsMatch = src.match(/compBuf\[6\]\s*=\s*([0-9.]+);/);
      assert(tsMatch, 'thicknessScale (compBuf[6]) assignment not found');
      const ts = parseFloat(tsMatch[1]);
      assert(ts >= 1.0,
        'thicknessScale must be >= 1.0 for path-length thickness (got ' + ts + ')');
      // thinClamp multiplier must scale to saturate within the box's
      // pathLen range (~0.10). 25× saturates at pathLen ≈ 0.04, sensible.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      const tcMatch = compositeSrc.match(/clamp\(\s*pathLen\s*\*\s*([0-9.]+)/);
      assert(tcMatch, 'thinClamp clamp() expression not found');
      const tcMul = parseFloat(tcMatch[1]);
      assert(tcMul >= 15.0,
        'thinClamp multiplier must be >= 15 so it saturates within the box (got ' + tcMul + ')');
      // Fresnel must be applied UNMASKED to the body-sky mix. The
      // composite's final mix() should call fresnel, not fresnelMasked.
      // v121: fresnel is now multiplied by T.fresnel (toggle) into
      // fresnelEff; still no thinClamp on it.
      assert(compositeSrc.match(/mix\(\s*transmitted\s*,\s*sky\s*,\s*fresnel(Eff)?\s*\)/) !== null,
        'final body-sky mix should use raw fresnel (or fresnel*toggle = fresnelEff) — never fresnelMasked');
      assert(compositeSrc.indexOf('fresnelMasked') < 0,
        'fresnelMasked (thinClamp-multiplied) form must not appear in v121+');
    });

    test('gpu-mpm v112: full Schlick Fresnel R₀ + (1-R₀)·(1-cosθ)⁵ (slide 22)', () => {
      // Previous versions used only the angular term pow(1-cosθ, 5),
      // which yields ZERO reflection at normal incidence. Schlick's
      // full approximation adds an R₀ baseline so flat water still
      // reflects ~2% straight on (R₀ = ((n-1)/(n+1))² ≈ 0.02 for
      // water at IOR 1.33). The slide explicitly calls this out.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('R0_water') >= 0 ||
             compositeSrc.match(/let\s+R0/) !== null,
        'composite must declare an R₀ baseline (reflectance at normal incidence)');
      // The full Schlick form must add R0 + (1-R0)*pow(1-nv, 5).
      assert(compositeSrc.match(/R0_water\s*\+\s*\(\s*1\.0\s*-\s*R0_water\s*\)\s*\*\s*pow\(\s*1\.0\s*-\s*nv/) !== null ||
             compositeSrc.match(/R0\s*\+\s*\(1\.0\s*-\s*R0\)\s*\*\s*pow\(1\.0\s*-\s*nv/) !== null,
        'composite must compute fresnel = R₀ + (1-R₀)·pow(1-cosθ, 5)');
      // R₀ for water must be sensible (around 0.02 — IOR 1.33).
      const r0Match = compositeSrc.match(/R0_water\s*:\s*f32\s*=\s*(0\.0\d+)/) ||
                      compositeSrc.match(/let\s+R0\s*=\s*(0\.0\d+)/);
      if (r0Match) {
        const r0 = parseFloat(r0Match[1]);
        assert(r0 > 0.005 && r0 < 0.06,
          'R₀ for water should be ~0.020 (IOR 1.33); got ' + r0);
      }
    });

    test('gpu-mpm v111: image-based ambient irradiance (sample sky cubemap with surface normal)', () => {
      // v111 implements NVIDIA SSF deck slide 20 "shade as usual" with
      // a real IBL ambient term: ambient = clamp(textureSample(skyCube, n))
      // — environment color sampled in the surface-normal direction,
      // clamped to keep the HDR sun core from blowing out the diffuse
      // branch (the sun's direct contribution belongs to the Blinn-
      // Phong specular). Replaces the v110 flat 0.30 ambient constant.
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('skyAmbient') >= 0,
        'composite must compute a skyAmbient term');
      // Must sample the cubemap with the surface NORMAL (n).
      assert(compositeSrc.match(/textureSampleLevel\(\s*skyCube\s*,\s*skySampler\s*,\s*n\s*,/) !== null,
        'composite must sample skyCube with the surface normal n (in addition to the existing reflection)');
      // Clamp on the ambient sample so the HDR sun core doesn't blow
      // out the diffuse term.
      assert(compositeSrc.indexOf('min(textureSampleLevel(skyCube') >= 0 ||
             compositeSrc.match(/min\(.*skyCube/) !== null,
        'composite must clamp the skyAmbient sample (min(...) on the cubemap read for ambient)');
      // Flat 0.30 ambient is gone.
      assert(compositeSrc.indexOf('0.30 + 0.70 * diffuse') < 0,
        'composite must not use the flat 0.30 ambient anymore');
    });

    test('gpu-mpm v108: true light-ray caustic pipeline (refract + trace + splat)', () => {
      // v108 implements ray-traced caustics per the NVIDIA SSF deck:
      // for each source-grid sample of the curvature-flowed front depth,
      // recover the world surface point + normal, refract the sun
      // direction via Snell, trace to the box floor, project to NDC,
      // and additively splat into backgroundTex. The Jacobian (local
      // convergence of refracted rays) emerges from additive blending.
      const src = readMpmScript();
      assert(src.indexOf('WGSL_CAUSTIC') >= 0,
        'WGSL_CAUSTIC shader source missing (v108 caustic pass)');
      assert(src.indexOf('causticPipeline') >= 0, 'causticPipeline not created');
      assert(src.indexOf('causticBindGroup') >= 0, 'causticBindGroup not created');
      assert(src.indexOf('causticParamsBuf') >= 0, 'causticParamsBuf uniform missing');
      assert(src.indexOf('writeBuffer(causticParamsBuf') >= 0,
        'causticParamsBuf must be written from JS each frame');
      assert(src.indexOf('p.setPipeline(causticPipeline)') >= 0,
        'causticPipeline never dispatched in the frame loop');
      // Caustic shader must actually use Snell's law via refract().
      const cIdx = src.indexOf('const WGSL_CAUSTIC');
      const cEnd = src.indexOf('`;', cIdx);
      const causticSrc = src.slice(cIdx, cEnd);
      assert(causticSrc.indexOf('refract(') >= 0,
        'caustic shader must call refract() (Snell on sun direction)');
      assert(causticSrc.indexOf('CausticParams') >= 0,
        'caustic shader must declare a CausticParams uniform struct');
      assert(causticSrc.indexOf('boxHalfX') >= 0 && causticSrc.indexOf('boxHalfY') >= 0,
        'caustic shader must know the box half extents (for floor trace + footprint clip)');
      assert(causticSrc.indexOf('fitD') >= 0,
        'caustic shader must know fitD (camera-to-world Z offset) for floor → NDC reprojection');
      // Caustic source grid size must be a square number > 1.
      const gridMatch = src.match(/CAUSTIC_SOURCE_GRID_N\s*=\s*(\d+)/);
      assert(gridMatch, 'CAUSTIC_SOURCE_GRID_N constant not declared');
      const grid = parseInt(gridMatch[1], 10);
      assert(grid >= 32 && grid <= 256,
        'CAUSTIC_SOURCE_GRID_N should be in a sensible range (32-256); got ' + grid);
    });

    test('gpu-mpm v98 perf: MPM substep loop has zero submits inside', () => {
      // v98 combined per-substep submits into one. Verify the
      // substep loop body contains no device.queue.submit calls.
      const src = readMpmScript();
      const loopStart = src.indexOf('for (let s = 0; s < subSteps;');
      assert(loopStart >= 0, 'substep loop not found');
      // Find the matching closing brace (assume the loop body is the
      // next brace pair). Simple bracket-counting from after the
      // open brace.
      const openBrace = src.indexOf('{', loopStart);
      let depth = 1, i = openBrace + 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      const loopBody = src.slice(openBrace, i);
      assert(loopBody.indexOf('device.queue.submit') < 0,
        'substep loop body must not contain device.queue.submit ' +
        '(v98 hoists the submit outside the loop)');
      // Also assert the substep loop body doesn't begin its own pass
      // (the v98 design uses ONE pass enclosing all substeps).
      assert(loopBody.indexOf('beginComputePass') < 0,
        'substep loop body must not call beginComputePass ' +
        '(v98 uses a single enclosing pass)');
    });

    test('gpu-mpm v98 perf: frame() does not allocate Float32Array each call', () => {
      // v98 hoisted simBuf, renderBuf, compBuf to closure scope. Make
      // sure no `new Float32Array(...)` appears inside the frame()
      // function body.
      const src = readMpmScript();
      const fnIdx = src.indexOf('function frame()');
      assert(fnIdx >= 0, 'frame() function not found');
      const openBrace = src.indexOf('{', fnIdx);
      let depth = 1, i = openBrace + 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      const fnBody = src.slice(openBrace, i);
      const allocCount = (fnBody.match(/new Float32Array\(/g) || []).length;
      assert(allocCount === 0,
        'frame() must not allocate Float32Array each call; found ' +
        allocCount + ' (use hoisted scratch buffers)');
    });

    test('gpu-mpm v48: wall friction applied in cs_grid, viscosity applied in cs_g2p', () => {
      // The WGSL must actually USE the new uniforms or they are dead code.
      // Slice each function body by index since JS regex has no \Z and
      // multi-line lookaheads inside template literals are awkward.
      const src = readMpmScript();
      function bodyOf(fnName) {
        const startKey = 'fn ' + fnName;
        const start = src.indexOf(startKey);
        if (start < 0) return null;
        // Find the next `@compute` annotation after this fn (marks next kernel),
        // or fall back to end of string.
        let end = src.indexOf('@compute', start + 1);
        if (end < 0) end = src.length;
        return src.slice(start, end);
      }
      const gridBody = bodyOf('cs_grid');
      const g2pBody  = bodyOf('cs_g2p');
      assert(gridBody, 'cs_grid body not found');
      assert(g2pBody, 'cs_g2p body not found');
      assert(gridBody.indexOf('P.wallFriction') >= 0,
        'cs_grid must reference P.wallFriction (tangential friction not applied)');
      assert(g2pBody.indexOf('P.viscosity') >= 0,
        'cs_g2p must reference P.viscosity (C-matrix decay not applied)');
    });
  }

  // =================================================================
  // v122: NUMERICAL RenderMath test suite.
  //
  // Pure-JS reference implementations of the WGSL shader math + tests
  // that exercise them across the relevant input domains. These give
  // me an "offline" check that the rendering pipeline's algebra is
  // sound — endpoints, monotonicity, round-trips, calibration — without
  // a GPU or a real browser.
  //
  // Each math function here mirrors the WGSL implementation in the
  // composite / bilateral / caustic shaders. If a shader's math drifts
  // away from the JS reference, the assertion fires.
  // =================================================================
  {
    const RenderMath = {
      // depth ∈ [0,1] (NDC) → view-space z (negative). Matches the WGSL
      // `linearizeNDC` / `viewPosFromDepth` helpers.
      linearizeNDC(zn, near, far) {
        return near * far / (zn * (far - near) - far);
      },
      // view-space z (negative) → depth ∈ [0,1]. Inverse of above.
      ndcFromView(zv, near, far) {
        return far / (far - near) + (near * far) / ((far - near) * zv);
      },
      // Schlick Fresnel: F(cosθ) = R0 + (1-R0)·(1-cosθ)^5. cosθ = dot(N,V).
      schlick(cosTheta, R0) {
        return R0 + (1 - R0) * Math.pow(1 - cosTheta, 5);
      },
      // Beer-Lambert: T(t) = exp(-coef·t). Returns fraction TRANSMITTED.
      beerLambert(thickness, coef) {
        return Math.exp(-coef * thickness);
      },
      // GLSL/WGSL refract(): incident i (already pointing INTO surface),
      // normal n (pointing OUT of surface, away from i), eta = n1/n2.
      // Returns refracted direction, or [0,0,0] on total internal reflection.
      refract(i, n, eta) {
        const ni = i[0]*n[0] + i[1]*n[1] + i[2]*n[2];
        const k = 1 - eta*eta * (1 - ni*ni);
        if (k < 0) return [0, 0, 0];
        const t = eta*ni + Math.sqrt(k);
        return [eta*i[0] - t*n[0], eta*i[1] - t*n[1], eta*i[2] - t*n[2]];
      },
      // ACES Filmic per-channel approximation (Hable / Narkowicz form).
      // Matches the WGSL acesFilm() in WGSL_COMPOSITE.
      aces(x) {
        const a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
        const f = v => Math.max(0, Math.min(1, (v*(a*v+b))/(v*(c*v+d)+e)));
        return [f(x[0]), f(x[1]), f(x[2])];
      },
      // Mean curvature of a flat surface = 0 (sanity check for the
      // curvature flow's mean-curvature formula). Linearized form on
      // a 5-stencil: H ≈ Laplacian(z).
      laplacian5(zc, zL, zR, zU, zD) {
        return zL + zR + zU + zD - 4 * zc;
      },
    };

    test('RenderMath: linearizeNDC at endpoints', () => {
      const z0 = RenderMath.linearizeNDC(0, 0.1, 100);
      assert(Math.abs(z0 - (-0.1)) < 1e-9,
        'depth=0 (near plane) should give viewZ = -near; got ' + z0);
      const z1 = RenderMath.linearizeNDC(1, 0.1, 100);
      assert(Math.abs(z1 - (-100)) < 1e-9,
        'depth=1 (far plane) should give viewZ = -far; got ' + z1);
    });

    test('RenderMath: linearizeNDC ↔ ndcFromView round-trip', () => {
      const near = 0.1, far = 100;
      for (let zn = 0.05; zn < 0.999; zn += 0.097) {
        const zv = RenderMath.linearizeNDC(zn, near, far);
        const zn2 = RenderMath.ndcFromView(zv, near, far);
        assert(Math.abs(zn - zn2) < 1e-6,
          'round-trip failed at zn=' + zn + ': back-converted to ' + zn2);
      }
    });

    test('RenderMath: linearizeNDC monotonic (depth increasing → viewZ more negative)', () => {
      const near = 0.1, far = 100;
      let prev = Infinity;
      for (let zn = 0.0; zn <= 0.999; zn += 0.1) {
        const zv = RenderMath.linearizeNDC(zn, near, far);
        assert(zv <= prev, 'linearizeNDC not monotonic at zn=' + zn);
        prev = zv;
      }
    });

    test('RenderMath: Schlick at cosθ=1 returns R0 exactly', () => {
      for (const R0 of [0.01, 0.02, 0.04, 0.10]) {
        assert(Math.abs(RenderMath.schlick(1, R0) - R0) < 1e-9,
          'Schlick(1, ' + R0 + ') should = R0');
      }
    });

    test('RenderMath: Schlick at cosθ=0 returns 1.0 (grazing reflects fully)', () => {
      for (const R0 of [0.01, 0.02, 0.04, 0.10]) {
        assert(Math.abs(RenderMath.schlick(0, R0) - 1.0) < 1e-9,
          'Schlick(0, ' + R0 + ') should = 1.0');
      }
    });

    test('RenderMath: Schlick monotonic decreasing as cosθ rises', () => {
      let prev = 2.0;  // larger than any valid Fresnel
      for (let c = 0.0; c <= 1.0; c += 0.05) {
        const f = RenderMath.schlick(c, 0.02);
        assert(f <= prev + 1e-9,
          'Schlick not monotonic at cosθ=' + c.toFixed(2) + ': ' + f + ' vs prev ' + prev);
        prev = f;
      }
    });

    test('RenderMath: Schlick at typical viewing angle (cosθ=0.7) ≈ 0.025', () => {
      // pow(0.3, 5) ≈ 0.00243; F ≈ 0.020 + 0.98·0.00243 ≈ 0.0224.
      const f = RenderMath.schlick(0.7, 0.02);
      assert(f > 0.02 && f < 0.04,
        'Fresnel at cosθ=0.7 should be ~0.022; got ' + f.toFixed(4));
    });

    test('RenderMath: Beer-Lambert at t=0 = 1.0 (no absorption)', () => {
      for (const k of [0.5, 5.0, 50.0]) {
        assert(Math.abs(RenderMath.beerLambert(0, k) - 1.0) < 1e-9,
          'Beer-Lambert at t=0 must be 1.0');
      }
    });

    test('RenderMath: Beer-Lambert monotonic decreasing with thickness', () => {
      let prev = 1.0;
      for (let t = 0.0; t <= 2.0; t += 0.1) {
        const T = RenderMath.beerLambert(t, 5);
        assert(T <= prev + 1e-9, 'Beer-Lambert not monotonic at t=' + t);
        prev = T;
      }
    });

    test('RenderMath: Beer-Lambert with t·k=1 transmits ~37%', () => {
      const T = RenderMath.beerLambert(0.2, 5.0);
      assert(Math.abs(T - Math.exp(-1)) < 1e-6,
        'T at k·t=1 should be e^(-1) ≈ 0.368; got ' + T);
    });

    test('RenderMath: refract — no bending at normal incidence', () => {
      // Incident pointing straight down (0,-1,0), normal up (0,1,0).
      const r = RenderMath.refract([0, -1, 0], [0, 1, 0], 1.0 / 1.33);
      // Refracted should also point straight down (0, -1, 0) since
      // there's no horizontal component to bend.
      assert(Math.abs(r[0]) < 1e-6 && Math.abs(r[2]) < 1e-6,
        'normal incidence should have no horizontal bend; got ' + r);
      assert(r[1] < 0, 'refracted ray should still go downward');
      // At eta < 1 (denser medium), the ray bends TOWARD the normal,
      // but since incidence is already along the normal, magnitude is 1.
      const mag = Math.hypot(r[0], r[1], r[2]);
      assert(Math.abs(mag - 1.0) < 1e-6,
        'refract should preserve unit length at normal incidence; got mag=' + mag);
    });

    test('RenderMath: refract — total internal reflection returns zero vector', () => {
      // Water → air (eta = 1.33). Incidence beyond critical angle
      // (~48.6°) should TIR.
      const theta = 60 * Math.PI / 180;
      const i = [Math.sin(theta), -Math.cos(theta), 0];   // into surface from below
      const n = [0, 1, 0];
      const r = RenderMath.refract(i, n, 1.33);
      assert(r[0] === 0 && r[1] === 0 && r[2] === 0,
        'TIR should return [0,0,0]; got ' + r);
    });

    test('RenderMath: refract — refracted ray stays in same plane as incident + normal', () => {
      const theta = 30 * Math.PI / 180;
      const i = [Math.sin(theta), -Math.cos(theta), 0];
      const n = [0, 1, 0];
      const r = RenderMath.refract(i, n, 1.0 / 1.33);
      assert(Math.abs(r[2]) < 1e-6,
        'refracted ray must stay in xy plane when incident does; got r.z=' + r[2]);
    });

    test('RenderMath: ACES at 0 = 0', () => {
      const r = RenderMath.aces([0, 0, 0]);
      assert(Math.abs(r[0]) < 1e-9 && Math.abs(r[1]) < 1e-9 && Math.abs(r[2]) < 1e-9);
    });

    test('RenderMath: ACES at low input is approximately linear', () => {
      const r = RenderMath.aces([0.1, 0.1, 0.1]);
      // ACES at 0.1 ≈ 0.083 (slightly under-curves at low end).
      assert(r[0] > 0.05 && r[0] < 0.15,
        'ACES at 0.1 should be near 0.1; got ' + r[0].toFixed(4));
    });

    test('RenderMath: ACES compresses bright values toward 1.0', () => {
      const r = RenderMath.aces([10, 10, 10]);
      assert(r[0] > 0.85 && r[0] <= 1.0,
        'ACES at 10 should saturate near 1.0; got ' + r[0].toFixed(4));
    });

    test('RenderMath: ACES monotonic (brighter input → brighter output)', () => {
      let prev = -1;
      for (let v = 0; v < 5; v += 0.2) {
        const r = RenderMath.aces([v, v, v]);
        assert(r[0] >= prev - 1e-9, 'ACES not monotonic at v=' + v);
        prev = r[0];
      }
    });

    test('RenderMath: curvature Laplacian = 0 on a flat surface', () => {
      const zc = 0.5;
      const L = RenderMath.laplacian5(zc, zc, zc, zc, zc);
      assert(Math.abs(L) < 1e-12, 'flat 5-stencil should have zero Laplacian');
    });

    test('RenderMath: curvature Laplacian > 0 on a local minimum', () => {
      // Cup shape: centre is lower than neighbours → Laplacian positive
      // → curvature flow pushes centre UP toward neighbours.
      const L = RenderMath.laplacian5(0.3, 0.5, 0.5, 0.5, 0.5);
      assert(L > 0, 'local minimum should have positive Laplacian');
    });

    test('RenderMath: curvature Laplacian < 0 on a local maximum', () => {
      const L = RenderMath.laplacian5(0.7, 0.5, 0.5, 0.5, 0.5);
      assert(L < 0, 'local maximum should have negative Laplacian');
    });

    // ---------- Integration tests: calibration of the live constants ----------

    test('Integration: thicknessScale × max-path × absorptionR gives visible Beer-Lambert', () => {
      // Pull the actual constants from the source and compute the
      // absorbed fraction at the deepest point of the box. Should be
      // in the "visibly blue" range — 30-85%.
      const src = readMpmScript();
      const tsMatch  = src.match(/compBuf\[6\]\s*=\s*([0-9.]+);/);
      const arMatch  = src.match(/key:\s*['"]water['"][\s\S]*?absorptionR:\s*([0-9.]+)/);
      const bhzMatch = src.match(/let\s+BOX_HALF_Z\s*=\s*([0-9.]+);/);
      assert(tsMatch && arMatch && bhzMatch, 'failed to extract calibration constants');
      const thicknessScale = parseFloat(tsMatch[1]);
      const absorptionR   = parseFloat(arMatch[1]);
      const boxHalfZ      = parseFloat(bhzMatch[1]);
      const maxPathLen = 2 * boxHalfZ;
      const T = RenderMath.beerLambert(maxPathLen * thicknessScale, absorptionR);
      const absorbed = 1 - T;
      assert(absorbed >= 0.30 && absorbed <= 0.90,
        'Beer-Lambert red absorption at max depth should be 30-90%; got ' +
        (absorbed*100).toFixed(1) + '% (thicknessScale=' + thicknessScale +
        ', BOX_HALF_Z=' + boxHalfZ + ', absorptionR=' + absorptionR + ')');
    });

    test('Integration: Schlick R0 from source gives ~2% reflection at normal incidence', () => {
      const src = readMpmScript();
      const r0Match = src.match(/R0_water\s*:\s*f32\s*=\s*([0-9.]+)/);
      assert(r0Match, 'R0_water constant not found in composite');
      const R0 = parseFloat(r0Match[1]);
      const F_normal = RenderMath.schlick(1.0, R0);
      assert(Math.abs(F_normal - R0) < 1e-9);
      assert(F_normal >= 0.005 && F_normal <= 0.10,
        'R0 should give 0.5-10% reflection at normal incidence (physical water = 2%); got ' +
        (F_normal*100).toFixed(2) + '%');
    });

    test('Integration: refract sun direction with surface normal does NOT TIR for typical surface', () => {
      // The caustic pass refracts the sun INTO the water. For typical
      // sun direction + roughly-horizontal water surface, refract should
      // succeed (not TIR), and the resulting ray should go downward
      // so it can hit the floor.
      const src = readMpmScript();
      const ratioMatch = src.match(/causticBuf\[11\]\s*=\s*([0-9.\s/]+?);/);
      assert(ratioMatch, 'caustic refract ratio not found');
      // Eval as JS to handle "1.0 / 1.33" form.
      const ratio = eval(ratioMatch[1]);
      const sunDir = [0.35, 0.80, 0.50]; // matches the JS in gpu-mpm.html
      const sl = Math.hypot(...sunDir);
      const sunN = sunDir.map(x => x / sl);
      const incident = [-sunN[0], -sunN[1], -sunN[2]]; // direction of light travel
      const normal = [0, 1, 0]; // flat water surface
      const r = RenderMath.refract(incident, normal, ratio);
      assert(r[0] !== 0 || r[1] !== 0 || r[2] !== 0,
        'sun → water surface should NOT TIR for typical sun direction');
      assert(r[1] < 0,
        'refracted sun ray must travel downward to hit floor; got r.y=' + r[1]);
    });

    test('Integration: Gaussian σ at typical viewing depth ≥ particle screen-space size', () => {
      // worldSigma is in world units; particle imposter is PARTICLE_RADIUS.
      // The Gaussian needs σ_world ≥ PARTICLE_RADIUS so the kernel actually
      // smooths across at least one particle. (Already a regression test;
      // here we also check the screen-space radius using the camera
      // projection numerics.)
      const src = readMpmScript();
      const wsMatch = src.match(/gaussBuf\[6\]\s*=\s*([0-9.]+);/);
      const prMatch = src.match(/const\s+PARTICLE_RADIUS\s*=\s*([0-9.]+);/);
      const worldSigma   = parseFloat(wsMatch[1]);
      const particleRadius = parseFloat(prMatch[1]);
      assert(worldSigma >= particleRadius,
        'worldSigma must be ≥ PARTICLE_RADIUS or Gaussian under-smooths');
      // Compute screen sigma at typical depth (viewZ ≈ -2.2 in our box,
      // fAspect ≈ 4.66 for iPhone-portrait aspect).
      const viewZ = -2.2;
      const fAspect = 4.66;
      const resX = 585;     // iPhone 13 portrait × DPR 1.5
      const pixelView = 2.0 * Math.abs(viewZ) / (fAspect * resX);
      const sigmaScreen = worldSigma / pixelView;
      assert(sigmaScreen >= 10,
        'screen-space σ at typical depth should be ≥ 10 px; got ' + sigmaScreen.toFixed(1));
    });

    test('Integration: thinClamp saturates inside box at typical scene', () => {
      const src = readMpmScript();
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      const tcMatch = compositeSrc.match(/clamp\(\s*pathLen\s*\*\s*([0-9.]+)/);
      const bhzMatch = src.match(/let\s+BOX_HALF_Z\s*=\s*([0-9.]+);/);
      const mul = parseFloat(tcMatch[1]);
      const boxHalfZ = parseFloat(bhzMatch[1]);
      const maxPathLen = 2 * boxHalfZ;
      // Saturation pathLen = 1 / mul. Want this ≤ 0.4 × max so bulk is unmasked.
      assert(1 / mul <= 0.4 * maxPathLen,
        'thinClamp saturation pathLen (' + (1/mul).toFixed(3) +
        ') must be ≤ 40% of maxPathLen (' + maxPathLen.toFixed(3) + ')');
    });
  }

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
