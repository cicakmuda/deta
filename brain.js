/**
 * brain.js — "otak" dashboard, diterjemahkan dari skill Meta Ads Performance Manager.
 * Tidak menyentuh DOM dan tidak memanggil API: hanya menerima data → mengembalikan penilaian.
 * Semua angka ambang ada di Brain.defaults dan bisa ditimpa lewat Brain.setConfig().
 *
 * Vektor metrik harian (17 angka, sama dengan baris dataset):
 *   0 spend, 1 impr, 2 reach, 3 clicks, 4 link, 5 lpv, 6 atc, 7 ic, 8 purch, 9 value,
 *   10 contact, 11 plays, 12 p25, 13 p50, 14 p75, 15 p100, 16 thru
 */
(function (root) {
  'use strict';

  var Brain = {};

  Brain.defaults = {
    cutoff: 1.1,       // ROAS di bawah ini = Loser
    minRoas: 2.0,      // ROAS minimum = Winner (pertahankan)
    target: 2.5,       // ROAS target = Winner yang layak scale
    minAge: 7,         // hari; campaign lebih muda = Tunggu
    minDays: 3,        // minimal hari berjalan untuk menilai
    dataMult: 2,       // data cukup kalau spend 7D ≥ 2× CPA maks (atau ≥ 50 purchase)
    dataResults: 50,
    leakMult: 1.5,     // spend ≥ 1,5× CPA maks tanpa purchase = pause candidate
    band: 0.15,        // ±15% di sekitar ROAS minimum = Watchlist
    decline: { roas: 0.20, cpa: 0.30, ctr: 0.20, freq: 3.5 },
    scaleMin: 0.10, scaleMax: 0.10, scaleEvery: 3,  // rulebook v2: naik 10% tiap 3 hari
    // Rule konten (level iklan) — semua batas spend = kelipatan CPA maks
    content: {
      lookback: 30,      // hari data yang dinilai (+ hari ini)
      testMult: 1,       // < 1× CPA maks tanpa purchase = masih testing
      killMult: 1.5,     // ≥ 1,5× CPA maks tanpa purchase = matikan
      lossMult: 3,       // ≥ 3× CPA maks & ROAS < cutoff = matikan (laku tapi rugi)
      tofMult: 2,        // konten "bagus" tanpa purchase diberi sampai 2× CPA maks
      streakMult: 2,     // winner kosong: wajar selama spend kosong < 2× CPA historisnya
      ctrGood: 0.012,    // Link CTR ≥ 1,2% = angka awal bagus
      ctrKill: 0.005,    // Link CTR < 0,5% setelah cukup impresi = hook gagal
      lpvGood: 0.6,      // LPV ÷ klik ≥ 60% (kalau LPV terlacak)
      earlyImpr: 3000, earlySpend: 200000,   // syarat minimal untuk vonis hook gagal
      minDays: 3,        // umur minimal sebelum boleh dimatikan karena "lanjut test"
      provenP: 2,        // terbukti = ≥ 2 purchase & ROAS ≥ cutoff
      winP: 3,           // winner = ≥ 3 purchase & ROAS ≥ minimum
      waitScale: 3,      // hari menunggu setelah budget naik
      scaleLook: 10,     // kenaikan budget yang masih dianggap "baru" (hari)
      winDays: 2,        // winner: purchase di minimal 2 hari berbeda
      winSpendMult: 2,   // winner: spend minimal 2× CPA maks
      junkMult: 2,       // B3: LPV ≥ 2× LPV yang dibutuhkan untuk 1 purchase (closing sehat), 0 checkout
      junkLpv: 300,      // B3 cadangan kalau patokan closing akun belum ada
      zeroMult: 2,       // B4: campaign kosong beruntun dengan spend ≥ 2× CPA historis
      zeroDays: 7,       // B7: campaign 0 purchase ≥ 7 hari berturut-turut
      placeMult: 1.5,    // B5: penempatan spend ≥ 1,5× CPA maks, 0 checkout
      segMult: 3,        // B6: segmen usia/gender spend ≥ 3× CPA maks, ≤ 1 purchase
      // ---- Rulebook v2 (SOP testing & ASC) ----
      cplKill: 250000,   // B1: spend ≥ ini & biaya per lead (pixel Lead) > ini → matikan
      cpaKill: 1500000,  // B1b: spend ≥ ini & CPA > ini → matikan; konten bagus = CPA ≤ ini
      sopWin: [3, 7, 14],// jendela hari untuk B1/B1b
      goodP: 1,          // konten bagus: minimal purchase
      stepUp: 0.10,      // naik budget 10%
      stepDown: 0.10,    // turun budget 10%
      zeroCut: 3,        // 3 hari tanpa purchase → turun; 3 hari lagi → matikan
      evalDays: [3, 5, 7], evalEvery: 3, killDay: 7
    }
  };
  Brain.cfg = clone(Brain.defaults);
  Brain.setConfig = function (o) {
    o = o || {}; var c = Object.assign(clone(Brain.defaults), o);
    c.content = Object.assign(clone(Brain.defaults.content), o.content || {});
    Brain.cfg = c; return c;
  };

  /* ---------- util ---------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function addD(s, n) { var p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n, 12)).toISOString().slice(0, 10); }
  function diffD(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function dv(a, b) { return b ? a / b : NaN; }
  var NV = 18;
  function zero() { var v = []; for (var i = 0; i < NV; i++) v.push(0); return v; }
  function sum(map, dates) { var v = zero(); dates.forEach(function (d) { var x = map[d]; if (x) for (var i = 0; i < NV; i++) v[i] += x[i] || 0; }); return v; }
  /** n hari penuh berakhir kemarin, digeser `skip` hari ke belakang */
  function days(today, n, skip) { var out = []; for (var i = 1 + (skip || 0); i <= n + (skip || 0); i++) out.push(addD(today, -i)); return out; }
  var roas = function (v) { return dv(v[9], v[0]); };
  var cpa = function (v) { return dv(v[0], v[8]); };
  var ctr = function (v) { return dv(v[4], v[1]); };
  function rp(v) { if (!fin(v)) return '–'; var a = Math.abs(v); if (a >= 1e6) return 'Rp' + (v / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace('.', ',') + 'jt'; if (a >= 1e3) return 'Rp' + Math.round(v / 1e3) + 'rb'; return 'Rp' + Math.round(v); }
  function x(v) { return fin(v) ? v.toFixed(2).replace('.', ',') + '×' : '–'; }
  function pct(v) { return fin(v) ? Math.round(Math.abs(v) * 100) + '%' : '–'; }
  function fd(s) { var B = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']; var p = s.split('-'); return +p[2] + ' ' + B[+p[1] - 1]; }
  Brain.util = { addD: addD, diffD: diffD, sum: sum, days: days, roas: roas, cpa: cpa, ctr: ctr };

  /* ---------- sinyal penurunan ---------- */
  /**
   * Bandingkan 3 hari terakhir (berakhir `endSkip` hari sebelum kemarin) dengan rata-rata 14 hari sebelumnya.
   * Sinyal: ROAS turun > 20%, CPA naik > 30%, CTR turun > 20%.
   */
  function declineSignals(map, today, maxCpa, endSkip) {
    var C = Brain.cfg, cur = sum(map, days(today, 3, endSkip)), base = sum(map, days(today, 14, 3 + endSkip)), out = [];
    if (base[0] < maxCpa || cur[0] <= 0) return out;          // baseline terlalu tipis
    var rb = roas(base), rc = roas(cur);
    if (rb > 0 && fin(rc) && rc < rb * (1 - C.decline.roas))
      out.push({ k: 'roas', t: 'ROAS turun ' + pct(rc / rb - 1), d: 'ROAS 3D ' + x(rc) + ' vs rata-rata 14 hari sebelumnya ' + x(rb) });
    var cb = cpa(base), cc = cpa(cur);
    if (fin(cb) && ((fin(cc) && cc > cb * (1 + C.decline.cpa)) || (!cur[8] && cur[0] > cb * (1 + C.decline.cpa))))
      out.push({ k: 'cpa', t: fin(cc) ? 'CPA naik ' + pct(cc / cb - 1) : 'CPA naik (0 purchase)', d: 'CPA 3D ' + (fin(cc) ? rp(cc) : 'tanpa purchase, spend ' + rp(cur[0])) + ' vs ' + rp(cb) });
    var tb = ctr(base), tc = ctr(cur);
    if (tb > 0 && fin(tc) && tc < tb * (1 - C.decline.ctr))
      out.push({ k: 'ctr', t: 'CTR turun ' + pct(tc / tb - 1), d: 'Link CTR 3D ' + (tc * 100).toFixed(2).replace('.', ',') + '% vs ' + (tb * 100).toFixed(2).replace('.', ',') + '%' });
    return out;
  }
  Brain.declineSignals = declineSignals;

  /** hari berturut-turut tanpa purchase (berakhir kemarin, ikut hitung hari ini kalau ada) + spend selama itu */
  function leakStreak(map, today) {
    var n = 0, spend = 0, t = map[today];
    if (t && !t[8]) spend += t[0]; else if (t && t[8]) return { n: 0, spend: 0 };
    for (var i = 1; i <= 60; i++) {
      var v = map[addD(today, -i)];
      if (!v || v[0] <= 0) break;
      if (v[8] > 0) break;
      n++; spend += v[0];
    }
    return { n: n, spend: spend };
  }
  Brain.leakStreak = leakStreak;

  /* ---------- evaluasi satu entitas ---------- */
  /**
   * @param map  {'YYYY-MM-DD': vektor17}  data harian entitas
   * @param ctx  { today, active, age, start, maxCpa, budget, freq7, budgetEvents:[{date,old,nw}], tracking:{level,note} }
   * @return { cls, sev, action, reasons[], signals[], m:{r3,r7,r14,s7,p7,cpa7} }
   */
  Brain.evaluate = function (map, ctx) {
    var C = Brain.cfg, t = ctx.today, mc = ctx.maxCpa || 650000;
    var d3 = sum(map, days(t, 3)), d7 = sum(map, days(t, 7)), d14 = sum(map, days(t, 14));
    var m = { r3: roas(d3), r7: roas(d7), r14: roas(d14), s3: d3[0], s7: d7[0], p7: d7[8], cpa7: cpa(d7), ctr7: ctr(d7) };
    var R = function (v) { return fin(v) ? v : 0; };
    var res = { cls: 'Watchlist', sev: 'none', action: '', reasons: [], signals: [], m: m, tracking: null };

    if (ctx.tracking && ctx.tracking.level === 'bad') res.tracking = ctx.tracking.note;
    if (!ctx.active) { res.cls = 'Nonaktif'; res.action = '—'; res.reasons.push('Tidak sedang berjalan'); return res; }

    // sinyal penurunan + berapa hari bertahan
    var sig = declineSignals(map, t, mc, 0);
    if (fin(ctx.freq7) && ctx.freq7 >= C.decline.freq) sig.push({ k: 'freq', t: 'Frequency ' + ctx.freq7.toFixed(1).replace('.', ','), d: 'Frequency 7D ' + ctx.freq7.toFixed(2).replace('.', ',') + ' ≥ ' + C.decline.freq + ' — audiens mulai jenuh' });
    var persist = 0;
    if (sig.length) { persist = 1; for (var k = 1; k <= 5; k++) { if (declineSignals(map, t, mc, k).length) persist++; else break; } }
    res.signals = sig;
    var severe = R(m.r3) < 1 && d3[0] >= mc;
    res.sev = severe ? 'severe' : (sig.length >= 2 || persist > 3) ? 'confirmed' : sig.length ? 'early' : 'none';
    var sigTxt = sig.map(function (s) { return s.t; }).join(', ');

    var leak = leakStreak(map, t);
    var young = ctx.age != null && ctx.age < C.minAge;

    // 1) bocor: spend besar tanpa purchase → pause candidate, tidak perlu tunggu 3 hari
    if (leak.n >= 1 && leak.spend >= C.leakMult * mc) {
      res.cls = 'Loser'; res.sev = 'severe'; res.action = 'Pause segera';
      res.reasons.push('Spend ' + rp(leak.spend) + ' selama ' + leak.n + ' hari tanpa purchase (≥ ' + String(C.leakMult).replace('.', ',') + '× CPA maks ' + rp(mc) + ')');
      return done(res);
    }
    // 2) masih muda → tunggu (aturan umur minimal)
    if (young) {
      res.cls = 'Tunggu'; res.action = 'Tunggu evaluasi ' + (ctx.start ? fd(addD(ctx.start, C.minAge)) : '');
      res.reasons.push('Umur ' + ctx.age + ' hari (< ' + C.minAge + ' hari), hasil belum valid' + (fin(m.r7) && m.s7 ? ' — ROAS sejauh ini ' + x(m.r7) : ''));
      if (severe) res.reasons.push('Catatan: ROAS 3D ' + x(m.r3) + ' di bawah 1 — pantau ketat');
      return done(res);
    }
    // 3) ROAS jatuh di bawah 1 dengan spend cukup → severe
    if (severe) {
      res.cls = 'Loser'; res.action = 'Pause segera';
      res.reasons.push('ROAS 3D ' + x(m.r3) + ' di bawah 1 dengan spend ' + rp(d3[0]));
      return done(res);
    }
    // 4) data belum cukup
    var enough = (ctx.age == null || ctx.age >= C.minDays) && (m.s7 >= C.dataMult * mc || m.p7 >= C.dataResults);
    if (!enough) {
      res.cls = 'Watchlist'; res.action = 'Belum cukup data';
      res.reasons.push('Spend 7D ' + rp(m.s7) + ' < ' + C.dataMult + '× CPA maks (' + rp(C.dataMult * mc) + ') — belum cukup untuk disimpulkan');
      return done(res);
    }
    // 5) ROAS turun setelah kenaikan budget → kembalikan ke budget sebelumnya
    var inc = (ctx.budgetEvents || []).filter(function (e) { return e.nw > e.old && e.old > 0; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
    if (inc) {
      var ago = diffD(inc.date, t);
      if (ago >= 2 && ago <= 10) {
        var after = [], before = [];
        for (var i = 0; i < ago; i++) after.push(addD(inc.date, i));
        for (var j = 1; j <= 7; j++) before.push(addD(inc.date, -j));
        var ra = roas(sum(map, after)), rb = roas(sum(map, before));
        if (fin(rb) && rb >= C.minRoas && R(ra) < C.minRoas) {
          res.cls = 'Watchlist'; res.sev = res.sev === 'none' ? 'early' : res.sev;
          res.action = 'Kembalikan budget ke ' + rp(inc.old);
          res.reasons.push('Budget naik ' + rp(inc.old) + ' → ' + rp(inc.nw) + ' pada ' + fd(inc.date) + '; ROAS sebelumnya ' + x(rb) + ', sesudahnya ' + x(ra) + '. Turunkan dulu ke level sebelumnya, jangan langsung pause.');
          return done(res);
        }
      }
    }
    var lastIncAgo = inc ? diffD(inc.date, t) : null;

    // 6) Loser: ROAS di bawah cutoff ≥ 3 hari dengan data cukup
    if (R(m.r3) < C.cutoff && R(m.r7) < C.cutoff) {
      res.cls = 'Loser';
      res.action = R(m.r14) < C.cutoff ? 'Pause' : 'Turunkan budget 10%';
      res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' di bawah cutoff ' + x(C.cutoff) + (R(m.r14) < C.cutoff ? ', 14D juga ' + x(m.r14) : ''));
      return done(res);
    }
    // 7) penurunan terkonfirmasi
    if (res.sev === 'confirmed') {
      res.cls = R(m.r7) >= C.minRoas ? 'Watchlist' : 'Loser';
      res.action = 'Turunkan budget 10%';
      res.reasons.push('Penurunan terkonfirmasi: ' + sigTxt + (persist > 1 ? ' (bertahan ' + persist + ' hari)' : ''));
      return done(res);
    }
    // 8) Winner
    var stable = R(m.r3) >= R(m.r7) * 0.85;
    if (R(m.r3) >= C.minRoas && R(m.r7) >= C.minRoas && stable) {
      res.cls = 'Winner';
      var canScale = R(m.r3) >= C.target && R(m.r7) >= C.target;
      if (res.sev === 'early') {
        res.action = 'Pertahankan — early warning';
        res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' ≥ minimum, tapi ada sinyal awal: ' + sigTxt + '. Jangan sentuh budget, cek lagi besok.');
      } else if (canScale && lastIncAgo != null && lastIncAgo < C.scaleEvery) {
        res.action = 'Pertahankan — baru naik ' + lastIncAgo + ' hari lalu';
        res.reasons.push('Layak scale, tapi budget baru dinaikkan ' + fd(inc.date) + '. Tunggu sampai ' + fd(addD(inc.date, C.scaleEvery)) + ' supaya learning tidak ter-reset.');
      } else if (canScale) {
        res.action = 'Naikkan budget 10%';
        var b = ctx.budget;
        res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' ≥ target ' + x(C.target) + ', tren ' + (R(m.r3) > R(m.r7) * 1.05 ? 'naik' : 'stabil') + (b ? '. Budget ' + rp(b) + ' → ' + rp(b * (1 + C.scaleMin)) + (C.scaleMax > C.scaleMin ? '–' + rp(b * (1 + C.scaleMax)) : '') : ''));
      } else {
        res.action = 'Pertahankan';
        res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' ≥ minimum ' + x(C.minRoas) + ', belum mencapai target ' + x(C.target) + ' untuk scale');
      }
      return done(res);
    }
    // 9) Watchlist (sisanya)
    res.cls = 'Watchlist';
    res.action = res.sev === 'early' ? 'Pantau — early warning' : 'Pantau';
    if (R(m.r7) >= C.minRoas && !stable) res.reasons.push('ROAS 7D ' + x(m.r7) + ' masih di atas minimum, tapi 3D melemah ke ' + x(m.r3));
    else if (R(m.r7) >= C.cutoff && R(m.r7) < C.minRoas) res.reasons.push('ROAS 7D ' + x(m.r7) + ' di antara cutoff ' + x(C.cutoff) + ' dan minimum ' + x(C.minRoas));
    else res.reasons.push('ROAS 3D ' + x(m.r3) + ', 7D ' + x(m.r7) + ' — belum konsisten');
    if (sig.length) res.reasons.push('Sinyal awal: ' + sigTxt + ' — cek lagi besok');
    return done(res);

    // tracking bermasalah tidak dimasukkan ke reasons (supaya tidak berulang di setiap baris); UI menampilkan res.tracking sebagai peringatan
    function done(r) { return r; }
  };

  /**
   * Penanda untuk grafik trend: hari-hari di mana ≥ 2 sinyal penurunan muncul bersamaan
   * (atau ROAS 3D < 1). `dates` = tanggal yang ditampilkan di grafik.
   */
  Brain.markers = function (map, dates, maxCpa) {
    var out = [];
    dates.forEach(function (d) {
      var tomorrow = addD(d, 1), s = declineSignals(map, tomorrow, maxCpa || 650000, 0);
      var cur = sum(map, days(tomorrow, 3)), r3 = roas(cur);
      if (s.length >= 2 || (fin(r3) && r3 < 1 && cur[0] >= (maxCpa || 650000))) out.push({ date: d, kinds: s.map(function (z) { return z.t; }), r3: r3 });
    });
    return out;
  };

  /** Ringkasan akun: total per kelas & total spend per kelas (untuk header Papan Keputusan) */
  Brain.summary = function (results) {
    var s = {};
    results.forEach(function (r) { var k = r.cls; s[k] = s[k] || { n: 0, spend: 0 }; s[k].n++; s[k].spend += r.m.s7 || 0; });
    return s;
  };

  /* =====================================================================
   * RULE KONTEN (level iklan) — 5 kasus:
   *  1. jelek tapi masih testing      → test
   *  2. jelek & lewat batas           → kill
   *  3. angka awal bagus, 0 purchase  → diag (≤ 2× CPA maks) lalu tof (pindah ke top funnel)
   *  4. pernah purchase lalu kosong   → hold (wajar) atau refresh (jenuh / lewat batas)
   *  5. winner gagal setelah di-scale → hold (tunggu 3 hari) atau revert (kembalikan budget)
   *  + winner / watch untuk yang sehat, off untuk yang tidak aktif
   * ===================================================================== */
  Brain.RULES = {
    kill:    { label: 'Matikan',              tone: 'r', order: 0, kase: 2 },
    revert:  { label: 'Kembalikan budget',    tone: 'r', order: 1, kase: 5 },
    refresh: { label: 'Refresh / turunkan',   tone: 'y', order: 2, kase: 4 },
    tof:     { label: 'Pindah ke top funnel', tone: 'y', order: 3, kase: 3 },
    diag:    { label: 'Diagnosa funnel',      tone: 'b', order: 4, kase: 3 },
    test:    { label: 'Lanjut test',          tone: 'b', order: 5, kase: 1 },
    hold:    { label: 'Tahan',                tone: 'n', order: 6, kase: null },
    watch:   { label: 'Pantau',               tone: 'y', order: 7, kase: null },
    good:    { label: 'Konten bagus',         tone: 'g', order: 8, kase: null },
    winner:  { label: 'Winner',               tone: 'g', order: 9, kase: null },
    off:     { label: 'Nonaktif',             tone: 'n', order: 10, kase: null }
  };

  /**
   * @param map  {'YYYY-MM-DD': vektor17} data harian iklan (minimal `lookback` hari + hari ini)
   * @param ctx  { today, active, age, maxCpa, freq7, budgetEvents:[{date,old,nw}] (campaign/ad set induk) }
   * @return { key, label, tone, kase, action, reasons[], limit:{used,max,text}|null, m }
   */
  Brain.contentRule = function (map, ctx) {
    var C = Brain.cfg, K = C.content, t = ctx.today, mc = ctx.maxCpa || 650000;
    var all = sum(map, [t].concat(days(t, K.lookback))), d7 = sum(map, days(t, 7));
    var sp = all[0], p = all[8], R = roas(all), ct = ctr(all), lpvR = all[5] ? dv(all[5], all[4]) : NaN;
    var hist = p ? sp / p : NaN, leak = leakStreak(map, t);
    var m = { spend: sp, purch: p, value: all[9], roas: R, ctr: ct, lpvRate: lpvR, ic: all[7], impr: all[1], cpa: hist,
      s7: d7[0], p7: d7[8], r7: roas(d7), streakN: leak.n, streakSpend: leak.spend, age: ctx.age, maxCpa: mc,
      leads: all[17] || 0, cpl: all[17] ? sp / all[17] : NaN, cpaKill: K.cpaKill, cplKill: K.cplKill };
    var leadOn = ctx.leadOn !== false;
    var goodLead = all[1] >= K.earlyImpr && ct >= K.ctrGood && (!all[5] || !(all[4] >= 30) || lpvR >= K.lpvGood);
    var pDays = 0; [t].concat(days(t, K.lookback)).forEach(function (d) { if (map[d] && map[d][8] > 0) pDays++; });
    var proven = p >= K.provenP && R >= C.cutoff,
        winner = p >= K.winP && R >= C.minRoas && pDays >= K.winDays && sp >= K.winSpendMult * mc;
    m.pDays = pDays;
    var young = ctx.age != null && ctx.age < K.minDays;
    m.goodLead = goodLead; m.proven = proven; m.winner = winner;
    var ctrTxt = 'Link CTR ' + (fin(ct) ? (ct * 100).toFixed(2).replace('.', ',') + '%' : '–');
    if (!goodLead && ct >= K.ctrGood && fin(lpvR) && lpvR < K.lpvGood) ctrTxt += ' tapi LPV/klik cuma ' + pct(lpvR) + ' (banyak yang klik tidak sampai ke halaman)';
    else if (!goodLead && all[1] < K.earlyImpr) ctrTxt += ' dari impresi yang masih sedikit';
    var res = { key: 'watch', action: '', reasons: [], limit: null, m: m };
    function out(key, action, code) { var r = Brain.RULES[key]; res.key = key; res.label = r.label; res.tone = r.tone; res.kase = r.kase; res.code = code || null; res.action = (action || r.label) + (code ? ' (' + code + ')' : ''); return res; }
    function lim(used, max, text) { res.limit = { used: used, max: max, text: text }; }
    var mult = function (k) { return String(k).replace('.', ',') + '×'; };

    if (!ctx.active) { res.reasons.push('Iklan tidak sedang berjalan'); return out('off', '—'); }

    // ---- Kasus 5: winner yang gagal setelah budget dinaikkan ----
    var inc = (ctx.budgetEvents || []).filter(function (e) { return e.nw > e.old && e.old > 0 && diffD(e.date, t) >= 0 && diffD(e.date, t) <= K.scaleLook; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
    if (inc) {
      var before = [], after = [], ago = diffD(inc.date, t);
      for (var j = 1; j <= 7; j++) before.push(addD(inc.date, -j));
      for (var i = 0; i <= ago; i++) after.push(addD(inc.date, i));
      var vb = sum(map, before), va = sum(map, after), rb = roas(vb), ra = roas(va);
      if (vb[8] >= 1 && rb >= C.cutoff && !(va[8] > 0 && ra >= C.cutoff)) {
        var ref = vb[0] / vb[8], up = Math.round((inc.nw / inc.old - 1) * 100);
        res.reasons.push('Budget naik ' + rp(inc.old) + ' → ' + rp(inc.nw) + ' (+' + up + '%) pada ' + fd(inc.date) + '. Sebelumnya ROAS ' + x(rb) + ' (' + vb[8] + ' purchase dalam 7 hari), sesudahnya ' + (va[8] ? 'ROAS ' + x(ra) : '0 purchase') + ' dari ' + rp(va[0]) + '.');
        lim(va[0], K.streakMult * ref, 'Spend sejak naik vs ' + mult(K.streakMult) + ' CPA sebelum scale (' + rp(ref) + ')');
        if (ago < K.waitScale && va[0] < K.streakMult * ref) {
          res.reasons.push('Masih dalam masa belajar (' + ago + ' dari ' + K.waitScale + ' hari). Tahan dulu, cek lagi ' + fd(addD(inc.date, K.waitScale)) + '.');
          if (up > 30) res.reasons.push('Kenaikan ' + up + '% lebih dari 30% — rawan reset learning.');
          return out('hold', 'Tahan — tunggu sampai ' + fd(addD(inc.date, K.waitScale)));
        }
        res.reasons.push('Kembalikan ke ' + rp(inc.old) + ', jangan dipause. Kalau pulih, itu batas atas iklan ini di audiens tersebut — scale ke samping: duplikat dengan post ID yang sama ke ad set / audiens baru, atau naikkan bertahap maks 20% tiap 3–4 hari.');
        return out('revert', 'Kembalikan budget ke ' + rp(inc.old));
      }
    }

    // ---- B3: trafik sampah (30 hari, atau 7 hari terakhir) ----
    var junk = ctx.junkLpv || K.junkLpv, j30 = all[5] >= junk && !all[7] && !p, j7 = d7[5] >= junk && !d7[7] && !d7[8];
    if (j30 || j7) {
      var jl = j30 ? all[5] : d7[5];
      res.reasons.push(Math.round(jl).toLocaleString('id-ID') + ' LPV' + (j30 ? '' : ' dalam 7 hari terakhir') + ' tanpa satu pun checkout (batas ' + Math.round(junk) + ' LPV = ' + mult(K.junkMult) + ' LPV yang dibutuhkan untuk 1 purchase). Klik yang datang bukan calon pembeli.');
      res.reasons.push(ctrTxt + '. CTR tinggi di sini justru tanda menarik orang yang cuma penasaran. Matikan sebagai iklan konversi.');
      lim(jl, junk, 'LPV tanpa checkout vs batas trafik sampah');
      return out('kill', 'Matikan — trafik sampah', 'B3');
    }

    // ---- Rulebook v2 · B1 biaya per lead & B1b CPA batas, jendela 3D/7D/14D (termasuk hari ini) ----
    var W = K.sopWin.map(function (n) { var v = sum(map, [t].concat(days(t, n - 1))); return { n: n, sp: v[0], ld: v[17] || 0, p: v[8] }; });
    m.win = W;
    for (var wi = 0; wi < W.length; wi++) {
      var w = W[wi];
      if (w.sp >= K.cpaKill && (!w.p || w.sp / w.p > K.cpaKill)) {
        res.reasons.push('Dalam ' + w.n + ' hari: spend ' + rp(w.sp) + ', ' + (w.p ? w.p + ' purchase (CPA ' + rp(w.sp / w.p) + ')' : '0 purchase') + ' — lewat batas CPA ' + rp(K.cpaKill) + '.');
        lim(w.p ? w.sp / w.p : w.sp, K.cpaKill, 'CPA ' + w.n + 'D vs batas ' + rp(K.cpaKill));
        return out('kill', 'Matikan — CPA lewat batas', 'B1b');
      }
    }
    if (leadOn) for (var wj = 0; wj < W.length; wj++) {
      var u = W[wj];
      if (u.p && u.sp / u.p <= K.cpaKill) continue;            // sudah laku dengan CPA wajar → lead tidak jadi patokan
      if (u.sp >= K.cplKill && (!u.ld || u.sp / u.ld > K.cplKill)) {
        res.reasons.push('Dalam ' + u.n + ' hari: spend ' + rp(u.sp) + ', ' + (u.ld ? u.ld + ' lead (biaya per lead ' + rp(u.sp / u.ld) + ')' : '0 lead') + ' — lewat batas ' + rp(K.cplKill) + ' per lead.');
        lim(u.ld ? u.sp / u.ld : u.sp, K.cplKill, 'Biaya per lead ' + u.n + 'D vs batas ' + rp(K.cplKill));
        return out('kill', 'Matikan — biaya per lead lewat batas', 'B1');
      }
    }

    // ---- Belum pernah purchase ----
    if (!p) {
      if (all[1] >= K.earlyImpr && sp >= K.earlySpend && ct < K.ctrKill) {
        res.reasons.push(ctrTxt + ' setelah ' + Math.round(all[1]).toLocaleString('id-ID') + ' impresi (< ' + (K.ctrKill * 100).toString().replace('.', ',') + '%). Hook tidak menghentikan scroll — menambah spend tidak akan mengubahnya.');
        lim(sp, K.killMult * mc, 'Spend vs batas ' + mult(K.killMult) + ' CPA maks');
        return out('kill', 'Matikan — hook gagal', 'B2');
      }
      lim(sp, K.cpaKill, 'Spend vs batas ' + rp(K.cpaKill) + ' tanpa purchase');
      var cplTxt = leadOn ? (m.leads ? m.leads + ' lead, biaya per lead ' + rp(m.cpl) : '0 lead') : 'lead tidak terlacak di akun ini';
      if (goodLead) {
        res.reasons.push(ctrTxt + ' bagus' + (fin(lpvR) ? ', LPV/klik ' + pct(lpvR) : '') + ', ' + cplTxt + ', tapi belum ada purchase dari ' + rp(sp) + '. Batas matikan: ' + rp(K.cpaKill) + ' tanpa purchase.');
        if (all[7] > 0) res.reasons.push('Sudah ada ' + all[7] + ' initiate checkout → cek proses checkout / pembayaran / tracking. Cocokkan dengan order di backend.');
        else res.reasons.push('Belum ada initiate checkout → janji di iklan tidak nyambung dengan landing page, atau menarik orang yang cuma penasaran.');
        return out('diag');
      }
      res.reasons.push('Spend ' + rp(sp) + (young ? ', umur ' + ctx.age + ' hari' : '') + ', ' + cplTxt + ' — masih dites. Matikan kalau biaya per lead > ' + rp(K.cplKill) + ' (setelah spend ' + rp(K.cplKill) + ') atau spend ' + rp(K.cpaKill) + ' tanpa purchase.');
      if (sp < 50000 && ctx.age >= 3) res.reasons.push('Hampir tidak dapat budget — di ASC/CBO berarti belum benar-benar dites, bukan jelek.');
      return out('test');
    }

    // ---- Ada purchase tapi belum terbukti ----
    if (!proven) {
      if (leak.n && leak.spend >= K.cpaKill) {
        res.reasons.push(p + ' purchase dalam ' + K.lookback + ' hari (ROAS ' + x(R) + '), lalu ' + rp(leak.spend) + ' selama ' + leak.n + ' hari tanpa purchase (≥ batas ' + rp(K.cpaKill) + ').');
        lim(leak.spend, K.cpaKill, 'Spend sejak purchase terakhir vs ' + rp(K.cpaKill));
        return out('kill', 'Matikan — CPA lewat batas', 'B1b');
      }
      if (p >= K.goodP && hist <= K.cpaKill && (!leadOn || !(m.cpl > K.cplKill))) {
        res.reasons.push(p + ' purchase, CPA ' + rp(hist) + ' (≤ ' + rp(K.cpaKill) + ')' + (leadOn && m.leads ? ', biaya per lead ' + rp(m.cpl) : '') + ' — konten bagus. Kandidat dipindah ke campaign ASC.');
        res.reasons.push('Belum winner: perlu ≥ ' + K.winP + ' purchase di ≥ ' + K.winDays + ' hari berbeda dengan ROAS ≥ ' + x(C.minRoas) + '.');
        lim(sp, K.cpaKill * Math.max(1, p), 'Spend vs batas CPA ' + rp(K.cpaKill) + ' × purchase');
        return out('good', 'Konten bagus — kandidat ASC');
      }
      res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' dari ' + rp(sp) + ' — belum terbukti (perlu ≥ ' + K.provenP + ' purchase & ROAS ≥ ' + x(C.cutoff) + ').');
      lim(sp, K.lossMult * mc, 'Spend vs batas rugi ' + mult(K.lossMult) + ' CPA maks');
      return out('test');
    }

    // ---- Kasus 4: terbukti, tapi beberapa hari kosong / melemah ----
    var sig = declineSignals(map, t, mc, 0);
    if (fin(ctx.freq7) && ctx.freq7 >= C.decline.freq) sig.push({ k: 'freq', t: 'Frequency ' + ctx.freq7.toFixed(1).replace('.', ',') });
    var sigTxt = sig.map(function (s) { return s.t; }).join(', ');
    var cap = K.streakMult * hist;
    var weak7 = d7[0] >= cap && roas(d7) < 1;
    if ((leak.n && leak.spend > 0) || weak7) {
      var exp = leak.spend / hist;
      lim(weak7 && !(leak.spend >= cap) ? d7[0] : leak.spend, cap, (weak7 && !(leak.spend >= cap) ? 'Spend 7D' : 'Spend selama kosong') + ' vs ' + mult(K.streakMult) + ' CPA historis (' + rp(hist) + ')');
      if (!weak7 && leak.spend < cap) {
        res.reasons.push(p + ' purchase dalam ' + K.lookback + ' hari (CPA ' + rp(hist) + '). Kosong ' + leak.n + ' hari dengan spend ' + rp(leak.spend) + ' — secara hitungan baru "jatah" ' + exp.toFixed(1).replace('.', ',') + ' purchase, masih wajar.');
        if (sig.length) res.reasons.push('Ada sinyal awal: ' + sigTxt + ' — cek lagi besok.');
        return out('hold', 'Tahan — masih wajar');
      }
      res.reasons.push(weak7 ? 'ROAS 7D ' + x(roas(d7)) + ' dari ' + rp(d7[0]) + ' (' + d7[8] + ' purchase), padahal ' + K.lookback + ' hari ROAS ' + x(R) + '.'
        : 'Kosong ' + leak.n + ' hari dengan spend ' + rp(leak.spend) + ' (≥ ' + mult(K.streakMult) + ' CPA historis ' + rp(hist) + ') — bukan kebetulan lagi.');
      if (sig.length) {
        res.reasons.push('Tanda jenuh: ' + sigTxt + '. Turunkan budget 10% dan buat versi baru dengan hook 3 detik pertama yang baru (body tetap) — jangan dihapus.');
        return out('refresh', 'Refresh hook + turunkan 10%');
      }
      res.reasons.push('Tidak ada tanda jenuh yang jelas. Turunkan budget 10%, lalu cek faktor luar di Change Log: edit iklan, landing page, stok, promo kompetitor, tanggal gajian.');
      return out('refresh', 'Turunkan 10% & cek faktor luar');
    }

    // ---- Sehat ----
    if (winner) {
      var scale = d7[8] >= 1 && roas(d7) >= C.target && R >= C.target;
      res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' (' + K.lookback + ' hari), 7D ' + x(roas(d7)) + '.');
      if (scale) res.reasons.push('Layak scale: naikkan budget induknya 10% saat ROAS 3D & 7D ≥ ' + x(C.minRoas) + ' (evaluasi tiap 3 hari), atau pindahkan ke campaign ASC dengan post ID yang sama.');
      else res.reasons.push('Pertahankan. Cocok dipakai ulang di campaign retargeting / bottom funnel dengan post ID yang sama.');
      return out('winner', scale ? 'Winner — layak scale' : 'Winner — pertahankan');
    }
    if (R >= C.minRoas) res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' — bagus, tapi belum memenuhi syarat winner (≥ ' + K.winP + ' purchase di ≥ ' + K.winDays + ' hari berbeda, spend ≥ ' + mult(K.winSpendMult) + ' CPA maks = ' + rp(K.winSpendMult * mc) + '). Sekarang ' + p + ' purchase di ' + pDays + ' hari, spend ' + rp(sp) + '. Lanjutkan, jangan dipindah dulu.');
    else res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' — di antara cutoff ' + x(C.cutoff) + ' dan minimum ' + x(C.minRoas) + '. Jangan naikkan budget.');
    if (sig.length) res.reasons.push('Sinyal awal: ' + sigTxt + '.');
    if (hist <= K.cpaKill && (!leadOn || !(m.cpl > K.cplKill))) { res.reasons.push('CPA ' + rp(hist) + ' ≤ ' + rp(K.cpaKill) + ' — konten bagus, kandidat ASC.'); return out('good', 'Konten bagus — kandidat ASC'); }
    return out('watch');
  };

  /**
   * Blackhole level campaign / ad set (rulebook B4 & B7).
   * ctx: { today, active, maxCpa, lookback? } · map berisi minimal 30 hari + hari ini.
   * @return null | { code, text, spend, days, limit }
   */
  Brain.blackholeEntity = function (map, ctx) {
    if (!ctx.active) return null;
    var K = Brain.cfg.content, t = ctx.today, mc = ctx.maxCpa || 650000;
    var leak = leakStreak(map, t); if (!leak.n || !(leak.spend > 0)) return null;
    var hist = sum(map, days(t, 30)), cpaH = hist[8] ? hist[0] / hist[8] : mc;
    if (leak.n >= K.zeroDays) return { code: 'B7', days: leak.n, spend: leak.spend, limit: K.zeroDays,
      text: '0 purchase ' + leak.n + ' hari berturut-turut (' + rp(leak.spend) + '). Campaign lewat masanya — matikan.' };
    var lim = K.zeroMult * Math.min(cpaH, mc * 1.5);
    if (leak.n >= 2 && leak.spend >= lim) return { code: 'B4', days: leak.n, spend: leak.spend, limit: lim,
      text: 'Kosong ' + leak.n + ' hari dengan spend ' + rp(leak.spend) + ' (≥ ' + String(K.zeroMult).replace('.', ',') + '× CPA historis ' + rp(cpaH) + '). Matikan atau rombak.' };
    return null;
  };
  /** B5 penempatan & B6 segmen. v = [spend, impresi, checkout, purchase, nilai] */
  Brain.blackholePlacement = function (v, mc) { var K = Brain.cfg.content; return v && v[0] >= K.placeMult * mc && !v[2] && !v[3]; };
  Brain.blackholeSegment = function (v, mc) { var K = Brain.cfg.content; return v && v[0] >= K.segMult * mc && v[3] <= 1; };

  /* =====================================================================
   * Rulebook v2 · SOP budget campaign Testing & ASC
   * ===================================================================== */
  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
  Brain.sopType = function (name) { var n = String(name || ''); if (/testing/i.test(n)) return 'testing'; if (/\basc\b/i.test(n)) return 'asc'; return null; };
  /** tanggal di awal nama campaign: "11Nov26 Testing …", "9 Oct testing 27", "18Aug26 ASC 3" */
  Brain.nameDate = function (name, today) {
    var m = String(name || '').match(/^\s*(\d{1,2})\s*([A-Za-z]{3,})\s*'?(\d{2,4})?/); if (!m) return null;
    var mo = MON[m[2].slice(0, 3).toLowerCase()]; if (!mo) return null;
    var dd = +m[1], ty = +String(today).slice(0, 4), y = m[3] ? +m[3] : ty; if (y < 100) y += 2000;
    var s = y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + dd).slice(-2);
    if (!m[3] && s > today) s = (y - 1) + s.slice(4);
    return dd >= 1 && dd <= 31 ? s : null;
  };
  /**
   * @param map {'YYYY-MM-DD': vektor} data harian campaign
   * @param ctx { today, name, start, active, budget, budgetEvents:[{date,old,nw}] }
   * @return null (bukan campaign SOP) | { type, day, start, act, label, tone, newBudget, reasons[], next, m }
   */
  Brain.campaignSop = function (map, ctx) {
    var type = Brain.sopType(ctx.name); if (!type) return null;
    var C = Brain.cfg, K = C.content, t = ctx.today, y = addD(t, -1);
    var start = Brain.nameDate(ctx.name, t) || ctx.start || null, day = start ? diffD(start, t) + 1 : null;
    var v3 = sum(map, days(t, 3)), v7 = sum(map, days(t, 7)), r3 = roas(v3), r7 = roas(v7);
    var z = 0; for (var i = 1; i <= 60; i++) { var v = map[addD(t, -i)]; if (!v || v[0] <= 0 || v[8] > 0) break; z++; }
    var ev = (ctx.budgetEvents || []).slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var lastUp = ev.filter(function (e) { return e.nw > e.old; })[0], lastDown = ev.filter(function (e) { return e.nw < e.old; })[0];
    var bud = ctx.budget, m = { r3: r3, r7: r7, s3: v3[0], s7: v7[0], p3: v3[8], p7: v7[8], z: z, lastUp: lastUp && lastUp.date, lastDown: lastDown && lastDown.date };
    if (type === 'asc') day = null;
    var res = { type: type, day: day, start: start, act: 'hold', reasons: [], m: m, next: null, newBudget: null };
    var L = { wait: ['Tunggu', 'b'], up: ['Naik ' + Math.round(K.stepUp * 100) + '%', 'g'], down: ['Turun ' + Math.round(K.stepDown * 100) + '%', 'y'], kill: ['Matikan', 'r'], hold: ['Tahan', 'n'], off: ['Nonaktif', 'n'] };
    function out(a) { res.act = a; res.label = L[a][0]; res.tone = L[a][1]; return res; }
    var rTxt = 'ROAS 3D ' + x(r3) + ' (' + v3[8] + ' purchase) · 7D ' + x(r7) + ' (' + v7[8] + ' purchase)';
    if (!ctx.active) { res.reasons.push('Campaign tidak berjalan.'); return out('off'); }
    var isEval = type === 'testing' ? (day != null && (K.evalDays.indexOf(day) >= 0 || (day > K.killDay && (day - K.killDay) % K.evalEvery === 0)))
      : (!ev[0] || diffD(ev[0].date, t) >= K.evalEvery);
    if (type === 'testing' && day != null) {
      var nx = K.evalDays.filter(function (d) { return d > day; })[0]; if (nx == null) nx = day + (K.evalEvery - (day - K.killDay) % K.evalEvery);
      res.next = addD(start, nx - 1);
    } else res.next = ev[0] ? addD(ev[0].date, K.evalEvery) : null;
    // matikan: 3 hari tanpa purchase setelah dipotong, atau 6 hari kosong beruntun
    var sinceCut = lastDown ? diffD(lastDown.date, y) + 1 : 0;
    if ((lastDown && sinceCut >= K.zeroCut && z >= sinceCut) || z >= 2 * K.zeroCut) {
      res.reasons.push(z + ' hari berturut-turut tanpa purchase' + (lastDown ? ', termasuk ' + sinceCut + ' hari setelah budget dipotong (' + fd(lastDown.date) + ')' : '') + '. Campaign jelek — matikan.');
      res.reasons.push('Pindahkan konten bagus di campaign ini ke ASC sebelum dimatikan.');
      return out('kill');
    }
    if (z >= K.zeroCut && !(lastDown && diffD(lastDown.date, t) <= K.zeroCut)) {
      res.newBudget = bud ? Math.round(bud * (1 - K.stepDown) / 1000) * 1000 : null;
      res.reasons.push(z + ' hari berturut-turut tanpa purchase. Turunkan budget ' + Math.round(K.stepDown * 100) + '%' + (bud ? ' (' + rp(bud) + ' → ' + rp(res.newBudget) + ')' : '') + '. Kalau ' + K.zeroCut + ' hari lagi tetap kosong → matikan.');
      return out('down');
    }
    if (type === 'testing' && day != null && day < K.evalDays[0]) {
      res.reasons.push('Hari ke-' + day + '. Biarkan dulu — evaluasi budget pertama hari ke-' + K.evalDays[0] + ' (' + fd(addD(start, K.evalDays[0] - 1)) + '). Aturan per video tetap jalan.');
      return out('wait');
    }
    var good = v3[8] >= 1 && r3 >= C.minRoas && r7 >= C.minRoas;
    if (good && isEval && !(lastUp && diffD(lastUp.date, t) < 2)) {
      res.newBudget = bud ? Math.round(bud * (1 + K.stepUp) / 1000) * 1000 : null;
      res.reasons.push(rTxt + ' — keduanya ≥ ' + x(C.minRoas) + '. Naikkan budget ' + Math.round(K.stepUp * 100) + '%' + (bud ? ' (' + rp(bud) + ' → ' + rp(res.newBudget) + ')' : '') + '.');
      return out('up');
    }
    if (good) res.reasons.push(rTxt + ' — bagus, tapi hari ini bukan jadwal evaluasi' + (res.next ? ' (berikutnya ' + fd(res.next) + ')' : '') + '. Tahan.');
    else if (type === 'testing' && day != null && day >= K.killDay) res.reasons.push(rTxt + '. Hari ke-' + day + ' — campaign belum memenuhi syarat naik. Tahan selama masih ada purchase; konten bagus bisa mulai dipindah ke ASC.');
    else res.reasons.push(rTxt + '. Belum memenuhi syarat naik (ROAS 3D & 7D ≥ ' + x(C.minRoas) + ')' + (z ? ', ' + z + ' hari terakhir tanpa purchase' : '') + '. Tahan.');
    return out('hold');
  };

  Brain.CLASS_ORDER = { Loser: 0, Watchlist: 1, Winner: 2, Tunggu: 3, Nonaktif: 4 };
  Brain.SEV_ORDER = { severe: 0, confirmed: 1, early: 2, none: 3 };

  root.Brain = Brain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Brain;
})(typeof window !== 'undefined' ? window : this);
