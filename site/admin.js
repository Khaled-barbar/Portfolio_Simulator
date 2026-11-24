/* Admin area: password, the two market-briefing prompts, checking the final JSON and publishing it.
 *
 * - admin.json holds a salted PBKDF2-SHA256 hash of the admin password (scripts/set_password.py --admin).
 *   The site is static, so the check runs in the browser: it keeps visitors out of the admin pages, but
 *   the real lock on publishing is the GitHub token, which only exists in the admin's own browser.
 * - Publishing writes site/data/briefing.json to the main branch through the GitHub API. The GitHub
 *   Action then republishes the site branch and Kinsta redeploys it (about 1-3 minutes).
 */
"use strict";
const Admin = (() => {
  const KEY = "ps_admin", TOKEN = "ps_admin_gh", LOCAL = "ps_briefing_local";
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const unhex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // ------------------------------------------------------------------ password
  let AUTH;
  async function auth() {
    if (AUTH !== undefined) return AUTH;
    try { const r = await fetch("admin.json", { cache: "no-cache" }); AUTH = r.ok ? await r.json() : null; } catch (e) { AUTH = null; }
    if (AUTH && !AUTH.hash) AUTH = null;
    return AUTH;
  }
  async function signedIn() { const a = await auth(); return !!a && ls.get(KEY) === a.hash; }
  async function signIn(pw) {
    const a = await auth();
    if (!a) return false;
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    const h = hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(a.salt), iterations: a.iter }, k, 256));
    if (h !== a.hash) return false;
    ls.set(KEY, h);
    return true;
  }
  function signOut() { ls.del(KEY); }

  // ------------------------------------------------------------------ prompts
  const COLLECT = `ROLE: You are a careful market research analyst. You collect today's market information for
the home page of a private investor's dashboard. A second AI will cross-check your report against
reports from other AIs, so accuracy and sources matter more than length.

TODAY: DATE
Cover the most recent completed trading session (write its date in "as_of") and the last 5 trading days.
INVESTOR: lives in Canada, invests in CAD in a Wealthsimple TFSA, long horizon (10-20 years). Reads this
to understand the market, not to trade on it.
HOLDINGS AND WATCHLIST: TICKERS

RULES
1. Search the web now, before writing. If you cannot browse, set "browsing": false, leave the lists
   empty and explain in "bottom_line". Never fill in numbers from memory.
2. Every number needs "source" (publisher) and "date" (YYYY-MM-DD). If you cannot attribute a number,
   leave the item out.
3. "status": "confirmed" only when a primary source (exchange, company release or filing, central bank,
   statistics agency) or a major outlet (Reuters, Bloomberg, AP, WSJ, FT, CNBC, Globe and Mail,
   BNN Bloomberg) reports it. Everything else is "unconfirmed" and goes in "unconfirmed" only.
4. Rate expectations: market-implied odds only (CME FedWatch for the Fed, OIS / market pricing for the
   Bank of Canada), with their date. Never your own estimate.
5. Canada first: always cover the S&P/TSX, USD/CAD and the Bank of Canada, and say what each news
   item means for a CAD investor (currency effect, Canadian-listed versions, US withholding tax, etc.).
6. Every explanation of WHY something moved gets "confidence": "high" | "medium" | "low".
7. No buy, sell or hold recommendations and no price targets of your own.
8. Percentages are plain numbers in percent: -1.25 means -1.25 %. Prices and levels are strings as
   published ("25,431.20"). Use null for anything unknown.
9. Reply with ONE JSON object only: no text before or after it, no Markdown, no comments, no trailing
   commas. Keep every key, even when its list is empty.

JSON TO FILL IN (the comments show what goes in each list; do not copy them)
{
  "schema": "ps-market/1",
  "agent": "your product and model name",
  "browsing": true,
  "as_of": "YYYY-MM-DD",
  "bottom_line": "3 sentences at most: what moved markets and why",
  "mood": "risk-on | risk-off | mixed",
  "indicators": [
    // 10 to 14 items: S&P/TSX, S&P 500, Nasdaq, Dow, Russell 2000, VIX, USD/CAD, US 10-year yield,
    // Canada 10-year yield, WTI oil, gold, bitcoin, Fed and Bank of Canada next-meeting odds
    {"name": "S&P/TSX Composite", "symbol": "^GSPTSE", "value": "25,431.20", "unit": "pts",
     "change_pct": -0.42, "period": "1d", "note": "one short line", "source": "Reuters", "date": "YYYY-MM-DD"}
  ],
  "quick_notes": [
    // 3 to 6 one-sentence takeaways for this investor
    {"text": "…", "tone": "positive | negative | caution | neutral", "confidence": "high | medium | low"}
  ],
  "holdings": [
    // one item per holding or watchlist ticker that had news or moved more than 2 % over 5 days
    {"ticker": "NVDA", "name": "NVIDIA", "price": "181.20", "currency": "USD", "change_pct": 3.1, "period": "5d",
     "note": "what happened and why, one sentence", "confidence": "medium", "source": "…", "date": "YYYY-MM-DD"}
  ],
  "gainers": [
    // 6 biggest gainers of the last session among large caps (over 2 billion USD), mix of US and Canada
    {"ticker": "…", "name": "…", "exchange": "TSX | NYSE | NASDAQ", "change_pct": 8.4, "period": "1d",
     "reason": "one sentence", "confidence": "high", "source": "…", "date": "YYYY-MM-DD"}
  ],
  "losers": [
    // 6 biggest losers, same rules as gainers
  ],
  "news": [
    // 6 to 10 most important market stories of the last 72 hours
    {"headline": "…", "summary": "1-2 sentences", "why_it_matters_cad": "one sentence",
     "tickers": ["…"], "status": "confirmed", "confidence": "high", "source": "…", "date": "YYYY-MM-DD", "url": "https://…"}
  ],
  "calendar": [
    // 4 to 8 scheduled events in the next 3 weeks, from official calendars
    {"date": "YYYY-MM-DD", "event": "…", "why": "one sentence", "source": "…"}
  ],
  "unconfirmed": [
    // rumours, single-source reports, disputed claims
    {"claim": "…", "source": "…", "date": "YYYY-MM-DD"}
  ],
  "sources": [
    {"publisher": "…", "title": "…", "date": "YYYY-MM-DD", "url": "https://…"}
  ]
}`;

  const LANG_RULES = {
    both: `Every human-readable text field (bottom_line, editor_note, note, text, reason, headline, summary,
   why_it_matters_cad, event, why, claim, topic, positions, resolution, disclaimer) is an object with an
   English and an Arabic version: {"en": "…", "ar": "…"}. The Arabic is clear Modern Standard Arabic; keep
   tickers, numbers and publisher names in Latin letters. Names, tickers, sources, dates and URLs stay
   plain strings.`,
    en: `All text fields are plain strings in English.`,
    ar: `All human-readable text fields are plain strings in clear Modern Standard Arabic; keep tickers,
   numbers and publisher names in Latin letters. Names, tickers, sources, dates and URLs stay as they are.`,
  };

  const MERGE = `ROLE: You are the editor-in-chief of a market dashboard. Below are market reports written today
(DATE) by AGENT_LIST, each answering the same prompt. Cross-check them and produce ONE final,
verified JSON object that will be published as-is on the investor's home page.

INVESTOR: lives in Canada, invests in CAD in a Wealthsimple TFSA, long horizon.
HOLDINGS AND WATCHLIST: TICKERS

STEPS
1. Search the web to verify the claims. Your own check beats any single report. If you cannot browse,
   say so in "editor_note" and keep only items that at least two reports agree on.
2. Numbers that disagree: check the source and keep the most recent figure from a primary source or a
   major outlet. If the difference is tiny (under 0.1 percentage point), keep the most recent one. If you
   cannot resolve it, leave the item out and record it in "disagreements".
3. Remove: items without a source and a date, items older than 7 days (except "calendar"), duplicate
   stories, and anything that is advice to buy, sell or hold.
4. Items with "status": "unconfirmed", or that only one report has and you cannot verify, go in
   "unconfirmed" only (with "status": "unverified", "disputed" or "wrong").
5. Fill "agreement" on every item: "3/3", "2/3", "1/3" (how many reports had it, verified by you) or
   "editor" for things you added yourself. Use "2/2" / "1/2" when there are two reports.
6. Gainers and losers: all from the same session, large caps only, re-checked; at most 6 each.
7. Keep the lists within the limits of the schema below, and the whole thing short and plain.
8. Language: LANG_RULE
9. Reply with ONE JSON object only: no text before or after it, no Markdown fences, no comments, no
   trailing commas. Percentages are plain numbers in percent (-1.25 means -1.25 %). Use null when unknown.

FINAL JSON SCHEMA (keep every key)
{
  "schema": "ps-briefing/1",
  "as_of": "YYYY-MM-DD (the latest completed trading session)",
  "generated_at": "YYYY-MM-DDTHH:MM:SSZ",
  "agents": ["chatgpt", "gemini", "claude"],
  "editor": "your product and model name",
  "editor_note": "one line on how you checked, or what you could not check",
  "mood": "risk-on | risk-off | mixed",
  "bottom_line": "3 sentences at most",
  "indicators": [ {"name", "symbol", "value", "unit", "change_pct", "period", "note", "source", "date", "agreement"} ],
  "quick_notes": [ {"text", "tone": "positive | negative | caution | neutral", "confidence", "agreement"} ],
  "holdings": [ {"ticker", "name", "price", "currency", "change_pct", "period", "note", "confidence", "source", "date", "agreement"} ],
  "gainers": [ {"ticker", "name", "exchange", "change_pct", "period", "reason", "confidence", "source", "date", "agreement"} ],
  "losers": [ same as gainers ],
  "news": [ {"headline", "summary", "why_it_matters_cad", "tickers": [], "confidence", "source", "date", "url", "agreement"} ],
  "calendar": [ {"date", "event", "why", "source"} ],
  "unconfirmed": [ {"claim", "from": ["gemini"], "status": "unverified | disputed | wrong", "note"} ],
  "disagreements": [ {"topic", "positions": "who said what", "resolution": "what you kept and why"} ],
  "sources": [ {"publisher", "title", "date", "url"} ],
  "disclaimer": "General information, not personalised financial advice."
}
Limits: indicators 14, quick_notes 6, holdings 15, gainers 6, losers 6, news 10, calendar 8, sources 25.

REPORTS`;

  const AGENTS = [["chatgpt", "ChatGPT"], ["gemini", "Gemini"], ["claude", "Claude"]];
  const fill = (s, pairs) => pairs.reduce((a, [k, v]) => a.split(k).join(v), s);
  function collectPrompt(ctx) { return fill(COLLECT, [["DATE", ctx.today], ["TICKERS", ctx.tickers]]); }
  function mergePrompt(ctx, replies, lang) {
    const got = AGENTS.filter(([k]) => (replies[k] || "").trim());
    const names = got.map(([, n]) => n);
    const list = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0] || "several AI assistants";
    const body = got.map(([k, n], i) => `\n\n--- REPORT ${i + 1}: ${n} ---\n${tidy(replies[k])}`).join("") || "\n\n[paste the reports here]";
    return fill(MERGE, [["DATE", ctx.today], ["AGENT_LIST", list], ["TICKERS", ctx.tickers], ["LANG_RULE", LANG_RULES[lang] || LANG_RULES.both]]) +
      body + "\n\n--- END OF REPORTS ---";
  }
  const tidy = t => { const j = extract(t); return j ? JSON.stringify(j, null, 1) : String(t).trim(); };

  // ------------------------------------------------------------------ reading and checking the JSON
  function extract(text) {
    let s = String(text || "").trim().replace(/^﻿/, "");
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { /* try the usual AI slips below */ }
    try {
      return JSON.parse(s.replace(/[“”]/g, '"').replace(/\/\/[^\n"]*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
    } catch (e) { return null; }
  }
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const str = v => (v == null ? null : typeof v === "string" ? v.trim().slice(0, 1200) || null : typeof v === "number" ? String(v) : null);
  const txt = v => {                       // plain string, or {en, ar}
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = {}; for (const k of ["en", "ar"]) { const s = str(v[k]); if (s) o[k] = s; }
      return Object.keys(o).length ? o : null;
    }
    return str(v);
  };
  const numv = v => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[%,+\s]/g, "")); return isFinite(n) ? n : null; };
  const url = v => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null);
  const date = v => { const s = str(v); return s && DATE.test(s.slice(0, 10)) ? s.slice(0, 10) : s; };
  const oneOf = (v, opts) => { const s = (str(v) || "").toLowerCase(); return opts.includes(s) ? s : null; };
  const CONF = ["high", "medium", "low"];
  const FIELDS = {
    indicators: { max: 16, f: x => ({ name: str(x.name), symbol: str(x.symbol), value: str(x.value), unit: str(x.unit), change_pct: numv(x.change_pct),
      period: str(x.period), note: txt(x.note), source: str(x.source), date: date(x.date), agreement: str(x.agreement) }), need: "name" },
    quick_notes: { max: 8, f: x => (typeof x === "string" ? { text: x } : { text: txt(x.text), tone: oneOf(x.tone, ["positive", "negative", "caution", "neutral"]),
      confidence: oneOf(x.confidence, CONF), agreement: str(x.agreement) }), need: "text" },
    holdings: { max: 20, f: x => ({ ticker: str(x.ticker), name: str(x.name), price: str(x.price), currency: str(x.currency), change_pct: numv(x.change_pct),
      period: str(x.period), note: txt(x.note), confidence: oneOf(x.confidence, CONF), source: str(x.source), date: date(x.date), agreement: str(x.agreement) }), need: "ticker" },
    gainers: { max: 10, f: x => mover(x), need: "ticker" },
    losers: { max: 10, f: x => mover(x), need: "ticker" },
    news: { max: 14, f: x => ({ headline: txt(x.headline), summary: txt(x.summary), why_it_matters_cad: txt(x.why_it_matters_cad),
      tickers: Array.isArray(x.tickers) ? x.tickers.map(str).filter(Boolean).slice(0, 8) : [], status: oneOf(x.status, ["confirmed", "unconfirmed"]),
      confidence: oneOf(x.confidence, CONF), source: str(x.source), date: date(x.date), url: url(x.url), agreement: str(x.agreement) }), need: "headline" },
    calendar: { max: 12, f: x => ({ date: date(x.date), event: txt(x.event), why: txt(x.why), source: str(x.source) }), need: "event" },
    unconfirmed: { max: 12, f: x => ({ claim: txt(x.claim), from: Array.isArray(x.from) ? x.from.map(str).filter(Boolean) : str(x.from) ? [str(x.from)] : [],
      status: oneOf(x.status, ["unverified", "disputed", "wrong"]), note: txt(x.note), source: str(x.source), date: date(x.date) }), need: "claim" },
    disagreements: { max: 12, f: x => ({ topic: txt(x.topic), positions: txt(x.positions), resolution: txt(x.resolution) }), need: "topic" },
    sources: { max: 40, f: x => ({ publisher: str(x.publisher), title: str(x.title), date: date(x.date), url: url(x.url) }), need: "publisher" },
  };
  function mover(x) {
    return { ticker: str(x.ticker), name: str(x.name), exchange: str(x.exchange), change_pct: numv(x.change_pct), period: str(x.period),
      reason: txt(x.reason), confidence: oneOf(x.confidence, CONF), source: str(x.source), date: date(x.date), agreement: str(x.agreement) };
  }
  /** Returns {ok, data, errors[], warnings[]} — data is the cleaned briefing that gets published. */
  function check(text, today) {
    const errors = [], warnings = [];
    const j = typeof text === "string" ? extract(text) : text;
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, data: null, errors: ["no JSON object found — paste the whole reply"], warnings };
    const schema = str(j.schema) || "";
    if (!/^ps-(briefing|market)\//.test(schema)) warnings.push(`"schema" is "${schema || "missing"}", expected "ps-briefing/1"`);
    if (schema.startsWith("ps-market/")) warnings.push("this is a single agent's report, not the cross-checked final version");
    if (j.browsing === false) warnings.push("the agent says it could not browse the web: the numbers may be out of date");
    const d = {
      schema: "ps-briefing/1", as_of: date(j.as_of), generated_at: str(j.generated_at) || new Date().toISOString().slice(0, 19) + "Z",
      agents: Array.isArray(j.agents) ? j.agents.map(str).filter(Boolean).slice(0, 6) : str(j.agent) ? [str(j.agent)] : [],
      editor: str(j.editor) || str(j.agent), editor_note: txt(j.editor_note), mood: oneOf(j.mood, ["risk-on", "risk-off", "mixed"]),
      bottom_line: txt(j.bottom_line), disclaimer: txt(j.disclaimer), published_at: null,
    };
    if (!d.as_of || !DATE.test(d.as_of)) errors.push('"as_of" must be a date like 2026-11-24');
    else if (today) {
      const age = Math.round((new Date(today) - new Date(d.as_of)) / 864e5);
      if (age > 4) warnings.push(`"as_of" is ${age} days before today`);
      if (age < -1) warnings.push(`"as_of" is in the future`);
    }
    if (!d.bottom_line) warnings.push('"bottom_line" is empty');
    let nosrc = 0, total = 0;
    for (const [k, spec] of Object.entries(FIELDS)) {
      const raw = j[k];
      if (raw != null && !Array.isArray(raw)) warnings.push(`"${k}" should be a list`);
      const list = (Array.isArray(raw) ? raw : []).filter(x => x && (typeof x === "object" || typeof x === "string")).map(spec.f).filter(x => x[spec.need]);
      if (list.length > spec.max) warnings.push(`"${k}": kept the first ${spec.max} of ${list.length}`);
      d[k] = list.slice(0, spec.max);
      if (["indicators", "holdings", "gainers", "losers", "news"].includes(k))
        for (const x of d[k]) { total++; if (!x.source || !x.date) nosrc++; }
    }
    if (nosrc) warnings.push(`${nosrc} of ${total} items have no source or no date`);
    const filled = Object.keys(FIELDS).filter(k => d[k].length).length;
    if (!filled && !d.bottom_line) errors.push("the briefing is empty");
    return { ok: !errors.length, data: d, errors, warnings };
  }

  // ------------------------------------------------------------------ local preview (this browser only)
  const localPreview = {
    get: () => { try { return JSON.parse(ls.get(LOCAL) || "null"); } catch (e) { return null; } },
    set: d => ls.set(LOCAL, JSON.stringify(d)),
    clear: () => ls.del(LOCAL),
  };

  // ------------------------------------------------------------------ publishing through the GitHub API
  const gh = {
    get: () => { try { return JSON.parse(ls.get(TOKEN) || "null") || {}; } catch (e) { return {}; } },
    set: o => ls.set(TOKEN, JSON.stringify(o)),
    clear: () => ls.del(TOKEN),
  };
  const PATH = "site/data/briefing.json";
  const b64 = s => { const b = new TextEncoder().encode(s); let o = ""; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
  async function ghFetch(method, path, body) {
    const g = gh.get();
    if (!g.token || !g.repo) throw new Error("add a GitHub token in Admin → Settings first");
    const r = await fetch(`https://api.github.com/repos/${g.repo}/${path}`, {
      method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${g.token}`, "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !(method === "GET" && r.status === 404)) {
      const why = r.status === 401 ? "the token is wrong or expired" : r.status === 403 || r.status === 404 ? "the token cannot write to this repository (it needs Contents: Read and write)" : j.message || r.status;
      throw new Error(`GitHub: ${why}`);
    }
    return r.ok ? j : null;
  }
  async function testToken() {
    const g = gh.get(), repo = await ghFetch("GET", "");
    if (!repo) throw new Error(`GitHub: repository ${g.repo} not found for this token`);
    if (repo.permissions && !repo.permissions.push) throw new Error("GitHub: this token can read but not write the repository");
    return { repo: repo.full_name, branch: g.branch || repo.default_branch };
  }
  async function publish(data) {
    const g = gh.get(), branch = g.branch || "main";
    const out = { ...data, published_at: new Date().toISOString().slice(0, 19) + "Z" };
    const cur = await ghFetch("GET", `contents/${PATH}?ref=${encodeURIComponent(branch)}`);
    const res = await ghFetch("PUT", `contents/${PATH}`, {
      message: `Market briefing ${out.as_of}`, branch, content: b64(JSON.stringify(out, null, 1) + "\n"), ...(cur && cur.sha ? { sha: cur.sha } : {}) });
    return { commit: res && res.commit ? res.commit.html_url : null, actions: `https://github.com/${g.repo}/actions`, data: out };
  }
  async function unpublish() {
    const g = gh.get(), branch = g.branch || "main";
    const cur = await ghFetch("GET", `contents/${PATH}?ref=${encodeURIComponent(branch)}`);
    if (!cur) return false;
    await ghFetch("DELETE", `contents/${PATH}`, { message: "Remove market briefing", branch, sha: cur.sha });
    return true;
  }

  return { auth, signedIn, signIn, signOut, AGENTS, collectPrompt, mergePrompt, extract, check, localPreview, gh, testToken, publish, unpublish };
})();
