"""Builds the site's price database (site/data/index.json + site/data/prices/<ticker>.json).

Runs every weekday in GitHub Actions (see .github/workflows/publish.yml); standard library only.
Source: Yahoo Finance chart API — adjusted closes (dividends included) + actual closes + currency.

Tickers fetched:
  - everything the app uses by default (site/config.json: fund universe, benchmarks, core questions,
    always_fetch; site/data/investors.json: holdings, listed vehicles, benchmarks)
  - every line of scripts/tickers.txt (add any company or fund you want to use on the site)
  - the exchange rate <CUR>CAD=X of every non-CAD currency found

If a download fails, the previous day's file (from --prev, the last published site) is kept.

    python scripts/build_data.py [--prev DIR] [--only AAPL,MSFT]
"""
import argparse
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = SITE / "data"
HISTORY = "2016-01-01"
UA = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
SUBUNITS = {"GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS"}
TICKER_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")


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
        print("ignored (not a Yahoo ticker):", ", ".join(bad))
    return sorted(x for x in t if TICKER_RE.match(x))


def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                raise
            if k == tries - 1:
                raise
        except Exception:
            if k == tries - 1:
                raise
        time.sleep(2 * (k + 1))


def download(ticker):
    p1 = int(datetime.fromisoformat(HISTORY).replace(tzinfo=timezone.utc).timestamp()) - 7 * 86400
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


def write(ticker, rows):
    ds = sorted(rows)
    if not ds:
        return None
    start = date.fromisoformat(ds[0])
    s = start.fromordinal(start.toordinal() - 1).isoformat()
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
    (OUT / "prices" / f"{fname(ticker)}.json").write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    return ds[0], ds[-1], r[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", help="folder of the previously published site (fallback data)")
    ap.add_argument("--only", help="comma-separated tickers (testing)")
    a = ap.parse_args()
    (OUT / "prices").mkdir(parents=True, exist_ok=True)
    prev_index = {}
    if a.prev and (Path(a.prev) / "data" / "index.json").is_file():
        prev_index = json.loads((Path(a.prev) / "data" / "index.json").read_text(encoding="utf-8")).get("tickers", {})
    tickers = a.only.split(",") if a.only else wanted()
    index, failed = {}, []

    def one(t):
        try:
            meta, rows = download(t)
            info = write(t, rows)
            if not info:
                raise ValueError("no prices")
            index[t] = {"n": meta.get("longName") or meta.get("shortName"), "c": meta.get("currency"),
                        "x": meta.get("fullExchangeName") or meta.get("exchangeName"), "y": meta.get("instrumentType"),
                        "f": info[0], "l": info[1], "p": info[2]}
            return True
        except Exception as e:
            old = Path(a.prev or "/nonexistent") / "data" / "prices" / f"{fname(t)}.json"
            if old.is_file() and t in prev_index:
                shutil.copy(old, OUT / "prices" / old.name)
                index[t] = prev_index[t]
                print(f"  {t}: {e} — kept the previous data")
            else:
                print(f"  {t}: {e} — skipped")
                failed.append(t)
            return False
        finally:
            time.sleep(0.25)

    print(f"{len(tickers)} tickers")
    for i, t in enumerate(tickers, 1):
        one(t)
        if i % 50 == 0:
            print(f"  {i}/{len(tickers)}")
    cur = set()
    for t, m in index.items():
        c = SUBUNITS.get(m.get("c") or "", m.get("c") or "")
        if c and c.upper() != "CAD" and m.get("y") != "CURRENCY":
            cur.add(c.upper())
    for c in sorted(cur):
        if f"{c}CAD=X" not in index:
            one(f"{c}CAD=X")
    closes = sorted(m["l"] for t, m in index.items() if not t.endswith("=X"))
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "last_close": closes[-1] if closes else None, "failed": sorted(failed), "tickers": dict(sorted(index.items()))}
    (OUT / "index.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"done: {len(index)} tickers, {len(failed)} failed, last close {out['last_close']}")
    if len(failed) > len(tickers) / 2:
        print("WARNING: most downloads failed — is Yahoo Finance reachable from here?")


if __name__ == "__main__":
    main()
