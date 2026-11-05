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
    scaleMin: 0.20, scaleMax: 0.30, scaleEvery: 3   // naik 20–30% maksimal tiap 3–4 hari
  };
  Brain.cfg = clone(Brain.defaults);
  Brain.setConfig = function (o) { Brain.cfg = Object.assign(clone(Brain.defaults), o || {}); return Brain.cfg; };

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

  Brain.CLASS_ORDER = { Loser: 0, Watchlist: 1, Winner: 2, Tunggu: 3, Nonaktif: 4 };
  Brain.SEV_ORDER = { severe: 0, confirmed: 1, early: 2, none: 3 };

  root.Brain = Brain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Brain;
})(typeof window !== 'undefined' ? window : this);
