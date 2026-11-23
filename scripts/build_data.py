"""Builds the site's price database and (optionally) publishes the site. Run it on YOUR computer:

    python scripts/build_data.py              download/refresh prices into site/data/
    python scripts/build_data.py --publish    ... then push the finished site to the `site` branch
                                              (Kinsta deploys that branch automatically)

Windows: double-click scripts/publish_prices.bat. Linux/macOS: scripts/publish_prices.sh.
Needs Python 3.11+ and Git (with access to this repository). Standard library only.

Source: Yahoo Finance chart API — adjusted closes (dividends included), actual closes, currency.
Prices are downloaded from your own connection, the same way the Agents Lab desktop app does it.
After the first run, only the last few weeks are downloaded per ticker (site/data/prices is a local
cache, ignored by git on main); the whole history is downloaded again when a new dividend or split
changed the adjusted prices.

Market page: after the prices, data/market.json is written with the returns of every security in the
database (for the top movers), Yahoo's trending tickers (US and Canada) and recent market headlines.
If that part fails, the prices are still published.

Tickers: everything the app uses (site/config.json, site/data/investors.json), every line of
scripts/tickers.txt, and the exchange rate <CUR>CAD=X of every non-CAD currency.
If a download fails, the ticker's previous data is kept.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = SITE / "data"
HISTORY = "2016-01-01"
UA = {"user-agent": "Mozilla/5.0"}
SUBUNITS = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}
TICKER_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")


def say(*a):
    print(*a, flush=True)


def fname(t):
    return re.sub(r"[^A-Za-z0-9.\-]", lambda m: "_%02x" % ord(m.group()), t)


def wanted():
    cfg = json.loads((SITE / "config.json").read_text(encoding="utf-8"))
    inv = json.loads((OUT / "investors.json").read_text(encoding="utf-8"))
    t = set(cfg["lab"]["universe"]) | {cfg["lab"]["benchmark"]}
    st = cfg.get("stocks", {})
    t |= {st.get("benchmark", "XEQT.TO")} | set(st.get("compare", []))
    for c in cfg["lab"].get("core_forecasts", []) + st.get("core_forecasts", []):
        t |= {c["ticker_a"], c.get("ticker_b")}
    t |= set(cfg.get("always_fetch", []))
    home = cfg.get("home", {})
    t |= set(home.get("indices", [])) | set(home.get("watchlist", []))
    for i in inv["investors"]:
        t |= {h["ticker"] for h in i["holdings"]} | set(i.get("benchmarks", [])) | {i.get("proxy")}
    f = ROOT / "scripts" / "tickers.txt"
    if f.is_file():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.split("#")[0].strip().upper()
            if line:
                t.add(line)
    t.discard(None)
    t.discard("CASH")
    bad = sorted(x for x in t if not TICKER_RE.match(x))
    if bad:
        say("ignored (not a Yahoo ticker):", ", ".join(bad))
    return sorted(x for x in t if TICKER_RE.match(x))


class Refused(Exception):
    """Yahoo answered 429/403: it is limiting this connection."""


def get(url, tries=3):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                raise ValueError(f"HTTP {e.code} (unknown ticker?)")
            if e.code in (403, 429):
                raise Refused(f"HTTP {e.code}")
            if k == tries - 1:
                raise
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(2 * (k + 1))


def download(ticker, start):
    p1 = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp()) - 7 * 86400
    p2 = int(time.time()) + 86400
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}"
           f"?period1={p1}&period2={p2}&interval=1d&events=div%7Csplit")
    res = get(url)["chart"]["result"][0]
    ts = res.get("timestamp") or []
    ind = res["indicators"]
    raw = ind["quote"][0].get("close") or [None] * len(ts)
    adj = (ind.get("adjclose") or [{}])[0].get("adjclose") or raw
    meta = res.get("meta", {})
    offset = int(meta.get("gmtoffset") or 0)
    session = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    rows = {}
    for t, c, rc in zip(ts, adj, raw):
        if c is None:
            continue
        # a bar of today's session before the close is an intraday price, not a close: skip it
        if session and t >= session["start"] - 6 * 3600 and time.time() < session["end"]:
            continue
        d = datetime.fromtimestamp(t + offset, tz=timezone.utc).date().isoformat()
        rows[d] = (c, rc if rc is not None else c)
    return meta, rows


def sig(x):
    return float(f"{x:.7g}")


def path_of(t):
    return OUT / "prices" / f"{fname(t)}.json"


def read(t):
    """Stored rows {date: (adj, raw)} or None."""
    p = path_of(t)
    if not p.is_file():
        return None
    j = json.loads(p.read_text(encoding="utf-8"))
    d, rows = date.fromisoformat(j["s"]), {}
    for g, a, r in zip(j["g"], j["a"], j.get("r", j["a"])):
        d += timedelta(days=g)
        rows[d.isoformat()] = (a, r)
    return rows


def write(ticker, rows):
    ds = sorted(rows)
    if not ds:
        return None
    s = (date.fromisoformat(ds[0]) - timedelta(days=1)).isoformat()
    gaps, prev = [], date.fromisoformat(s)
    for d in ds:
        cur = date.fromisoformat(d)
        gaps.append((cur - prev).days)
        prev = cur
    a = [sig(rows[d][0]) for d in ds]
    r = [sig(rows[d][1]) for d in ds]
    obj = {"t": ticker, "s": s, "g": gaps, "a": a}
    if r != a:
        obj["r"] = r
    path_of(ticker).write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    return ds[0], ds[-1], r[-1]


def refresh(t, full=False):
    """Incremental download; full history again if old adjusted prices changed (new dividend/split)."""
    old = None if full else read(t)
    if old:
        s2 = (date.fromisoformat(max(old)) - timedelta(days=12)).isoformat()
        meta, new = download(t, s2)
        same = [d for d in new if d in old]
        if same and all(abs(new[d][0] / old[d][0] - 1) < 1e-4 for d in same):
            return meta, {**{d: v for d, v in old.items() if d < s2}, **new}
    return download(t, HISTORY)


def build(only=None, full=False):
    (OUT / "prices").mkdir(parents=True, exist_ok=True)
    prev_index = {}
    if (OUT / "index.json").is_file():
        prev_index = json.loads((OUT / "index.json").read_text(encoding="utf-8")).get("tickers", {})
    tickers = only or wanted()
    index, failed, kept = (dict(prev_index) if only else {}), [], []  # --only: update those, keep the rest
    refused = 0

    def one(t):
        nonlocal refused
        try:
            if refused >= 15:
                raise Refused("skipped: Yahoo kept refusing")
            meta, rows = refresh(t, full)
            info = write(t, rows)
            if not info:
                raise ValueError("no prices")
            index[t] = {"n": meta.get("longName") or meta.get("shortName"), "c": meta.get("currency"),
                        "x": meta.get("fullExchangeName") or meta.get("exchangeName"), "y": meta.get("instrumentType"),
                        "f": info[0], "l": info[1], "p": info[2]}
            refused = 0
        except Exception as e:
            if isinstance(e, Refused) and "skipped" not in str(e):
                refused += 1
                time.sleep(5)
            if path_of(t).is_file() and t in prev_index:
                index[t] = prev_index[t]
                kept.append(t)
                say(f"  {t}: {e} — kept the previous data")
            else:
                failed.append(t)
                say(f"  {t}: {e} — skipped")
        finally:
            time.sleep(0.3)

    say(f"{len(tickers)} tickers")
    for i, t in enumerate(tickers, 1):
        one(t)
        if i % 50 == 0:
            say(f"  {i}/{len(tickers)}")
    cur = set()
    for t, m in index.items():
        c = SUBUNITS.get(m.get("c") or "", m.get("c") or "")
        if c and c.upper() != "CAD" and m.get("y") != "CURRENCY":
            cur.add(c.upper())
    for c in sorted(cur):
        if f"{c}CAD=X" not in index and f"{c}CAD=X" not in failed:
            one(f"{c}CAD=X")
    closes = sorted(m["l"] for t, m in index.items() if not t.endswith("=X"))
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "last_close": closes[-1] if closes else None, "failed": sorted(failed), "tickers": dict(sorted(index.items()))}
    (OUT / "index.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    say(f"prices: {len(index) - len(kept)} updated, {len(kept)} kept from before, {len(failed)} missing; "
        f"last close {out['last_close']}")
    if refused >= 15:
        say("WARNING: Yahoo Finance refused many requests (HTTP 429). Try again in an hour.")
    return out


# ---------------------------------------------------------------- market page (data/market.json)
NEWS_QUERIES = ["stock market", "S&P 500", "TSX", "Nasdaq", "Federal Reserve", "Bank of Canada"]
TRENDING_REGIONS = ["US", "CA"]


def _back(ds, a, days):
    """Adjusted close on or before (last date - days), or None if the history is too short."""
    target = (date.fromisoformat(ds[-1]) - timedelta(days=days)).isoformat()
    for i in range(len(ds) - 1, -1, -1):
        if ds[i] <= target:
            return a[i] if (date.fromisoformat(target) - date.fromisoformat(ds[i])).days <= 7 else None
    return None


def perf_of(rows):
    """[1D, 5D, 1M, YTD, 1Y, distance from the 52-week high] from {date: (adj, raw)}; the same
    definitions as the site's engine.js (G.home)."""
    ds = sorted(rows)
    if len(ds) < 2:
        return None
    a = [rows[d][0] for d in ds]
    last = a[-1]
    r = lambda p: None if not p else round(last / p - 1, 5)
    ytd_ref = None
    y0 = f"{ds[-1][:4]}-01-01"
    for i in range(len(ds) - 1, -1, -1):
        if ds[i] < y0:
            ytd_ref = a[i]
            break
    year = [x for d, x in zip(ds, a) if d > (date.fromisoformat(ds[-1]) - timedelta(days=365)).isoformat()]
    return [r(a[-2]), r(a[-6]) if len(a) > 5 else None, r(_back(ds, a, 30)), r(ytd_ref), r(_back(ds, a, 365)),
            round(last / max(year) - 1, 5) if year else None]


def safe_link(u):
    return u if isinstance(u, str) and re.match(r"^https?://", u) else None


def market(index):
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "perf": {}, "trending": [], "news": []}
    for t, m in index.items():
        if t.endswith("=X") or m.get("y") == "CURRENCY":
            continue
        rows = read(t)
        p = perf_of(rows) if rows else None
        if p:
            out["perf"][t] = p
    seen = set()
    for region in TRENDING_REGIONS:
        try:
            qs = get(f"https://query1.finance.yahoo.com/v1/finance/trending/{region}?count=12")["finance"]["result"][0]["quotes"]
        except Exception as e:
            say(f"  trending {region}: {e}")
            continue
        for q in qs:
            t = str(q.get("symbol") or "").upper()
            if not TICKER_RE.match(t) or t in seen or t.endswith("=X") or t.endswith("=F"):
                continue
            seen.add(t)
            try:
                res = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(t)}?range=2mo&interval=1d")["chart"]["result"][0]
                meta = res.get("meta", {})
                closes = [c for c in (res["indicators"]["quote"][0].get("close") or []) if c is not None]
                price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
                prev = meta.get("chartPreviousClose")
                prev_day = closes[-2] if len(closes) > 1 else None
                ch = lambda p: None if not (price and p) else round(price / p - 1, 5)
                out["trending"].append({"t": t, "region": region, "n": meta.get("longName") or meta.get("shortName"),
                                        "y": meta.get("instrumentType"), "c": meta.get("currency"), "p": price,
                                        "d1": ch(prev_day), "m1": ch(closes[-22] if len(closes) > 21 else prev),
                                        "s": [round(x, 4) for x in closes[-30:]]})
            except Exception as e:
                say(f"  trending {t}: {e}")
            time.sleep(0.3)
    news = {}
    for q in NEWS_QUERIES:
        try:
            items = get(f"https://query1.finance.yahoo.com/v1/finance/search?q={urllib.parse.quote(q)}"
                        f"&quotesCount=0&newsCount=8")["news"]
        except Exception as e:
            say(f"  news '{q}': {e}")
            continue
        for n in items:
            link = safe_link(n.get("link"))
            key = n.get("uuid") or link
            if not link or not n.get("title") or key in news:
                continue
            news[key] = {"title": n["title"], "publisher": n.get("publisher"), "link": link,
                         "time": n.get("providerPublishTime"),
                         "tickers": [x for x in (n.get("relatedTickers") or []) if TICKER_RE.match(str(x))][:6]}
        time.sleep(0.3)
    out["news"] = sorted(news.values(), key=lambda n: -(n["time"] or 0))[:24]
    (OUT / "market.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    say(f"market page: {len(out['perf'])} securities, {len(out['trending'])} trending, {len(out['news'])} headlines")


def git(*args, cwd=ROOT, check=True):
    return subprocess.run(["git", *args], cwd=cwd, check=check, text=True, capture_output=True)


def publish(branch="site"):
    """Push site/ (code + data) as a single commit to `branch` of this repository's origin."""
    if not (OUT / "index.json").is_file():
        sys.exit("no price data yet — run without --no-download first")
    try:
        url = git("remote", "get-url", "origin").stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        sys.exit("git not found, or this folder is not a clone of the repository "
                 "(git clone https://github.com/Khaled-barbar/Portfolio_Simulator)")
    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / "site"
        shutil.copytree(SITE, dst)
        git("init", "-q", cwd=dst)
        git("checkout", "-q", "-b", branch, cwd=dst)
        git("add", "-A", cwd=dst)
        name = git("config", "user.name", check=False).stdout.strip() or "Portfolio Simulator"
        mail = git("config", "user.email", check=False).stdout.strip() or "publisher@localhost"
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        git("-c", f"user.name={name}", "-c", f"user.email={mail}", "commit", "-q", "-m", f"Prices {stamp}", cwd=dst)
        say(f"publishing to {branch} …")
        r = subprocess.run(["git", "push", "-f", url, f"HEAD:{branch}"], cwd=dst, text=True)
        if r.returncode:
            sys.exit("git push failed — check that Git can push to the repository (sign in when Git asks)")
    say("published ✓ — Kinsta redeploys the site in a minute or two")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--publish", action="store_true", help="push the site to the `site` branch afterwards")
    ap.add_argument("--no-download", action="store_true", help="publish the prices already downloaded")
    ap.add_argument("--full", action="store_true", help="re-download the full history of every ticker")
    ap.add_argument("--only", help="comma-separated tickers (testing)")
    ap.add_argument("--no-pull", action="store_true", help="do not update the code with git pull first")
    a = ap.parse_args()
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if a.publish and not a.no_pull:
        r = subprocess.run(["git", "pull", "--ff-only", "-q"], cwd=ROOT, text=True, capture_output=True)
        if r.returncode:
            say("note: git pull failed — publishing the code as it is in this folder\n  " + (r.stderr or "").strip())
    if not a.no_download:
        out = build(a.only.split(",") if a.only else None, a.full)
        if not out["tickers"]:
            sys.exit("no price data at all — is Yahoo Finance reachable?")
        try:
            market(out["tickers"])
        except Exception as e:  # the market page is optional: never block the price publish
            say(f"market page not updated: {e}")
    if a.publish:
        publish()


if __name__ == "__main__":
    main()
