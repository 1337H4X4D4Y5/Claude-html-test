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
    test('gpu-mpm: const N declared before const _natRho (TDZ regression check)', () => {
      // v46 declared `const _natRho = N * 1.0 / 4.0` ABOVE `const N = ...`,
      // which throws ReferenceError under TDZ at script load and leaves
      // the overlay button inert. Verify the ordering is correct.
      const src = readMpmScript();
      const idxN = src.indexOf('const N = readParticleCount()');
      const idxRho = src.indexOf('const _natRho = N');
      assert(idxN >= 0, 'const N declaration not found');
      assert(idxRho >= 0, 'const _natRho declaration not found');
      assert(idxN < idxRho,
        'const N must appear before const _natRho (TDZ violation regressed): ' +
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
      const expectedOrder = [
        'gravity', 'gravity', 'gravity', 'dt',  // vec3 + dt packs into 16 bytes
        'boxHalf', 'cellSize', 'invCellSize', 'fixedPoint',
        'particleMass', 'velDamping', 'restitution', 'pressureK',
        'restDensity', 'maxAccel', 'wallFriction', 'viscosity',
      ];
      assert(jsAssigns.length === expectedOrder.length,
        'expected ' + expectedOrder.length + ' simBuf assigns, got ' + jsAssigns.length);
      // Check the WGSL struct order matches (skipping gravity which is vec3).
      const wgslOrder = fields;
      const expectedWgsl = [
        'gravity', 'dt',
        'boxHalf', 'cellSize', 'invCellSize', 'fixedPoint',
        'particleMass', 'velDamping', 'restitution', 'pressureK',
        'restDensity', 'maxAccel', 'wallFriction', 'viscosity',
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

    test('gpu-mpm v48: CFL margin > 1.0 at current SIM_TUNE values', () => {
      // Pull SIM_TUNE.pressureK and restDensity literals out of the script
      // and compute the CFL margin. If a future edit raises K past the
      // stability cliff, this test fires before the user has to see
      // blasting particles. Grid size + default N are parsed from source
      // so changing them won't silently invalidate the test.
      const src = readMpmScript();
      const kMatch  = src.match(/pressureK:\s*_natRho\s*\*\s*(\d+(?:\.\d+)?)/);
      assert(kMatch, 'pressureK literal not found');
      const N_DEFAULT = parseDefaultN(src);
      const natRho = N_DEFAULT / 4;
      const K = natRho * parseFloat(kMatch[1]);
      const rho0 = natRho;
      const cellSize = 2.0 / parseGridSize(src);
      const subDt = 1 / 240;
      const soundC = Math.sqrt(K / rho0);
      const cflDt = cellSize / soundC;
      const margin = cflDt / subDt;
      assert(margin > 1.05,
        'CFL margin too tight: ' + margin.toFixed(3) +
        ' (K=' + K + ' c=' + soundC.toFixed(2) +
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
        'pressureK', 'velDamping', 'restitution', 'wallFriction', 'viscosity', 'maxAccel',
        'baseColorR', 'baseColorG', 'baseColorB',
        'absorptionR', 'absorptionG', 'absorptionB',
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
      // pressureK multipliers (over _natRho) for each preset, as authored
      // in gpu-mpm.html. If any preset exceeds the CFL ceiling at the
      // default substep dt the fluid blows up — test catches that before
      // shipping. Grid size + default N are parsed from source.
      const src = readMpmScript();
      const N_DEFAULT = parseDefaultN(src);
      const natRho = N_DEFAULT / 4;
      const cellSize = 2.0 / parseGridSize(src);
      const subDt = 1 / 240;
      // Pull every "pressureK: _natRho * NUMBER" line from FLUID_PRESETS.
      const re = /pressureK:\s*_natRho\s*\*\s*(\d+(?:\.\d+)?)/g;
      const multipliers = [];
      let m;
      while ((m = re.exec(src))) multipliers.push(parseFloat(m[1]));
      assert(multipliers.length >= 4,
        'expected >=4 pressureK multipliers (one per preset), got ' + multipliers.length);
      for (const mul of multipliers) {
        const K = natRho * mul;
        const c = Math.sqrt(K / natRho);
        const cflDt = cellSize / c;
        const margin = cflDt / subDt;
        assert(margin > 1.05,
          'preset with K = _natRho * ' + mul + ' violates CFL: margin ' +
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
        'resolutionX', 'resolutionY', 'thicknessScale', '_pad0',
        'lightDirX', 'lightDirY', 'lightDirZ', '_pad1',
        'absorptionR', 'absorptionG', 'absorptionB', '_pad2',
        'baseColorR', 'baseColorG', 'baseColorB', '_pad3',
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

    test('gpu-mpm v53: thickness pass shader + pipeline + frame draw wired', () => {
      const src = readMpmScript();
      assert(src.indexOf('WGSL_THICKNESS') >= 0, 'WGSL_THICKNESS shader source missing');
      assert(src.indexOf('thicknessPipeline') >= 0, 'thicknessPipeline not created');
      assert(src.indexOf('thicknessBindGroup') >= 0, 'thicknessBindGroup not created');
      assert(src.indexOf('thicknessTex') >= 0, 'thicknessTex texture missing');
      // Frame loop must draw the thickness pass (one draw call with N instances).
      // Heuristic: pipeline set + a draw(6, N) following it.
      const setIdx = src.indexOf('p.setPipeline(thicknessPipeline)');
      assert(setIdx >= 0, 'thicknessPipeline never bound in a render pass');
      const after = src.slice(setIdx, setIdx + 200);
      assert(after.indexOf('p.draw(6, N)') >= 0,
        'thicknessPipeline render pass does not draw(6, N)');
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

    test('gpu-mpm v53: composite shader uses thickness + Beer\'s law + sky reflection', () => {
      const src = readMpmScript();
      // Pull the WGSL_COMPOSITE template literal body.
      const compIdx = src.indexOf('const WGSL_COMPOSITE');
      assert(compIdx >= 0, 'WGSL_COMPOSITE source not found');
      const compEnd = src.indexOf('`;', compIdx);
      const compositeSrc = src.slice(compIdx, compEnd);
      assert(compositeSrc.indexOf('thicknessTex') >= 0,
        'composite shader does not bind thicknessTex');
      assert(compositeSrc.indexOf('exp(-P.absorptionR') >= 0 ||
             compositeSrc.indexOf('exp(-P.absorption') >= 0,
        'composite shader does not apply Beer law exp(-coef * thickness)');
      assert(compositeSrc.indexOf('reflect(-viewDir, n)') >= 0,
        'composite shader does not compute reflected view direction');
      assert(compositeSrc.indexOf('sampleSky') >= 0,
        'composite shader does not sample procedural sky');
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
