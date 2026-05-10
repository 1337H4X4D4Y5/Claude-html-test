// Unit tests for the water simulation core. Runs in Node and (via test.html) in the browser.

(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const mod = isNode ? require('./sim.js') : root;
  const HeightField = mod.HeightField;
  const mapOrientationToGravity = mod.mapOrientationToGravity;

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

  test('sim stays bounded for every (beta, gamma) on a coarse sweep', () => {
    // For each orientation, set the gravity, run the sim for 5 seconds at
    // 1/60 dt, and verify max|h| never exceeds 0.55 (leaving margin from
    // the 0.6 clamp). This catches scenarios where a specific tilt makes
    // the equilibrium plane drive heights into the clamp where they then
    // turn into a checkerboard.
    const betas = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
    const gammas = [-90, -45, 0, 45, 90];
    let worst = { beta: 0, gamma: 0, peak: 0 };
    for (const b of betas) {
      for (const gm of gammas) {
        const g = mapOrientationToGravity(b, gm, 0, 9.8);
        const f = new HeightField(64, { waveC: 0.6 });
        f.pokeGaussian(32, 32, 0.12, 3.5);
        f.startAtRest();
        let peak = 0;
        for (let s = 0; s < 300; s++) {
          f.step(1 / 60, g.x, g.y, g.z);
          const m = f.maxAbsHeight();
          if (m > peak) peak = m;
          assert(!f.hasNaN(), 'NaN at beta=' + b + ' gamma=' + gm + ' step ' + s);
        }
        if (peak > worst.peak) worst = { beta: b, gamma: gm, peak: peak };
      }
    }
    assertLT(worst.peak, 0.55,
      'worst orientation beta=' + worst.beta + ' gamma=' + worst.gamma +
      ' peak ' + worst.peak.toFixed(4));
  });

  test('sim survives a slow rotation through all orientations (beta sweep)', () => {
    // Continuously animate beta from 0 to 360 (with wraparound at +/-180) over
    // 5 seconds while running the sim. This is what 'rotate the phone 360'
    // looks like to the simulation. Verify it stays bounded.
    const f = new HeightField(64, { waveC: 0.6 });
    f.pokeGaussian(32, 32, 0.12, 3.5);
    f.startAtRest();
    const totalSteps = 300; // 5 sec at 1/60
    let peak = 0;
    for (let s = 0; s < totalSteps; s++) {
      // beta sweeps from -180 to 180 over the run.
      const t = s / totalSteps;
      const beta = -180 + t * 360;
      const g = mapOrientationToGravity(beta, 0, 0, 9.8);
      f.step(1 / 60, g.x, g.y, g.z);
      const m = f.maxAbsHeight();
      if (m > peak) peak = m;
      assert(!f.hasNaN(), 'NaN during beta sweep at step ' + s);
    }
    assertLT(peak, 0.55, 'beta sweep peaked at ' + peak.toFixed(4));
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
