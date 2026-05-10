// Unit tests for the water simulation core. Runs in Node and (via test.html) in the browser.

(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const { HeightField } = isNode ? require('./sim.js') : root;

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
