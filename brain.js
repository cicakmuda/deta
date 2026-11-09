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
    scaleMin: 0.20, scaleMax: 0.30, scaleEvery: 3,  // naik 20–30% maksimal tiap 3–4 hari
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
      scaleLook: 10      // kenaikan budget yang masih dianggap "baru" (hari)
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
  function zero() { var v = []; for (var i = 0; i < 17; i++) v.push(0); return v; }
  function sum(map, dates) { var v = zero(); dates.forEach(function (d) { var x = map[d]; if (x) for (var i = 0; i < 17; i++) v[i] += x[i]; }); return v; }
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
      res.action = R(m.r14) < C.cutoff ? 'Pause' : 'Turunkan budget 20–30%';
      res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' di bawah cutoff ' + x(C.cutoff) + (R(m.r14) < C.cutoff ? ', 14D juga ' + x(m.r14) : ''));
      return done(res);
    }
    // 7) penurunan terkonfirmasi
    if (res.sev === 'confirmed') {
      res.cls = R(m.r7) >= C.minRoas ? 'Watchlist' : 'Loser';
      res.action = 'Turunkan budget 20–30%';
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
        res.action = 'Naikkan budget 20–30%';
        var b = ctx.budget;
        res.reasons.push('ROAS 3D ' + x(m.r3) + ' & 7D ' + x(m.r7) + ' ≥ target ' + x(C.target) + ', tren ' + (R(m.r3) > R(m.r7) * 1.05 ? 'naik' : 'stabil') + (b ? '. Budget ' + rp(b) + ' → ' + rp(b * (1 + C.scaleMin)) + '–' + rp(b * (1 + C.scaleMax)) : ''));
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
    winner:  { label: 'Winner',               tone: 'g', order: 8, kase: null },
    off:     { label: 'Nonaktif',             tone: 'n', order: 9, kase: null }
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
      s7: d7[0], p7: d7[8], r7: roas(d7), streakN: leak.n, streakSpend: leak.spend, age: ctx.age, maxCpa: mc };
    var goodLead = all[1] >= K.earlyImpr && ct >= K.ctrGood && (!all[5] || !(all[4] >= 30) || lpvR >= K.lpvGood);
    var proven = p >= K.provenP && R >= C.cutoff, winner = p >= K.winP && R >= C.minRoas;
    var young = ctx.age != null && ctx.age < K.minDays;
    m.goodLead = goodLead; m.proven = proven; m.winner = winner;
    var ctrTxt = 'Link CTR ' + (fin(ct) ? (ct * 100).toFixed(2).replace('.', ',') + '%' : '–');
    if (!goodLead && ct >= K.ctrGood && fin(lpvR) && lpvR < K.lpvGood) ctrTxt += ' tapi LPV/klik cuma ' + pct(lpvR) + ' (banyak yang klik tidak sampai ke halaman)';
    else if (!goodLead && all[1] < K.earlyImpr) ctrTxt += ' dari impresi yang masih sedikit';
    var res = { key: 'watch', action: '', reasons: [], limit: null, m: m };
    function out(key, action) { var r = Brain.RULES[key]; res.key = key; res.label = r.label; res.tone = r.tone; res.kase = r.kase; res.action = action || r.label; return res; }
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

    // ---- Kasus 2: laku tapi rugi (ROAS di bawah cutoff dengan spend besar) ----
    if (sp >= K.lossMult * mc && R < C.cutoff) {
      res.reasons.push('Spend ' + rp(sp) + ' (≥ ' + mult(K.lossMult) + ' CPA maks ' + rp(mc) + ') dengan ' + p + ' purchase, ROAS ' + x(R) + ' di bawah cutoff ' + x(C.cutoff) + '.');
      lim(sp, K.lossMult * mc, 'Spend vs batas rugi ' + mult(K.lossMult) + ' CPA maks');
      if (goodLead) {
        res.reasons.push(ctrTxt + ' kuat: perhatiannya dapat, niat belinya tidak. Matikan sebagai iklan konversi, pakai sebagai top funnel budget kecil untuk mengisi audiens retargeting.');
        return out('tof');
      }
      return out('kill', 'Matikan — laku tapi rugi');
    }

    // ---- Belum pernah purchase ----
    if (!p) {
      if (all[1] >= K.earlyImpr && sp >= K.earlySpend && ct < K.ctrKill) {
        res.reasons.push(ctrTxt + ' setelah ' + Math.round(all[1]).toLocaleString('id-ID') + ' impresi (< ' + (K.ctrKill * 100).toString().replace('.', ',') + '%). Hook tidak menghentikan scroll — menambah spend tidak akan mengubahnya.');
        lim(sp, K.killMult * mc, 'Spend vs batas ' + mult(K.killMult) + ' CPA maks');
        return out('kill', 'Matikan — hook gagal');
      }
      if (goodLead) {
        lim(sp, K.tofMult * mc, 'Spend vs batas ' + mult(K.tofMult) + ' CPA maks (konten bagus)');
        if (sp >= K.tofMult * mc) {
          res.reasons.push(ctrTxt + ' bagus, tapi spend ' + rp(sp) + ' (≥ ' + mult(K.tofMult) + ' CPA maks) tanpa purchase.');
          res.reasons.push('Jangan dibuang: pindahkan ke top funnel (budget kecil) untuk mengisi audiens retargeting; tugas closing diserahkan ke konten bottom funnel.');
          return out('tof');
        }
        res.reasons.push(ctrTxt + ' bagus' + (fin(lpvR) ? ', LPV/klik ' + pct(lpvR) : '') + ', tapi belum ada purchase dari ' + rp(sp) + '. Sisa jatah sebelum dipindah: ' + rp(K.tofMult * mc - sp) + '.');
        if (all[7] > 0) res.reasons.push('Sudah ada ' + all[7] + ' initiate checkout → cek proses checkout / pembayaran / tracking. Cocokkan dengan order di backend.');
        else res.reasons.push('Belum ada initiate checkout → janji di iklan tidak nyambung dengan landing page, atau menarik orang yang cuma penasaran. Perbaiki copy supaya menyaring (sebut harga / siapa yang cocok).');
        return out('diag');
      }
      lim(sp, K.killMult * mc, 'Spend vs batas ' + mult(K.killMult) + ' CPA maks');
      if (sp >= K.killMult * mc) {
        res.reasons.push('Spend ' + rp(sp) + ' tanpa purchase (≥ ' + mult(K.killMult) + ' CPA maks ' + rp(mc) + '), dan angka awalnya tidak menolong (' + ctrTxt + ').');
        return out('kill');
      }
      if (sp >= K.testMult * mc && !young) {
        res.reasons.push('Spend ' + rp(sp) + ' sudah lewat 1× CPA maks tanpa purchase. Sisa ' + rp(K.killMult * mc - sp) + ' sebelum batas matikan.');
        return out('test', 'Lanjut test — batas akhir');
      }
      res.reasons.push('Spend ' + rp(sp) + (young ? ', umur ' + ctx.age + ' hari' : '') + ' — belum cukup untuk dinilai (batas 1× CPA maks ' + rp(mc) + ').');
      if (sp < 50000 && ctx.age >= 3) res.reasons.push('Hampir tidak dapat budget — di ASC/CBO berarti belum benar-benar dites, bukan jelek.');
      return out('test');
    }

    // ---- Ada purchase tapi belum terbukti ----
    if (!proven) {
      if (leak.n && leak.spend >= K.killMult * mc) {
        res.reasons.push(p + ' purchase dalam ' + K.lookback + ' hari (ROAS ' + x(R) + '), lalu ' + rp(leak.spend) + ' selama ' + leak.n + ' hari tanpa purchase (≥ ' + mult(K.killMult) + ' CPA maks).');
        lim(leak.spend, K.killMult * mc, 'Spend sejak purchase terakhir vs ' + mult(K.killMult) + ' CPA maks');
        return out('kill');
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
        res.reasons.push('Tanda jenuh: ' + sigTxt + '. Turunkan budget 20–30% dan buat versi baru dengan hook 3 detik pertama yang baru (body tetap) — jangan dihapus.');
        return out('refresh', 'Refresh hook + turunkan 20–30%');
      }
      res.reasons.push('Tidak ada tanda jenuh yang jelas. Turunkan budget 20–30%, lalu cek faktor luar di Change Log: edit iklan, landing page, stok, promo kompetitor, tanggal gajian.');
      return out('refresh', 'Turunkan 20–30% & cek faktor luar');
    }

    // ---- Sehat ----
    if (winner) {
      var scale = d7[8] >= 1 && roas(d7) >= C.target && R >= C.target;
      res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' (' + K.lookback + ' hari), 7D ' + x(roas(d7)) + '.');
      if (scale) res.reasons.push('Layak scale: naikkan budget induknya maks 20–30% tiap 3–4 hari, atau duplikat dengan post ID yang sama ke audiens baru. Kandidat bagus untuk bottom funnel.');
      else res.reasons.push('Pertahankan. Cocok dipakai ulang di campaign retargeting / bottom funnel dengan post ID yang sama.');
      return out('winner', scale ? 'Winner — layak scale' : 'Winner — pertahankan');
    }
    res.reasons.push(p + ' purchase, ROAS ' + x(R) + ' — di antara cutoff ' + x(C.cutoff) + ' dan minimum ' + x(C.minRoas) + '. Jangan naikkan budget.');
    if (sig.length) res.reasons.push('Sinyal awal: ' + sigTxt + '.');
    return out('watch');
  };

  Brain.CLASS_ORDER = { Loser: 0, Watchlist: 1, Winner: 2, Tunggu: 3, Nonaktif: 4 };
  Brain.SEV_ORDER = { severe: 0, confirmed: 1, early: 2, none: 3 };

  root.Brain = Brain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Brain;
})(typeof window !== 'undefined' ? window : this);
