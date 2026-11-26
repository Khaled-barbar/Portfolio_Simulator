/* Portfolio Simulator — in-browser engine.
 * A JavaScript port of the Agents Lab Python backend (prices, portfolios, investors, AI sessions,
 * Brier scoring, prompts, report). It answers the same "/api/..." requests the dashboard makes,
 * so the page works on any static host:
 *   - prices: data/index.json + data/prices/<ticker>.json, rebuilt every day by a GitHub Action
 *   - your data (portfolios, AI replies, follow dates, snapshots): this browser's localStorage,
 *     with backup / restore / import from the desktop app's lab.db
 */
"use strict";
const Engine = (() => {
  const DBKEY = "ps_db_v1";
  const SUBUNITS = { GBp: ["GBP", 0.01], GBX: ["GBP", 0.01], ZAc: ["ZAR", 0.01], ILA: ["ILS", 0.01] };
  const CAD_SUFFIXES = [".TO", ".V", ".NE", ".CN"];
  const TICKER_RE = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
  const NAIVE_BRIER = 0.25;
  const STOCKS_DEFAULTS = {
    enabled: true, benchmark: "XEQT.TO", compare: ["SPY", "XIU.TO"], min_picks: 5, max_picks: 15,
    max_weight: 0.25, fx_fee: 0.015, horizons_days: [30, 90, 180], min_forecasts_per_agent: 9,
    question: "", core_forecasts: [],
  };

  let CONFIG = null, SEED = null, DB = null;
  let INDEX = { updated: null, last_close: null, tickers: {} };
  const PRICES = {}; // ticker -> {d:[], a:[], r:[]} | null (not in the database)

  // ------------------------------------------------------------------ dates
  const pad = n => String(n).padStart(2, "0");
  const isoUTC = d => d.toISOString().slice(0, 10);
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const nowISO = () => { const d = new Date(); return `${today()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoUTC(d); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
  function validDate(s) {
    s = String(s || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + "T00:00:00Z"))) throw new Error(`invalid date: ${s}`);
    return s;
  }
  function businessDays(s, e) {
    const out = [], end = Date.parse(e + "T00:00:00Z"), d = new Date(s + "T00:00:00Z");
    while (+d <= end) { const w = d.getUTCDay(); if (w > 0 && w < 6) out.push(isoUTC(d)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  }
  const minStr = (a, b) => (a < b ? a : b);

  // ------------------------------------------------------------------ numbers (Python-like)
  function toF(x) {
    if (x === null || x === undefined || x === "" || typeof x === "boolean") throw new TypeError(`not a number: ${x}`);
    const v = Number(x);
    if (!isFinite(v)) throw new TypeError(`not a number: ${x}`);
    return v;
  }
  const fmtPct = (v, d) => (v * 100).toFixed(d) + "%";
  const fmtSPct = (v, d) => (v >= 0 ? "+" : "-") + Math.abs(v * 100).toFixed(d) + "%";
  // json.dumps with Python's separators (prompts must stay identical to the desktop app)
  function pyDumps(v, key) {
    if (Array.isArray(v)) return "[" + v.map(x => pyDumps(x)).join(", ") + "]";
    if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ": " + pyDumps(x, k)).join(", ") + "}";
    if (typeof v === "number" && key === "threshold" && Number.isInteger(v)) return v.toFixed(1);
    return JSON.stringify(v);
  }

  // ------------------------------------------------------------------ storage
  function emptyDb() {
    return { v: 1, next: 1, sessions: [], responses: [], allocations: [], forecasts: [], investors: {},
      holdings: [], seeded: [], portfolios: [], transactions: [], inbox: [], log: [], missing: [] };
  }
  function loadDb() {
    let d = null;
    try { const s = localStorage.getItem(DBKEY); d = s ? JSON.parse(s) : null; } catch (e) { d = null; }
    DB = Object.assign(emptyDb(), d || {});
  }
  function save() {
    try { localStorage.setItem(DBKEY, JSON.stringify(DB)); }
    catch (e) { throw new Error("could not save in this browser's storage (full or blocked): " + e.message); }
  }
  const nid = () => DB.next++;
  function log(m) { DB.log.push(`${nowISO().replace("T", " ")}  ${m}`); if (DB.log.length > 600) DB.log = DB.log.slice(-500); }
  function noteMissing(t) { if (t && t !== "CASH" && !DB.missing.includes(t)) DB.missing.push(t); }

  function seed() {
    if (!SEED || DB.seeded.includes(SEED.as_of)) return;
    for (const i of SEED.investors) {
      if (!DB.investors[i.id]) DB.investors[i.id] = { follow_date: SEED.as_of, active: 1 };
      if (!DB.holdings.some(h => h.investor_id === i.id && h.as_of === SEED.as_of))
        for (const h of i.holdings)
          DB.holdings.push({ investor_id: i.id, as_of: SEED.as_of, ticker: h.ticker, weight: h.weight,
            estimated: h.estimated ? 1 : 0, source: SEED.source });
    }
    DB.seeded.push(SEED.as_of);
    save();
  }

  // ------------------------------------------------------------------ prices
  const fname = t => t.replace(/[^A-Za-z0-9.\-]/g, c => "_" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  function rawCurrency(t) {
    if (t === "CASH") return "CAD";
    const m = INDEX.tickers[t];
    return m && m.c ? m.c : (CAD_SUFFIXES.some(s => t.endsWith(s)) ? "CAD" : "USD");
  }
  function currencyOf(t) { const c = rawCurrency(t); return SUBUNITS[c] || [c.toUpperCase(), 1.0]; }
  const fxTicker = cur => (cur === "CAD" ? null : `${cur}CAD=X`);

  async function loadOne(t) {
    if (t === "CASH" || t in PRICES) return;
    if (!INDEX.tickers[t]) { PRICES[t] = null; return; } // not in the price database: no file to fetch
    try {
      const r = await fetch(`data/prices/${encodeURIComponent(fname(t))}.json?v=${encodeURIComponent(INDEX.updated || "0")}`);
      if (!r.ok) { PRICES[t] = null; return; }
      const j = await r.json();
      const d = new Array(j.g.length);
      let cur = new Date(j.s + "T00:00:00Z");
      for (let i = 0; i < j.g.length; i++) { cur.setUTCDate(cur.getUTCDate() + j.g[i]); d[i] = isoUTC(cur); }
      PRICES[t] = { d, a: j.a, r: j.r || j.a };
    } catch (e) { PRICES[t] = null; }
  }
  async function loadPrices(list) {
    const ts = [...new Set(list.filter(t => t && t !== "CASH"))];
    await Promise.all(ts.map(loadOne));
    const fx = [...new Set(ts.map(t => fxTicker(currencyOf(t)[0])).filter(Boolean))];
    await Promise.all(fx.map(loadOne));
  }
  const has = t => t === "CASH" || !!PRICES[t];
  function missingMsg(t) {
    return `${t}: not in this site's price database. Add it to scripts/tickers.txt in the GitHub repository ` +
      `(System → Data has the link), then publish prices from your computer again.`;
  }
  async function ensure(t) {
    t = String(t || "").trim().toUpperCase();
    if (!t) throw new Error("ticker is required");
    if (t === "CASH") return t;
    await loadPrices([t]);
    if (!PRICES[t]) { noteMissing(t); save(); throw new Error(missingMsg(t)); }
    return t;
  }

  function bisectRight(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < arr[m]) hi = m; else lo = m + 1; } return lo; }
  function bisectLeft(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  const series = t => PRICES[t] || { d: [], a: [], r: [] };

  function priceOnOrAfter(t, d) { const s = series(t), i = bisectLeft(s.d, d); return i < s.d.length ? [s.d[i], s.a[i]] : null; }
  function priceOnOrBefore(t, d) { const s = series(t), i = bisectRight(s.d, d) - 1; return i >= 0 ? [s.d[i], s.a[i]] : null; }
  function totalReturn(t, start, end, final = false) {
    if (t === "CASH") return 0.0;
    const a = priceOnOrAfter(t, start), b = priceOnOrBefore(t, end);
    if (!a || !b || b[0] <= a[0]) return null;
    if (final && !priceOnOrAfter(t, end)) return null;
    if (daysBetween(b[0], end) > 5) return null;
    return b[1] / a[1] - 1;
  }

  class Book {
    constructor() { this._cur = {}; }
    firstDate(t) { if (t === "CASH") return "1900-01-01"; const d = series(t).d; return d.length ? d[0] : null; }
    lastDate(t) { if (t === "CASH") return null; const d = series(t).d; return d.length ? d[d.length - 1] : null; }
    _at(t, d, col) { const s = series(t), i = bisectRight(s.d, d) - 1; if (i < 0) return null; return (col === 1 ? s.a : s.r)[i]; }
    adj(t, d) { return t === "CASH" ? 1.0 : this._at(t, d, 1); }
    raw(t, d) { return t === "CASH" ? 1.0 : this._at(t, d, 2); }
    currency(t) { if (!(t in this._cur)) this._cur[t] = currencyOf(t); return this._cur[t]; }
    fx(t, d) {
      const [cur, mult] = this.currency(t);
      if (cur === "CAD") return mult;
      let r = this._at(fxTicker(cur), d, 2);
      if (r == null) { const s = series(fxTicker(cur)); r = s.r.length ? s.r[0] : null; }
      return r == null ? null : r * mult;
    }
    isForeign(t) { return this.currency(t)[0] !== "CAD"; }
    cadAdj(t, d) { const a = this.adj(t, d), f = this.fx(t, d); return a == null || f == null ? null : a * f; }
  }

  // ------------------------------------------------------------------ config / tracks
  function trackCfg(track = "etf") {
    if (track === "etf") return { ...CONFIG.lab, track: "etf", fx_fee: 0.0 };
    if (track !== "stocks") throw new Error(`unknown track ${track}`);
    return { ...STOCKS_DEFAULTS, ...(CONFIG.stocks || {}), track: "stocks", universe: null };
  }
  const tracks = () => ({ ...STOCKS_DEFAULTS, ...(CONFIG.stocks || {}) }.enabled ? ["etf", "stocks"] : ["etf"]);
  const manualAgents = () => Object.keys(CONFIG.agents).filter(a => CONFIG.agents[a].provider === "manual");

  // ------------------------------------------------------------------ simulation (investors.py)
  function simulate(book, snaps, start, end, amount = 1000.0, fxFee = 0.015) {
    const days = businessDays(start, end);
    const out = { series: [], warnings: [], fees: 0.0, hindsight: snaps.length > 0 && start < snaps[0][0] };
    if (!days.length || !snaps.length) return out;
    let units = {}, applied = null;
    const warned = new Set(), missing = new Set();
    const px = (t, d) => book.cadAdj(t, d);
    const value = d => { let v = 0; for (const t in units) { const p = px(t, d); if (p != null) v += units[t] * p; } return v; };
    function rebalance(d, weights, V) {
      const avail = {};
      for (const t in weights) if (weights[t] > 0 && px(t, d) != null) avail[t] = weights[t];
      missing.clear();
      for (const t in weights) {
        if (t in avail) continue;
        if (weights[t] > 0) missing.add(t);
        if (!warned.has(t)) { warned.add(t); out.warnings.push(`${t}: no price on ${d} (not listed yet?) — added when it starts trading`); }
      }
      const tot = Object.values(avail).reduce((a, b) => a + b, 0);
      if (tot <= 0) return V;
      const w = {}; for (const t in avail) w[t] = avail[t] / tot;
      const keys = new Set([...Object.keys(units), ...Object.keys(w)]);
      let fee = 0;
      for (const t of keys) {
        if (t === "CASH" || !book.isForeign(t)) continue;
        const cur = (units[t] || 0) * (px(t, d) || 0);
        fee += Math.abs(V * (w[t] || 0) - cur) * fxFee;
      }
      const V2 = V - fee;
      out.fees += fee;
      units = {};
      for (const t in w) units[t] = V2 * w[t] / px(t, d);
      return V2;
    }
    for (const d of days) {
      let eff = null;
      for (let k = 0; k < snaps.length; k++) if (snaps[k][0] <= d) eff = k;
      if (eff === null) eff = 0;
      let late = false;
      if (applied === eff) for (const t of missing) if (px(t, d) != null) { late = true; break; }
      if (applied !== eff || late) {
        const V = applied === null ? amount : value(d);
        rebalance(d, snaps[eff][1], V);
        applied = eff;
        if (!Object.keys(units).length) { applied = null; continue; }
      }
      out.series.push([d, value(d)]);
    }
    return out;
  }

  function metrics(s) {
    if (s.length < 2) return { total: null, cagr: null, maxdd: null, vol: null, from: null, to: null };
    const v0 = s[0][1], v1 = s[s.length - 1][1], total = v1 / v0 - 1;
    const years = daysBetween(s[0][0], s[s.length - 1][0]) / 365.25;
    let peak = -1, dd = 0, prev = null;
    const rets = [];
    for (const [, v] of s) {
      peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1);
      if (prev) rets.push(Math.log(v / prev));
      prev = v;
    }
    let vol = null;
    if (rets.length > 20) {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      vol = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
    }
    return { total, cagr: years >= 1 ? Math.pow(1 + total, 1 / years) - 1 : null, maxdd: dd, vol,
      from: s[0][0], to: s[s.length - 1][0] };
  }
  function yearly(s) {
    const out = {};
    let curYear = null, last = null, base = s.length ? s[0][1] : null;
    for (const [d, v] of s) {
      const y = d.slice(0, 4);
      if (curYear && y !== curYear) { out[curYear] = last / base - 1; base = last; }
      curYear = y; last = v;
    }
    if (curYear && base) out[curYear] = last / base - 1;
    return out;
  }
  function thin(s, n = 500) {
    if (s.length <= n) return s;
    const k = s.length / n, out = [];
    for (let i = 0; i < n; i++) out.push(s[Math.floor(i * k)]);
    out.push(s[s.length - 1]);
    return out;
  }

  // ------------------------------------------------------------------ investors
  function investorRows() {
    const order = { stocks: 0, etf: 1 };
    return SEED.investors.map(i => {
      const o = DB.investors[i.id] || {};
      return { ...i, follow_date: o.follow_date || SEED.as_of, active: o.active == null ? 1 : o.active,
        reported: i.reported || {}, benchmarks: i.benchmarks || [] };
    }).sort((a, b) => (order[a.list] - order[b.list]) || (a.rank - b.rank));
  }
  function snapshots(iid) {
    const snaps = {};
    for (const r of DB.holdings.filter(h => h.investor_id === iid))
      (snaps[r.as_of] = snaps[r.as_of] || []).push({ ticker: r.ticker, weight: r.weight, estimated: !!r.estimated });
    return Object.keys(snaps).sort().map(a => [a, snaps[a].sort((x, y) => y.weight - x.weight)]);
  }
  const snapsW = snaps => snaps.map(([a, hs]) => [a, Object.fromEntries(hs.map(h => [h.ticker, h.weight]))]);
  function investorTickers(inv) {
    const t = new Set(DB.holdings.filter(h => !inv || h.investor_id === inv.id).map(h => h.ticker));
    for (const i of inv ? [inv] : investorRows()) { if (i.proxy) t.add(i.proxy); (i.benchmarks || []).forEach(b => t.add(b)); }
    t.delete("CASH");
    return [...t];
  }
  function period(q) {
    const td = today();
    const end = validDate(q.end || td);
    const start = validDate(q.start || addDays(td, -5 * 365));
    return [start, minStr(end, td)];
  }

  async function investorsOverview(q) {
    q = q || {};
    const [start, end] = period(q);
    const amount = parseFloat(q.amount) || 1000, fxFee = trackCfg("stocks").fx_fee, home = CONFIG.lab.benchmark;
    const td = today();
    const quick = start === end; // the menu only needs the list
    if (!quick) await loadPrices(investorTickers(null).concat(["SPY", "AOR", home]));
    const book = new Book(), res = [];
    for (const inv of investorRows()) {
      const snaps = snapshots(inv.id), sw = snapsW(snaps);
      const sim = quick ? { series: [], hindsight: false } : simulate(book, sw, start, end, amount, fxFee);
      const live = !quick && inv.follow_date < td ? simulate(book, sw, inv.follow_date, td, amount, fxFee) : { series: [] };
      const bench = quick ? { series: [] } : simulate(book, [[start, { [inv.benchmarks[0]]: 1 }]], start, end, amount, fxFee);
      const m = metrics(sim.series), mb = metrics(bench.series);
      const last = snaps.length ? snaps[snaps.length - 1] : [null, []];
      res.push({ id: inv.id, list: inv.list, rank: inv.rank, name: inv.name, kind: inv.kind, style: inv.style,
        since: inv.since, five_y: inv.five_y, verdict: inv.verdict, score: inv.score, follow_date: inv.follow_date,
        active: inv.active, proxy: inv.proxy, reported: inv.reported,
        benchmark: inv.benchmarks[0], metrics: m, bench_metrics: mb,
        excess: m.total == null || mb.total == null ? null : m.total - mb.total,
        live: metrics(live.series), hindsight: sim.hindsight,
        holdings_as_of: last[0], n_holdings: last[1].length,
        coverage: last[1].filter(h => h.ticker !== "CASH").reduce((a, h) => a + h.weight, 0),
        top: last[1].slice(0, 5).map(h => h.ticker), series: thin(sim.series, 250) });
    }
    const lines = {};
    if (!quick) for (const b of [...new Set(["SPY", "AOR", home])].sort()) {
      const s = simulate(book, [[start, { [b]: 1 }]], start, end, amount, fxFee);
      lines[b] = { series: thin(s.series, 250), metrics: metrics(s.series) };
    }
    return { investors: res, benchmarks: lines, start, end, amount, fx_fee: fxFee };
  }

  async function investorDetail(q) {
    q = q || {};
    const [start, end] = period(q);
    const amount = parseFloat(q.amount) || 1000, fxFee = trackCfg("stocks").fx_fee, home = CONFIG.lab.benchmark;
    const inv = investorRows().find(i => i.id === q.id);
    if (!inv) throw new Error(`unknown investor ${q.id}`);
    await loadPrices(investorTickers(inv).concat([home]));
    const book = new Book(), snaps = snapshots(inv.id);
    const sim = simulate(book, snapsW(snaps), start, end, amount, fxFee);
    const lines = { copy: sim };
    for (const b of [...new Set(inv.benchmarks.concat([home], inv.proxy ? [inv.proxy] : []))])
      lines[b] = simulate(book, [[start, { [b]: 1 }]], start, end, amount, fxFee);
    const td = today();
    const live = inv.follow_date < td ? simulate(book, snapsW(snaps), inv.follow_date, td, amount, fxFee) : { series: [], warnings: [] };
    for (const [, hs] of snaps) for (const h of hs) {
      const m = INDEX.tickers[h.ticker] || {};
      h.name = m.n || null; h.currency = m.c || null;
      h.last = book.raw(h.ticker, td); h.last_date = book.lastDate(h.ticker);
    }
    const L = {};
    for (const k in lines) L[k] = { series: thin(lines[k].series), metrics: metrics(lines[k].series), yearly: yearly(lines[k].series) };
    return { investor: inv, snapshots: snaps, lines: L, warnings: sim.warnings, fees: sim.fees, hindsight: sim.hindsight,
      live: { series: thin(live.series), metrics: metrics(live.series), warnings: live.warnings || [] },
      start, end, amount, fx_fee: fxFee };
  }

  // ------------------------------------------------------------------ portfolios
  async function pfCreate(name, benchmark, fxFee, notes) {
    name = String(name || "").trim();
    if (!name) throw new Error("name is required");
    const bm = await ensure(benchmark || CONFIG.lab.benchmark);
    const id = nid();
    DB.portfolios.push({ id, name, created_at: today(), benchmark: bm, fx_fee: parseFloat(fxFee) || 0, notes: notes || "", archived: 0 });
    save();
    return id;
  }
  const pfGet = id => { const p = DB.portfolios.find(x => x.id === id); if (!p) throw new Error("unknown portfolio"); return p; };
  const txsOf = pid => DB.transactions.filter(x => x.portfolio_id === pid)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  function positionQty(pid, t, d) {
    let q = 0;
    for (const r of txsOf(pid)) if (r.ticker === t && r.date <= d) q += r.type === "buy" ? r.quantity : -r.quantity;
    return q;
  }
  async function addTx(pid, tx) {
    const p = pfGet(pid);
    const d = validDate(tx.date || today());
    if (d > today()) throw new Error("the date is in the future");
    const typ = tx.type, fee = parseFloat(tx.fee) || 0;
    if (typ === "deposit" || typ === "withdraw") {
      const amt = parseFloat(tx.amount) || 0;
      if (amt <= 0) throw new Error("amount must be positive");
      DB.transactions.push({ id: nid(), portfolio_id: pid, date: d, type: typ, ticker: null, quantity: null, price: null,
        fee, amount: amt, note: tx.note || null, created_at: nowISO() });
      save();
      return;
    }
    if (typ !== "buy" && typ !== "sell") throw new Error("type must be buy, sell, deposit or withdraw");
    const t = String(tx.ticker || "").trim().toUpperCase();
    if (!t) throw new Error("ticker is required");
    await ensure(t);
    const book = new Book();
    let price = tx.price;
    price = price != null && price !== "" ? parseFloat(price) : book.raw(t, d);
    if (!price) throw new Error(`no price for ${t} on or before ${d} — enter the price manually`);
    let qty = tx.quantity;
    if (qty == null || qty === "") {
      const amt = parseFloat(tx.amount) || 0;
      if (amt <= 0) throw new Error("enter a quantity or an amount in CAD");
      const fx = book.fx(t, d);
      if (!fx) throw new Error(`no exchange rate for ${t} on ${d}`);
      const f = book.isForeign(t) ? p.fx_fee : 0;
      qty = (amt - fee) / (price * fx * (1 + f));
    }
    qty = parseFloat(qty);
    if (!(qty > 0)) throw new Error("quantity must be positive");
    if (typ === "sell") {
      const held = positionQty(pid, t, d);
      if (qty > held + 1e-9) throw new Error(`you hold only ${+held.toPrecision(6)} ${t} on ${d}`);
    }
    DB.transactions.push({ id: nid(), portfolio_id: pid, date: d, type: typ, ticker: t, quantity: qty, price, fee,
      amount: null, note: tx.note || null, created_at: nowISO() });
    save();
  }
  function pfTickers(p) { return [...new Set(txsOf(p.id).map(x => x.ticker).filter(Boolean).concat([p.benchmark]))]; }

  function pfValue(pid, end, book) {
    const p = pfGet(pid);
    book = book || new Book();
    const txs = txsOf(pid).map(x => ({ ...x }));
    end = end || today();
    const bm = p.benchmark, fxf = +p.fx_fee;
    const out = { portfolio: { ...p }, transactions: txs, series: [], positions: [], summary: null, warnings: [] };
    if (!txs.length) return out;
    const pos = {};
    let cash = 0, invested = 0, bUnits = 0, twr = 1, prevV = null, realized = 0, fees = 0, i = 0;
    const series = [];
    function bFlow(amount, d) {
      const px = book.cadAdj(bm, d);
      if (!px) { out.warnings.push(`benchmark ${bm}: no price on ${d}`); return; }
      const f = book.isForeign(bm) ? fxf : 0;
      if (amount > 0) bUnits += amount * (1 - f) / px;
      else bUnits -= Math.min(bUnits, -amount / (px * (1 - f)));
    }
    let days = businessDays(txs[0].date, end);
    if (!days.length) days = [end];
    for (const d of days) {
      let flow = 0;
      while (i < txs.length && txs[i].date <= d) {
        const x = txs[i++];
        if (x.type === "deposit") { cash += x.amount - x.fee; invested += x.amount; flow += x.amount; bFlow(x.amount, d); }
        else if (x.type === "withdraw") { cash -= x.amount + x.fee; invested -= x.amount; flow -= x.amount; bFlow(-x.amount, d); }
        else {
          const t = x.ticker;
          const fx = book.fx(t, x.date) || book.fx(t, d);
          const adj = book.adj(t, x.date), raw = book.raw(t, x.date);
          if (!fx || !adj) { out.warnings.push(`${t}: no price/exchange rate on ${x.date} — transaction ignored`); continue; }
          const f = book.isForeign(t) ? fxf : 0;
          const gross = x.quantity * x.price * fx;
          const ps = pos[t] = pos[t] || { qty: 0, units: 0, cost: 0 };
          if (x.type === "buy") {
            const cost = gross * (1 + f) + x.fee;
            fees += gross * f + x.fee;
            if (cost > cash + 1e-9) {
              const need = cost - Math.max(cash, 0);
              cash += need; invested += need; flow += need; bFlow(need, d);
            }
            cash -= cost;
            ps.qty += x.quantity; ps.units += x.quantity * raw / adj; ps.cost += cost;
          } else {
            const frac = ps.qty > 0 ? Math.min(1, x.quantity / ps.qty) : 0;
            const proceeds = gross * (1 - f) - x.fee;
            fees += gross * f + x.fee;
            realized += proceeds - ps.cost * frac;
            ps.qty -= x.quantity; ps.units *= (1 - frac); ps.cost *= (1 - frac);
            cash += proceeds;
          }
        }
      }
      let v = cash;
      for (const t in pos) { const px = book.cadAdj(t, d); if (px && pos[t].units > 0) v += pos[t].units * px; }
      const bv = bUnits * (book.cadAdj(bm, d) || 0);
      if (prevV && prevV > 0) twr *= (v - flow) / prevV;
      prevV = v;
      series.push([d, +v.toFixed(4), +invested.toFixed(4), +bv.toFixed(4), twr]);
    }
    out.series = series;
    const totalV = series[series.length - 1][1];
    for (const t in pos) {
      const ps = pos[t];
      if (ps.qty <= 1e-9) continue;
      const px = book.cadAdj(t, end) || 0, mv = ps.units * px;
      out.positions.push({ ticker: t, qty: ps.qty, cost: ps.cost, value: mv, price: book.raw(t, end), price_date: book.lastDate(t),
        currency: rawCurrency(t), gain: mv - ps.cost, ret: ps.cost ? mv / ps.cost - 1 : null, weight: totalV ? mv / totalV : null });
    }
    if (cash > 0.005 || cash < -0.005)
      out.positions.push({ ticker: "CASH", qty: null, cost: cash, value: cash, price: null, price_date: null, currency: "CAD",
        gain: 0, ret: null, weight: totalV ? cash / totalV : null });
    out.positions.sort((a, b) => (b.value || 0) - (a.value || 0));
    const bv = series[series.length - 1][3];
    out.summary = { value: totalV, invested, gain: totalV - invested, gain_pct: invested ? (totalV - invested) / invested : null,
      twr: twr - 1, bench_value: bv, bench_gain: bv - invested, vs_bench: totalV - bv, realized, fees, cash,
      first: txs[0].date, risk: metrics(series.map(s => [s[0], s[4]])) };
    return out;
  }

  async function createFromWeights(name, weights, amount, d, benchmark, fxFee, note) {
    const pid = await pfCreate(name, benchmark, fxFee, note);
    amount = parseFloat(amount);
    DB.transactions.push({ id: nid(), portfolio_id: pid, date: d, type: "deposit", ticker: null, quantity: null, price: null,
      fee: 0, amount, note, created_at: nowISO() });
    save();
    let tot = 0;
    for (const t in weights) if (t !== "CASH" && weights[t] > 0) tot += weights[t];
    const totAll = tot + (weights.CASH || 0);
    const errors = [];
    for (const t in weights) {
      if (t === "CASH" || weights[t] <= 0) continue;
      try { await addTx(pid, { date: d, type: "buy", ticker: t, amount: amount * weights[t] / totAll, note }); }
      catch (e) { errors.push(`${t}: ${e.message}`); }
    }
    return [pid, errors];
  }

  // ------------------------------------------------------------------ AI replies (parse.py + session.py)
  function extractJson(text) {
    text = String(text).replace(/```(?:json)?/g, "");
    const start = text.indexOf("{");
    if (start < 0) throw new Error("no JSON object in response");
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        esc = ch === "\\" && !esc;
        if (ch === '"' && !esc) inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
    }
    throw new Error("unbalanced JSON");
  }

  function validate(obj, universe, horizons, start) {
    const ok = universe == null ? t => t === "CASH" || TICKER_RE.test(String(t)) : t => universe.includes(t);
    const warns = [];
    let alloc = {};
    for (let [t, w] of Object.entries(obj.allocation || {})) {
      if (universe == null) t = String(t).trim().toUpperCase();
      if (!ok(t)) { warns.push(`allocation ticker ${t} not in universe — dropped`); continue; }
      const v = toF(w);
      if (v > 0) alloc[t] = v;
    }
    const total = Object.values(alloc).reduce((a, b) => a + b, 0);
    if (total <= 0) warns.push("empty allocation");
    else {
      if (Math.abs(total - 1) > 0.01) warns.push(`weights summed to ${total.toFixed(3)} — normalized`);
      for (const t in alloc) alloc[t] /= total;
    }
    const fcs = [];
    const d0 = addDays(start, 1);
    for (const f of obj.forecasts || []) {
      try {
        if (!f || typeof f !== "object") throw new Error("not an object");
        const kind = f.kind;
        if (!("kind" in f) || !("ticker_a" in f) || !("horizon_days" in f) || !("probability" in f)) throw new Error("missing field");
        let a = f.ticker_a;
        if (universe == null) a = String(a).trim().toUpperCase();
        let h = Math.trunc(toF(f.horizon_days));
        const p = Math.min(Math.max(toF(f.probability), 0.01), 0.99);
        if (kind !== "outperform" && kind !== "return_above") throw new Error(`bad kind ${kind}`);
        if (!ok(a) || a === "CASH") throw new Error(`bad ticker_a ${a}`);
        let b = kind === "outperform" ? f.ticker_b : null;
        if (b && universe == null) b = String(b).trim().toUpperCase();
        if (kind === "outperform" && (!b || !ok(b) || b === a)) throw new Error(`bad ticker_b ${b}`);
        const thr = kind === "return_above" ? (f.threshold === undefined ? 0.0 : toF(f.threshold)) : null;
        if (!horizons.includes(h)) {
          warns.push(`horizon ${h} not allowed — snapped`);
          h = horizons.reduce((best, x) => (Math.abs(x - h) < Math.abs(best - h) ? x : best), horizons[0]);
        }
        fcs.push({ kind, ticker_a: a, ticker_b: b || null, threshold: thr, start_date: d0, resolve_date: addDays(d0, h),
          probability: p, rationale: f.rationale || "" });
      } catch (e) { warns.push(`forecast dropped: ${e.message}`); }
    }
    return [alloc, fcs, warns];
  }

  function monthSession(lab, d) {
    const track = lab.track || "etf";
    const s = DB.sessions.find(x => x.created_at.slice(0, 7) === d.slice(0, 7) && x.track === track);
    if (s) return s.id;
    const id = nid();
    DB.sessions.push({ id, created_at: d, question: lab.question.trim(), context: "", universe: JSON.stringify(lab.universe), track });
    return id;
  }
  const hasResponse = (sid, agent) => DB.responses.some(r => r.session_id === sid && r.agent === agent);

  function storeResponse(sid, agent, model, raw, obj, alloc, fcs) {
    const id = nid();
    DB.responses.push({ id, session_id: sid, agent, model, round: 1, raw_text: raw, analysis: (obj || {}).analysis || null,
      risks: (obj || {}).what_would_prove_me_wrong || null, created_at: new Date().toISOString().slice(0, 19) + "+00:00" });
    for (const t in alloc) DB.allocations.push({ id: nid(), response_id: id, ticker: t, weight: alloc[t] });
    for (const f of fcs) DB.forecasts.push({ id: nid(), response_id: id, ...f, outcome: null, brier: null, resolved_at: null });
    return id;
  }

  async function checkTickers(lab, alloc, fcs, warns) {
    const names = new Set([...Object.keys(alloc), ...fcs.map(f => f.ticker_a), ...fcs.map(f => f.ticker_b).filter(Boolean)]);
    names.delete("CASH");
    await loadPrices([...names]);
    for (const t of [...names].sort()) if (!PRICES[t]) {
      noteMissing(t);
      warns.push(`${t}: not in this site's price database yet — kept; add it to scripts/tickers.txt and publish prices again so it can be tracked`);
    }
    const funds = Object.keys(alloc).filter(t => ["ETF", "MUTUALFUND", "CRYPTOCURRENCY"].includes((INDEX.tickers[t] || {}).y)).sort();
    for (const t of funds) warns.push(`${t}: is a fund, not a company — dropped from the allocation`);
    const a2 = {};
    for (const t in alloc) if (!funds.includes(t)) a2[t] = alloc[t];
    const tot = Object.values(a2).reduce((a, b) => a + b, 0);
    for (const t in a2) a2[t] = tot ? a2[t] / tot : 0;
    const n = Object.keys(a2).filter(t => t !== "CASH").length;
    if (!(lab.min_picks <= n && n <= lab.max_picks)) warns.push(`${n} companies (asked for ${lab.min_picks}-${lab.max_picks})`);
    const big = Object.keys(a2).filter(t => t !== "CASH" && a2[t] > lab.max_weight + 1e-6);
    if (big.length) warns.push(`above the ${fmtPct(lab.max_weight, 0)} cap: ${big.join(", ")} (kept as given)`);
    return [tot ? a2 : {}, fcs];
  }

  function refreshConsensus(sid) {
    const old = DB.responses.find(r => r.session_id === sid && r.agent === "consensus");
    if (old) {
      DB.forecasts = DB.forecasts.filter(f => f.response_id !== old.id);
      DB.allocations = DB.allocations.filter(a => a.response_id !== old.id);
      DB.responses = DB.responses.filter(r => r.id !== old.id);
    }
    const ids = DB.responses.filter(r => r.session_id === sid && r.agent !== "consensus").map(r => r.id);
    if (ids.length < 2) return;
    const groups = new Map();
    for (const f of DB.forecasts.filter(f => ids.includes(f.response_id))) {
      const h = daysBetween(f.start_date, f.resolve_date);
      const k = JSON.stringify([f.kind, f.ticker_a, f.ticker_b, f.threshold, h]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push([f.start_date, f.probability]);
    }
    const fcs = [];
    for (const [k, v] of groups) {
      if (v.length < 2) continue;
      const [kind, a, b, thr, h] = JSON.parse(k);
      const start = v.map(x => x[0]).sort().pop();
      fcs.push({ kind, ticker_a: a, ticker_b: b, threshold: thr, start_date: start, resolve_date: addDays(start, h),
        probability: v.reduce((s, x) => s + x[1], 0) / v.length, rationale: `mean of ${v.length} agents` });
    }
    const alloc = {};
    for (const a of DB.allocations.filter(a => ids.includes(a.response_id))) alloc[a.ticker] = (alloc[a.ticker] || 0) + a.weight / ids.length;
    storeResponse(sid, "consensus", "mean", "", { analysis: `mean of ${ids.length} agents` }, alloc, fcs);
  }

  async function record(agent, raw, obj, d, logf, track) {
    const lab = trackCfg(track);
    const sid = monthSession(lab, d);
    if (hasResponse(sid, agent)) { logf(`  ${agent} (${track}): already has a response for ${d.slice(0, 7)} — skipped`); return false; }
    let [alloc, fcs, warns] = validate(obj, lab.universe, lab.horizons_days, d);
    if (track === "stocks") [alloc, fcs] = await checkTickers(lab, alloc, fcs, warns);
    if (fcs.length < lab.min_forecasts_per_agent) warns.push(`only ${fcs.length} valid forecasts (min ${lab.min_forecasts_per_agent})`);
    storeResponse(sid, agent, CONFIG.agents[agent].model, raw, obj, alloc, fcs);
    logf(`  ${agent} [${track} ${d}]: ${fcs.length} forecasts, alloc=` +
      Object.entries(alloc).sort((x, y) => y[1] - x[1]).map(([t, w]) => `${t} ${fmtPct(w, 0)}`).join(", "));
    for (const w of warns) logf(`      ! ${w}`);
    refreshConsensus(sid);
    return true;
  }

  // ------------------------------------------------------------------ scoring (scoring.py)
  function isCore(f, core) {
    const h = daysBetween(f.start_date, f.resolve_date);
    return core.some(c => c.kind === f.kind && c.ticker_a === f.ticker_a && (c.ticker_b ?? null) === (f.ticker_b ?? null)
      && (f.kind === "return_above" ? (c.threshold ?? null) : null) === (f.threshold ?? null) && c.horizon_days === h);
  }
  function forecastsOf(track) {
    const out = [];
    const sess = Object.fromEntries(DB.sessions.map(s => [s.id, s]));
    const resp = Object.fromEntries(DB.responses.map(r => [r.id, r]));
    for (const f of DB.forecasts) {
      const r = resp[f.response_id], s = r && sess[r.session_id];
      if (s && s.track === track) out.push({ ...f, agent: r.agent, month: s.created_at.slice(0, 7) });
    }
    return out;
  }
  async function resolveDue() {
    const td = today();
    const due = DB.forecasts.filter(f => f.outcome == null && f.resolve_date <= td);
    if (!due.length) return;
    await loadPrices(due.flatMap(f => [f.ticker_a, f.ticker_b]));
    let done = 0;
    for (const f of due) {
      const ra = totalReturn(f.ticker_a, f.start_date, f.resolve_date, true);
      let outcome;
      if (f.kind === "outperform") {
        const rb = totalReturn(f.ticker_b, f.start_date, f.resolve_date, true);
        outcome = ra == null || rb == null ? null : +(ra > rb);
      } else outcome = ra == null ? null : +(ra > f.threshold);
      if (outcome == null) continue;
      f.outcome = outcome; f.brier = (f.probability - outcome) ** 2; f.resolved_at = td;
      done++;
    }
    if (done) { log(`resolved ${done} forecasts`); save(); }
  }
  function scoreboard(track) {
    const core = trackCfg(track).core_forecasts || [];
    const out = {};
    for (const x of forecastsOf(track)) {
      const v = out[x.agent] = out[x.agent] || { core_b: [], all_b: [], pending: 0 };
      if (x.outcome == null) { v.pending++; continue; }
      v.all_b.push(x.brier);
      if (isCore(x, core)) v.core_b.push(x.brier);
    }
    const avg = l => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
    const res = {};
    for (const a in out) res[a] = { core_n: out[a].core_b.length, core_brier: avg(out[a].core_b), all_n: out[a].all_b.length,
      all_brier: avg(out[a].all_b), pending: out[a].pending };
    return res;
  }
  function responsesOf(track) {
    const sess = Object.fromEntries(DB.sessions.filter(s => s.track === track).map(s => [s.id, s]));
    return DB.responses.filter(r => sess[r.session_id]).map(r => {
      const fs = DB.forecasts.filter(f => f.response_id === r.id).map(f => f.start_date).sort();
      const s = sess[r.session_id];
      return { id: r.id, agent: r.agent, month: s.created_at, d: fs.length ? fs[0] : s.created_at };
    }).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  }
  const allocOf = rid => Object.fromEntries(DB.allocations.filter(a => a.response_id === rid).map(a => [a.ticker, a.weight]));

  function picksPerformance(lab, amount = 100.0) {
    const td = today(), book = new Book(), fee = lab.fx_fee ?? 0.015, out = [];
    for (const r of responsesOf(lab.track || "etf")) {
      const al = allocOf(r.id);
      const row = { response_id: r.id, agent: r.agent, month: r.month.slice(0, 7), start: r.d, allocation: al, ret: null, series: [], bench: {} };
      if (Object.keys(al).length && r.d < td) {
        const sim = simulate(book, [[r.d, al]], r.d, td, amount, fee);
        row.series = sim.series; row.ret = metrics(sim.series).total; row.warnings = sim.warnings;
        for (const b of [lab.benchmark, ...(lab.compare || [])])
          row.bench[b] = metrics(simulate(book, [[r.d, { [b]: 1 }]], r.d, td, amount, fee).series).total;
      }
      out.push(row);
    }
    return out;
  }

  function reportText(lab, td) {
    const track = lab.track || "etf", benchmark = lab.benchmark, core = lab.core_forecasts || [];
    const gAll = {}, gCore = {};
    const g = (o, a) => (o[a] = o[a] || { b: [], pending: 0, hits: 0 });
    for (const x of forecastsOf(track)) {
      for (const grp of isCore(x, core) ? [gAll, gCore] : [gAll]) {
        const v = g(grp, x.agent);
        if (x.outcome == null) v.pending++;
        else { v.b.push(x.brier); v.hits += +((x.probability >= 0.5) === !!x.outcome); }
      }
    }
    const row = (name, v) => {
      const n = v.b.length, mb = n ? v.b.reduce((a, b) => a + b, 0) / n : null;
      return `| ${name} | ${n} | ${v.pending} | ${mb != null ? mb.toFixed(3) : "—"} | ` +
        `${mb != null ? fmtSPct(1 - mb / NAIVE_BRIER, 1) : "—"} | ${n ? fmtPct(v.hits / n, 0) : "—"} |`;
    };
    const sorted = o => Object.keys(o).sort().map(a => row(a, o[a]));
    const head = ["| agent | resolved | pending | mean Brier | skill vs 50% | hit rate |", "|---|---|---|---|---|---|"];
    const title = track === "etf" ? "# Agents Lab report — " + td : "# AI stock picks (companies) — " + td;
    let lines = [title, "", "Brier: lower is better. Saying 50% every time scores 0.250.", "",
      "## 1. Core questions (identical for every agent — the fair comparison)", ""];
    lines = lines.concat(head, sorted(gCore), ["", "## 2. All forecasts (core + each agent's own picks)", ""], head, sorted(gAll));
    const nMin = Object.keys(gCore).length ? Math.min(...Object.values(gCore).map(v => v.b.length)) : 0;
    lines.push("", `> Fewest resolved core forecasts for any agent: ${nMin}. ` +
      "Do not draw conclusions before ~30, and treat Brier differences under ~0.02 as noise.", "");
    const f = v => (v == null ? "n/a" : fmtSPct(v, 2));
    if (track === "stocks") {
      const cmp = [benchmark, ...(lab.compare || [])];
      lines.push(`## 3. Paper picks in CAD after ${fmtPct(lab.fx_fee ?? 0.015, 1)} FX on non-CAD stocks, lump sum from response date`, "",
        "| month | agent | from | return | " + cmp.join(" | ") + " |", "|---|---|---|---|" + "---|".repeat(cmp.length));
      for (const x of picksPerformance(lab))
        lines.push(`| ${x.month} | ${x.agent} | ${x.start} | ${f(x.ret)} | ` + cmp.map(b => f(x.bench[b])).join(" | ") + " |");
      lines.push("", "> Short-horizon returns are mostly noise. Weight section 1 over section 3.");
      return lines.join("\n");
    }
    lines.push(`## 3. Paper allocations vs benchmark (${benchmark}), lump sum from response date`, "",
      "| month | agent | from | return | benchmark | excess |", "|---|---|---|---|---|---|");
    for (const r of responsesOf("etf")) {
      const al = Object.entries(allocOf(r.id));
      const rets = al.map(([t, w]) => [w, totalReturn(t, r.d, td)]);
      const bench = totalReturn(benchmark, r.d, td);
      if (!al.length || rets.some(x => x[1] == null) || bench == null) {
        lines.push(`| ${r.month.slice(0, 7)} | ${r.agent} | ${r.d} | n/a | n/a | n/a |`);
        continue;
      }
      const pr = rets.reduce((a, [w, x]) => a + w * x, 0);
      lines.push(`| ${r.month.slice(0, 7)} | ${r.agent} | ${r.d} | ${f(pr)} | ${f(bench)} | ${f(pr - bench)} |`);
    }
    lines.push("", "> Short-horizon returns are mostly noise. Weight section 1 over section 3.");
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ prompts (prompts.py, unchanged text)
  const SYSTEM = `You are one of several independent investment analysts in a long-running,
pre-registered experiment. The investor is in Canada, uses Wealthsimple, invests
about 100 CAD per month, and has a 10-20 year horizon. Your output is scored ONLY by
the calibration of your probability forecasts (Brier score) and the paper performance
of your allocation versus the benchmark. Persuasive prose earns nothing.

Rules:
- Use only information available up to the session date. You may search the web for
  current market data, but never for anything dated after the session date.
- Ignore any memory of previous conversations with this user; answer fresh.
- Only use tickers from the allowed universe. "CASH" means a 0% return position.
- Probabilities must be honest: 0.5 means you have no edge. Avoid 0 and 1.
- Account type (TFSA/RRSP/FHSA), fees, and FX costs matter; mention them if relevant.
- Respond with a SINGLE JSON object inside one \`\`\`json code block and nothing else.`;
  const SYSTEM_STOCKS = `You are one of several independent equity analysts in a long-running,
pre-registered experiment. The investor is in Canada, uses Wealthsimple, invests
about 100 CAD per month in individual companies on top of a diversified ETF core, and
has a 10-20 year horizon. Your output is scored ONLY by the calibration of your
probability forecasts (Brier score) and the paper performance of your picks in CAD
(after a 1.5% FX fee on non-CAD stocks) versus the benchmark. Persuasive prose earns nothing.

Rules:
- Use only information available up to the session date. You may search the web for
  current market data, but never for anything dated after the session date.
- Ignore any memory of previous conversations with this user; answer fresh.
- Pick individual listed companies only (no ETFs, funds, crypto, options or leverage).
  "CASH" means a 0% return position.
- Write every ticker exactly as Yahoo Finance writes it: US stocks plain (AAPL, BRK-B),
  Canadian stocks with .TO (RY.TO), other exchanges with their Yahoo suffix (ASML.AS, 7203.T).
- Probabilities must be honest: 0.5 means you have no edge. Avoid 0 and 1.
- Respond with a SINGLE JSON object inside one \`\`\`json code block and nothing else.`;
  const SCHEMA_HINT = `JSON schema:
{
  "agent": "AGENT_NAME",
  "session_date": "YYYY-MM-DD",                  // today's date
  "analysis": "short reasoning (<= 200 words)",
  "what_would_prove_me_wrong": "concrete observable signals",
  "allocation": {"TICKER": weight, ...},          // weights sum to 1
  "forecasts": [                                   // at least MIN_N items, mix of horizons
    {"kind": "outperform", "ticker_a": "A", "ticker_b": "B",
     "horizon_days": H, "probability": p, "rationale": "..."},
       // P(total return incl. distributions of A > that of B over the next H days)
    {"kind": "return_above", "ticker_a": "A", "threshold": 0.02,
     "horizon_days": H, "probability": p, "rationale": "..."}
       // P(total return of A over the next H days > threshold; 0.02 = 2%)
  ]
}
Allowed horizon_days values: HORIZONS.
You MUST include every CORE forecast below (same kind/tickers/threshold/horizon; you
only choose the probability), then you may add up to 4 forecasts of your own.
CORE: CORE_JSON`;
  const SCHEMA_STOCKS = `JSON schema:
{
  "agent": "AGENT_NAME",
  "track": "stocks",
  "session_date": "YYYY-MM-DD",                  // today's date
  "analysis": "short reasoning (<= 250 words)",
  "what_would_prove_me_wrong": "concrete observable signals",
  "allocation": {"TICKER": weight, ...},          // MIN_P to MAX_P companies, weights sum to 1,
                                                   // no single company above MAX_W
  "picks": [{"ticker": "TICKER", "company": "name", "thesis": "one sentence"}, ...],
  "forecasts": [                                   // at least MIN_N items
    {"kind": "outperform", "ticker_a": "A", "ticker_b": "B",
     "horizon_days": H, "probability": p, "rationale": "..."},
       // P(total return incl. dividends of A > that of B over the next H days,
       //   each measured in its own trading currency)
    {"kind": "return_above", "ticker_a": "A", "threshold": 0.02,
     "horizon_days": H, "probability": p, "rationale": "..."}
  ]
}
Allowed horizon_days values: HORIZONS.
You MUST include every CORE forecast below (same kind/tickers/horizon; you only choose the
probability). Then, for EACH of your 3 largest picks, add one "outperform" forecast with
horizon 180 against SPY (US stocks), XIU.TO (Canadian stocks) or URTH (other exchanges).
You may add up to 3 more forecasts of your own.
CORE: CORE_JSON`;
  const rep = (s, pairs) => pairs.reduce((x, [a, b]) => x.split(a).join(b), s);
  function userPrompt(lab, sessionDate, agent) {
    if (lab.track === "stocks")
      return [`SESSION_DATE=${sessionDate}`,
        "UNIVERSE=any individual listed company available at Wealthsimple (Yahoo Finance tickers)",
        `BENCHMARK=${lab.benchmark} (paper performance in CAD; also shown vs ${(lab.compare || []).join(", ")})`,
        "", "QUESTION:", lab.question.trim(), "",
        rep(SCHEMA_STOCKS, [["MIN_N", String(lab.min_forecasts_per_agent)], ["MIN_P", String(lab.min_picks)],
          ["MAX_P", String(lab.max_picks)], ["MAX_W", lab.max_weight.toFixed(2)], ["HORIZONS", pyDumps(lab.horizons_days)],
          ["AGENT_NAME", agent], ["CORE_JSON", pyDumps(lab.core_forecasts || [])]])].join("\n");
    return [`SESSION_DATE=${sessionDate}`, `UNIVERSE_JSON=${pyDumps(lab.universe)}`, `BENCHMARK=${lab.benchmark}`,
      "", "QUESTION:", lab.question.trim(), "",
      rep(SCHEMA_HINT, [["MIN_N", String(lab.min_forecasts_per_agent)], ["HORIZONS", pyDumps(lab.horizons_days)],
        ["AGENT_NAME", agent], ["CORE_JSON", pyDumps(lab.core_forecasts || [])]])].join("\n");
  }
  const appPrompt = (lab, agent) => (lab.track === "stocks" ? SYSTEM_STOCKS : SYSTEM) + "\n\n" +
    userPrompt(lab, "today's date (write it in session_date)", agent);

  // ------------------------------------------------------------------ holdings + watchlist for the briefing prompts (admin.js)
  async function briefTickers() {
    const ps = DB.portfolios.filter(p => !p.archived);
    await loadPrices(ps.flatMap(pfTickers));
    const book = new Book(), held = new Set();
    for (const p of ps) for (const x of pfValue(p.id, null, book).positions) if (x.ticker !== "CASH" && x.qty > 0) held.add(x.ticker);
    const watch = ((CONFIG.home || {}).watchlist || []).filter(t => !held.has(t));
    return (held.size ? [...held].join(", ") + (watch.length ? "; watchlist: " : "") : watch.length ? "watchlist: " : "none listed") + watch.join(", ");
  }

  // ------------------------------------------------------------------ market home page
  // perf: the same definitions as scripts/build_data.py perf_of() (top movers come from there)
  function perfOf(t) {
    const s = series(t), n = s.d.length;
    if (n < 2) return null;
    const a = s.a, last = a[n - 1], ld = s.d[n - 1];
    const r = p => (p ? last / p - 1 : null);
    const back = days => { const tg = addDays(ld, -days), i = bisectRight(s.d, tg) - 1; return i >= 0 && daysBetween(s.d[i], tg) <= 7 ? a[i] : null; };
    const yi = bisectLeft(s.d, ld.slice(0, 4) + "-01-01") - 1;
    let hi = -Infinity;
    for (let i = bisectRight(s.d, addDays(ld, -365)); i < n; i++) hi = Math.max(hi, a[i]);
    return { d1: r(a[n - 2]), d5: n > 5 ? r(a[n - 6]) : null, m1: r(back(30)), ytd: yi >= 0 ? r(a[yi]) : null, y1: r(back(365)),
      off_high: hi > 0 && isFinite(hi) ? last / hi - 1 : null };
  }
  function quoteRow(t) {
    const m = INDEX.tickers[t] || {}, s = series(t), n = s.d.length;
    if (!n) return { ticker: t, name: m.n || null, missing: true };
    const k = bisectLeft(s.d, addDays(s.d[n - 1], -92));
    return { ticker: t, name: m.n || null, type: m.y || null, currency: m.c || null, last: s.r[n - 1], last_date: s.d[n - 1],
      ...perfOf(t), spark: s.d.slice(k).map((d, i) => [d, s.a[k + i]]) };
  }
  function latestConsensus(track) {
    const ss = DB.sessions.filter(s => s.track === track).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    for (const s of ss) {
      const rs = DB.responses.filter(r => r.session_id === s.id), c = rs.find(r => r.agent === "consensus");
      if (!c) continue;
      const others = rs.filter(r => r.agent !== "consensus");
      const alloc = DB.allocations.filter(a => a.response_id === c.id).sort((a, b) => b.weight - a.weight).map(a => ({
        ticker: a.ticker, weight: a.weight, name: (INDEX.tickers[a.ticker] || {}).n || null,
        agents: others.filter(r => DB.allocations.some(x => x.response_id === r.id && x.ticker === a.ticker)).map(r => r.agent) }));
      return { month: s.created_at.slice(0, 7), n_agents: others.length, allocation: alloc };
    }
    return null;
  }
  async function homeData() {
    await resolveDue();
    const home = CONFIG.home || {}, indices = home.indices || ["^GSPTSE", "^GSPC", "^IXIC", "^VIX", "XEQT.TO"];
    const [market, briefing] = await Promise.all([getJSON(`data/market.json?v=${encodeURIComponent(INDEX.updated || "0")}`, null),
      getJSON(`data/briefing.json?t=${Date.now()}`, null)]);
    // holdings across all open portfolios, valued in CAD
    const ps = DB.portfolios.filter(p => !p.archived);
    await loadPrices(ps.flatMap(pfTickers));
    const book = new Book(), held = {};
    let total = 0;
    for (const p of ps) for (const x of pfValue(p.id, null, book).positions) {
      if (x.ticker === "CASH" || !(x.qty > 0)) continue;
      const h = held[x.ticker] = held[x.ticker] || { value: 0, cost: 0, portfolios: [] };
      h.value += x.value || 0; h.cost += x.cost || 0; h.portfolios.push(p.name); total += x.value || 0;
    }
    const watch = (home.watchlist || []).filter(t => !held[t]);
    await loadPrices(indices.concat(Object.keys(held), watch));
    const holdings = Object.entries(held).sort((a, b) => b[1].value - a[1].value).map(([t, h]) =>
      ({ ...quoteRow(t), value: h.value, weight: total ? h.value / total : null, gain: h.value - h.cost, portfolios: h.portfolios }));
    const universe = [];
    if (market && market.perf)
      for (const [t, p] of Object.entries(market.perf)) {
        const m = INDEX.tickers[t] || {};
        if (t.startsWith("^") || m.y === "INDEX") continue;
        universe.push({ ticker: t, name: m.n || null, type: m.y || null, currency: m.c || null,
          d1: p[0], d5: p[1], m1: p[2], ytd: p[3], y1: p[4], off_high: p[5] });
      }
    const sb = {};
    for (const t of tracks()) sb[t] = scoreboard(t);
    return { today: today(), last_close: INDEX.last_close, prices_updated: INDEX.updated,
      market_updated: market ? market.updated : null, indices: indices.map(quoteRow), holdings, total,
      watchlist: watch.map(quoteRow), universe, trending: (market && market.trending) || [], news: (market && market.news) || [],
      consensus: { etf: latestConsensus("etf"), stocks: tracks().includes("stocks") ? latestConsensus("stocks") : null },
      scoreboard: sb, session_day: CONFIG.lab.session_day || 20, briefing };
  }

  // ------------------------------------------------------------------ GET handlers
  const G = {};
  G.home = homeData;
  G.brief_tickers = async () => ({ tickers: await briefTickers(), today: today(), repo: CONFIG.repo || null });
  G.config = () => {
    const s = trackCfg("stocks"), lab = CONFIG.lab;
    return { agents: CONFIG.agents, benchmark: lab.benchmark, universe: lab.universe, horizons_days: lab.horizons_days,
      min_forecasts_per_agent: lab.min_forecasts_per_agent, question: lab.question, core_forecasts: lab.core_forecasts || [],
      tracks: tracks(),
      stocks: Object.fromEntries(["benchmark", "compare", "min_picks", "max_picks", "max_weight", "fx_fee", "horizons_days",
        "min_forecasts_per_agent", "question", "core_forecasts"].map(k => [k, s[k]])),
      today: today(), version: CONFIG.version, repo: CONFIG.repo, platform: "web",
      data: { updated: INDEX.updated, last_close: INDEX.last_close, n: Object.keys(INDEX.tickers).length } };
  };
  G.overview = async () => {
    await resolveDue();
    const td = today(), month = td.slice(0, 7), stuck = addDays(td, -4);
    const fs = forecastsOf("etf");
    const pend = fs.filter(f => f.outcome == null && f.resolve_date > td).map(f => f.resolve_date).sort();
    const thisMonth = {};
    const sess = Object.fromEntries(DB.sessions.map(s => [s.id, s]));
    for (const r of DB.responses) {
      const s = sess[r.session_id];
      if (s && s.created_at.slice(0, 7) === month) (thisMonth[s.track] = thisMonth[s.track] || {})[r.agent] = r.created_at;
    }
    const etfIds = new Set(DB.sessions.filter(s => s.track === "etf").map(s => s.id));
    const sb = {};
    for (const t of tracks()) sb[t] = scoreboard(t);
    return { today: td, month, sessions: etfIds.size,
      responses: DB.responses.filter(r => r.agent !== "consensus" && etfIds.has(r.session_id)).length,
      forecasts: { n: fs.length, resolved: fs.filter(f => f.outcome != null).length,
        overdue: fs.filter(f => f.outcome == null && f.resolve_date < stuck).length, next_due: pend[0] || null },
      this_month: thisMonth, tracks: tracks(), agents: Object.keys(CONFIG.agents), last_price: INDEX.last_close,
      data_updated: INDEX.updated, inbox_pending: 0, inbox_failed: DB.inbox.filter(x => x.error).length,
      run: { running: false }, scoreboard: sb };
  };
  G.sessions = async q => {
    await resolveDue();
    const track = (q || {}).track || "etf";
    return DB.sessions.filter(s => s.track === track).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(s => ({
      ...s, universe: JSON.parse(s.universe || "null"),
      responses: DB.responses.filter(r => r.session_id === s.id).sort((a, b) => (a.agent < b.agent ? -1 : 1)).map(r => ({
        ...r,
        allocation: DB.allocations.filter(a => a.response_id === r.id).sort((a, b) => b.weight - a.weight)
          .map(a => ({ ticker: a.ticker, weight: a.weight, name: (INDEX.tickers[a.ticker] || {}).n || null })),
        forecasts: DB.forecasts.filter(f => f.response_id === r.id).sort((a, b) => (a.resolve_date < b.resolve_date ? -1 : 1)),
      })),
    }));
  };
  G.forecasts = async q => {
    await resolveDue();
    const track = (q || {}).track || "etf", core = trackCfg(track).core_forecasts || [];
    const rows = forecastsOf(track).sort((a, b) => (a.resolve_date < b.resolve_date ? -1 : a.resolve_date > b.resolve_date ? 1 : a.agent < b.agent ? -1 : 1));
    await loadPrices(rows.flatMap(f => [f.ticker_a, f.ticker_b]));
    const td = today();
    for (const f of rows) {
      f.core = isCore(f, core);
      const end = minStr(f.resolve_date, td);
      f.ret_a = totalReturn(f.ticker_a, f.start_date, end);
      f.ret_b = f.ticker_b ? totalReturn(f.ticker_b, f.start_date, end) : null;
    }
    return rows;
  };
  G.prices = async () => {
    const u = CONFIG.lab.universe.filter(t => t !== "CASH");
    await loadPrices(u);
    const since = addDays(today(), -400), out = {};
    for (const t of u) { const s = series(t), i = bisectLeft(s.d, since); out[t] = s.d.slice(i).map((d, k) => [d, s.a[i + k]]); }
    return out;
  };
  G.picks = async () => {
    await resolveDue();
    const lab = trackCfg("stocks");
    const months = [];
    for (const s of DB.sessions.filter(s => s.track === "stocks").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
      const agents = {};
      for (const r of DB.responses.filter(r => r.session_id === s.id).sort((a, b) => (a.agent < b.agent ? -1 : 1))) {
        const theses = {};
        try { for (const p of extractJson(r.raw_text).picks || []) theses[String(p.ticker || "").toUpperCase()] = p.thesis || ""; } catch (e) { /* consensus / no picks */ }
        const al = DB.allocations.filter(a => a.response_id === r.id).sort((a, b) => b.weight - a.weight).map(a => {
          const m = INDEX.tickers[a.ticker];
          return { ticker: a.ticker, weight: a.weight, ...(m ? { name: m.n, currency: m.c } : {}), thesis: theses[a.ticker] || "" };
        });
        agents[r.agent] = { id: r.id, model: r.model, created_at: r.created_at, analysis: r.analysis, risks: r.risks, allocation: al };
      }
      months.push({ month: s.created_at.slice(0, 7), session_id: s.id, agents });
    }
    const ids = new Set(DB.sessions.filter(s => s.track === "stocks").map(s => s.id));
    const rids = new Set(DB.responses.filter(r => ids.has(r.session_id)).map(r => r.id));
    await loadPrices(DB.allocations.filter(a => rids.has(a.response_id)).map(a => a.ticker).concat([lab.benchmark], lab.compare || []));
    const perf = picksPerformance(lab);
    for (const p of perf) p.series = thin(p.series, 200);
    return { months, performance: perf, scoreboard: scoreboard("stocks"), benchmark: lab.benchmark, compare: lab.compare || [], fx_fee: lab.fx_fee };
  };
  G.report = async () => {
    await resolveDue();
    const etfRids = new Set(responsesOf("etf").map(r => r.id)), stRids = new Set(responsesOf("stocks").map(r => r.id));
    const st = trackCfg("stocks");
    await loadPrices(DB.allocations.filter(a => etfRids.has(a.response_id) || stRids.has(a.response_id)).map(a => a.ticker)
      .concat([CONFIG.lab.benchmark, st.benchmark], st.compare || []));
    const td = today();
    let txt = reportText(trackCfg("etf"), td);
    if (DB.sessions.some(s => s.track === "stocks")) txt += "\n\n" + reportText(st, td);
    return { markdown: txt };
  };
  G.inbox = () => ({ pending: [], processed: DB.inbox.filter(x => !x.error).slice(-50).reverse(), failed: DB.inbox.filter(x => x.error).reverse() });
  G.prompts = async () => {
    const out = {};
    for (const t of tracks()) { out[t] = {}; for (const a of manualAgents()) out[t][a] = appPrompt(trackCfg(t), a); }
    return out;
  };
  G.log = () => ({ text: DB.log.slice(-300).join("\n") });
  G.investors = investorsOverview;
  G.investor = investorDetail;
  G.portfolios = async () => {
    const ps = DB.portfolios.filter(p => !p.archived).sort((a, b) => a.id - b.id);
    await loadPrices(ps.flatMap(pfTickers));
    const book = new Book();
    return ps.map(p => {
      const v = pfValue(p.id, null, book);
      return { ...p, summary: v.summary, n_positions: v.positions.filter(x => x.ticker !== "CASH").length,
        series: thin(v.series.map(x => [x[0], x[4]]), 250) };
    });
  };
  G.portfolio = async q => {
    const pid = parseInt((q || {}).id, 10), p = pfGet(pid);
    await loadPrices(pfTickers(p));
    const v = pfValue(pid, null);
    let s = v.series;
    if (q.start) { const f = s.filter(x => x[0] >= q.start); s = f.length ? f : s.slice(-1); }
    v.series = thin(s, 600);
    for (const x of v.positions) x.name = (INDEX.tickers[x.ticker] || {}).n || null;
    for (const x of v.transactions) x.name = x.ticker ? (INDEX.tickers[x.ticker] || {}).n || null : null;
    if (s.length) { const a = s[0], b = s[s.length - 1]; v.period = { start: a[0], end: b[0], twr: a[4] ? b[4] / a[4] - 1 : null, bench_twr: null }; }
    return v;
  };
  G.search = q => {
    const s = String((q || {}).q || "").trim().toUpperCase();
    if (!s) return [];
    const hits = [];
    for (const [t, m] of Object.entries(INDEX.tickers)) {
      if (m.y === "CURRENCY") continue;
      const n = String(m.n || "").toUpperCase();
      let score = t === s ? 0 : t.startsWith(s) ? 1 : n.startsWith(s) ? 2 : t.includes(s) ? 3 : n.includes(s) ? 4 : -1;
      if (score >= 0) hits.push([score, t, m]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1));
    return hits.slice(0, 15).map(([, t, m]) => ({ ticker: t, name: m.n || "", exchange: m.x || "", type: m.y, currency: m.c }));
  };
  G.quote = async q => {
    const t = await ensure((q || {}).ticker);
    const m = INDEX.tickers[t] || {}, book = new Book(), d = (q || {}).date || today();
    return { ticker: t, name: m.n, currency: m.c, exchange: m.x, type: m.y, price: book.raw(t, d), price_date: book.lastDate(t),
      fx: book.fx(t, d), foreign: book.isForeign(t) };
  };
  G.data = () => {
    let bytes = 0;
    try { bytes = (localStorage.getItem(DBKEY) || "").length * 2; } catch (e) { /* blocked */ }
    return { updated: INDEX.updated, last_close: INDEX.last_close, n: Object.keys(INDEX.tickers).length,
      failed: INDEX.failed || [], missing: DB.missing.filter(t => !INDEX.tickers[t]), bytes,
      counts: { portfolios: DB.portfolios.length, transactions: DB.transactions.length, responses: DB.responses.filter(r => r.agent !== "consensus").length,
        snapshots: new Set(DB.holdings.map(h => h.investor_id + h.as_of)).size },
      log: DB.log.slice(-300).join("\n") };
  };

  // ------------------------------------------------------------------ POST handlers
  const P = {};
  P.paste = async b => {
    const agent = b.agent, track = b.track || "etf", text = String(b.text || "").trim();
    const allowed = manualAgents();
    if (!allowed.includes(agent)) throw new Error("agent must be one of: " + allowed.join(", "));
    if (!tracks().includes(track)) throw new Error("unknown track");
    if (!text.includes("{")) throw new Error("the pasted text contains no JSON");
    const stamp = nowISO().replace(/[-:]/g, "").replace("T", "-");
    const name = track === "stocks" ? `${agent}-stocks-${stamp}.txt` : `${agent}-${stamp}.txt`;
    const msgs = [];
    const entry = { name, modified: nowISO().slice(0, 16), agent, track };
    try {
      const obj = extractJson(text);
      const td = today();
      let d = td;
      const claimed = String(obj.session_date || "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(claimed) && !isNaN(Date.parse(claimed + "T00:00:00Z"))) {
        const diff = daysBetween(claimed, td);
        if (diff >= 0 && diff <= 7) d = claimed;
      }
      await record(agent, text, obj, d, m => msgs.push(m), track);
    } catch (e) {
      msgs.push(`  ${name}: FAILED — ${e.message}`);
      entry.error = e.message; entry.text = text;
    }
    DB.inbox.push(entry);
    if (DB.inbox.length > 200) DB.inbox = DB.inbox.slice(-200);
    msgs.forEach(log);
    save();
    return { saved: name, log: msgs, error: entry.error };
  };
  P["investor/follow"] = b => {
    const d = validDate(b.date);
    (DB.investors[b.id] = DB.investors[b.id] || { active: 1 }).follow_date = d;
    save(); return { ok: true };
  };
  P["investor/active"] = b => {
    (DB.investors[b.id] = DB.investors[b.id] || { follow_date: SEED.as_of }).active = b.active === false ? 0 : 1;
    save(); return { ok: true };
  };
  P["investor/holdings"] = async b => {
    const asOf = validDate(b.as_of);
    if (!SEED.investors.some(i => i.id === b.id)) throw new Error(`unknown investor ${b.id}`);
    const rows = [];
    for (const h of b.holdings || []) {
      const t = String(h.ticker).trim().toUpperCase();
      let w = toF(h.weight);
      if (w > 1.0001) w /= 100;
      if (t && w > 0) rows.push({ investor_id: b.id, as_of: asOf, ticker: t, weight: w, estimated: h.estimated ? 1 : 0, source: "manual" });
    }
    if (!rows.length) throw new Error("no holdings");
    for (const t of new Set(rows.map(r => r.ticker))) if (t !== "CASH") await ensure(t);
    DB.holdings = DB.holdings.filter(h => !(h.investor_id === b.id && h.as_of === asOf)).concat(rows);
    save(); return { ok: true };
  };
  P["investor/holdings/delete"] = b => {
    if (new Set(DB.holdings.filter(h => h.investor_id === b.id).map(h => h.as_of)).size <= 1)
      throw new Error("an investor needs at least one holdings snapshot");
    DB.holdings = DB.holdings.filter(h => !(h.investor_id === b.id && h.as_of === b.as_of));
    save(); return { ok: true };
  };
  P["portfolio/create"] = async b => ({ id: await pfCreate(b.name, b.benchmark, b.fx_fee ?? 0.015, b.notes || "") });
  P["portfolio/update"] = async b => {
    const p = pfGet(parseInt(b.id, 10));
    if (b.benchmark) p.benchmark = await ensure(b.benchmark);
    if (b.name != null) { const n = String(b.name).trim(); if (!n) throw new Error("name is required"); p.name = n; }
    if (b.fx_fee != null) p.fx_fee = parseFloat(b.fx_fee) || 0;
    if (b.notes != null) p.notes = b.notes;
    if (b.archived != null) p.archived = b.archived ? 1 : 0;
    save(); return { ok: true };
  };
  P["portfolio/delete"] = b => {
    const id = parseInt(b.id, 10);
    DB.transactions = DB.transactions.filter(x => x.portfolio_id !== id);
    DB.portfolios = DB.portfolios.filter(x => x.id !== id);
    save(); return { ok: true };
  };
  P["portfolio/tx"] = async b => { await addTx(parseInt(b.portfolio_id, 10), b); return { ok: true }; };
  P["portfolio/tx/delete"] = b => { DB.transactions = DB.transactions.filter(x => x.id !== parseInt(b.id, 10)); save(); return { ok: true }; };
  P["portfolio/from"] = async b => {
    const d = validDate(b.date || today());
    const amount = parseFloat(b.amount) || 1000;
    let weights, name;
    if (b.source === "investor") {
      const snaps = snapshots(b.id);
      if (!snaps.length) throw new Error(`unknown investor ${b.id}`);
      const eff = snaps.filter(s => s[0] <= d);
      const use = eff.length ? eff[eff.length - 1] : snaps[0];
      weights = Object.fromEntries(use[1].map(h => [h.ticker, h.weight]));
      name = b.name || "Copy — " + (SEED.investors.find(i => i.id === b.id) || {}).name;
    } else {
      const rid = parseInt(b.id, 10), r = DB.responses.find(x => x.id === rid);
      if (!r) throw new Error("unknown reply");
      const s = DB.sessions.find(x => x.id === r.session_id);
      weights = allocOf(rid);
      name = b.name || `AI picks — ${r.agent} ${s.created_at.slice(0, 7)}`;
    }
    const [id, errors] = await createFromWeights(name, weights, amount, d, CONFIG.lab.benchmark, trackCfg("stocks").fx_fee, name);
    return { id, errors };
  };
  P["inbox/clear"] = b => { DB.inbox = DB.inbox.filter(x => (b.failed ? !x.error : !!x.error)); save(); return { ok: true }; };
  P["missing/clear"] = () => { DB.missing = []; save(); return { ok: true }; };

  // ------------------------------------------------------------------ backup / restore / import
  function exportData() { return { app: "portfolio-simulator", exported: nowISO(), db: DB }; }
  function importData(obj) {
    const d = obj && obj.db ? obj.db : obj;
    if (!d || typeof d !== "object" || !Array.isArray(d.portfolios) || !Array.isArray(d.sessions)) throw new Error("this file is not a Portfolio Simulator backup");
    DB = Object.assign(emptyDb(), d);
    save(); seed();
  }
  function resetAll() { DB = emptyDb(); save(); seed(); }
  // rows: {table: [objects]} read from the desktop app's lab.db (see index.html → System → Data)
  function importDesktop(rows) {
    const T = k => rows[k] || [];
    const d = emptyDb();
    d.sessions = T("sessions").map(s => ({ id: s.id, created_at: s.created_at, question: s.question, context: s.context || "",
      universe: s.universe || "null", track: s.track || "etf" }));
    d.responses = T("responses").map(r => ({ id: r.id, session_id: r.session_id, agent: r.agent, model: r.model, round: r.round || 1,
      raw_text: r.raw_text || "", analysis: r.analysis, risks: r.risks, created_at: r.created_at }));
    d.allocations = T("allocations").map(a => ({ id: a.id, response_id: a.response_id, ticker: a.ticker, weight: a.weight }));
    d.forecasts = T("forecasts").map(f => ({ id: f.id, response_id: f.response_id, kind: f.kind, ticker_a: f.ticker_a, ticker_b: f.ticker_b ?? null,
      threshold: f.threshold ?? null, start_date: f.start_date, resolve_date: f.resolve_date, probability: f.probability,
      rationale: f.rationale || "", outcome: f.outcome ?? null, brier: f.brier ?? null, resolved_at: f.resolved_at ?? null }));
    for (const i of T("investors")) d.investors[i.id] = { follow_date: i.follow_date, active: i.active == null ? 1 : i.active };
    d.holdings = T("investor_holdings").map(h => ({ investor_id: h.investor_id, as_of: h.as_of, ticker: h.ticker, weight: h.weight,
      estimated: h.estimated ? 1 : 0, source: h.source || "" }));
    d.portfolios = T("portfolios").map(p => ({ id: p.id, name: p.name, created_at: p.created_at, benchmark: p.benchmark,
      fx_fee: p.fx_fee, notes: p.notes || "", archived: p.archived ? 1 : 0 }));
    d.transactions = T("transactions").map(x => ({ id: x.id, portfolio_id: x.portfolio_id, date: x.date, type: x.type, ticker: x.ticker ?? null,
      quantity: x.quantity ?? null, price: x.price ?? null, fee: x.fee || 0, amount: x.amount ?? null, note: x.note ?? null, created_at: x.created_at }));
    const ids = [].concat(d.sessions, d.responses, d.allocations, d.forecasts, d.portfolios, d.transactions).map(x => x.id || 0);
    d.next = Math.max(0, ...ids) + 1;
    d.log = [`${nowISO().replace("T", " ")}  imported from the desktop app: ${d.portfolios.length} portfolios, ` +
      `${d.transactions.length} transactions, ${d.responses.length} replies, ${d.forecasts.length} forecasts`];
    const known = new Set(Object.keys(INDEX.tickers));
    d.missing = [...new Set(d.transactions.map(x => x.ticker).concat(d.allocations.map(a => a.ticker), d.holdings.map(h => h.ticker),
      d.portfolios.map(p => p.benchmark)).filter(t => t && t !== "CASH" && !known.has(t)))];
    DB = d;
    save(); seed();
    return { portfolios: d.portfolios.length, transactions: d.transactions.length, responses: d.responses.length, missing: d.missing };
  }

  // ------------------------------------------------------------------ entry points
  async function getJSON(url, fallback) {
    try { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) { if (fallback !== undefined) return fallback; throw new Error(`could not load ${url}: ${e.message}`); }
  }
  async function init() {
    [CONFIG, SEED, INDEX] = await Promise.all([getJSON("config.json"), getJSON("data/investors.json"),
      getJSON("data/index.json", { updated: null, last_close: null, tickers: {} })]);
    INDEX.tickers = INDEX.tickers || {};
    loadDb(); seed();
  }
  async function reload() {
    INDEX = await getJSON("data/index.json", INDEX);
    INDEX.tickers = INDEX.tickers || {};
    for (const k in PRICES) delete PRICES[k];
    loadDb();
  }
  function route(p) {
    const u = new URL(p, "http://x/");
    return [u.pathname.replace(/^\/api\//, ""), Object.fromEntries(u.searchParams.entries())];
  }
  async function get(p) {
    const [path, q] = route(p);
    const h = G[path];
    if (!h) throw new Error("not found: " + path);
    return await h(q);
  }
  async function post(p, body) {
    const [path] = route(p);
    const h = P[path];
    if (!h) throw new Error("not found: " + path);
    try { return await h(body || {}); }
    catch (e) { loadDb(); throw e; } // drop half-applied changes
  }
  return { init, reload, get, post, exportData, importData, importDesktop, resetAll,
    _test: { extractJson, validate, simulate, metrics, Book, pyDumps, businessDays, fname } };
})();
