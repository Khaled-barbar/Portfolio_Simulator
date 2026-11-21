# Portfolio Simulator

Simulator for ETF and stock portfolios. This is the website version of
[Agents Lab](https://github.com/Khaled-barbar/WS_AI_Trading_Simulator), built as a static site
(HTML + JavaScript, no server). You can host it on Kinsta Static Site Hosting or on any static host.

It has the same dashboard as the desktop app, in Arabic and English:

- **Fund lab (AI)** and **Stock picks (AI):** paste the monthly replies from Gemini, ChatGPT and Claude.
  Each reply's forecasts are resolved automatically and scored with the Brier score. Each allocation is
  tracked as a paper portfolio in CAD after the FX fee.
- **Investors:** the 30 investors from the Investor Watchlist. Includes a copy simulator in CAD, period
  filters, follow dates and your own holdings snapshots.
- **My portfolios:** your own portfolios with buys, sells, deposits and withdrawals. Each one is compared
  with a benchmark that gets the same deposits.
- **System:** inbox for pasting replies, prompts, report, and **Data** (price database, backup, restore,
  import from the desktop app).

## How it works

```
main branch                                   site branch (generated, deployed by Kinsta)
├── site/            the website              ├── index.html, engine.js, …
│   ├── index.html   dashboard                └── data/
│   ├── engine.js    the app logic                ├── index.json        list of securities
│   ├── config.json  experiment settings          └── prices/*.json     daily prices since 2016
│   └── data/investors.json
├── scripts/build_data.py   downloads prices from Yahoo Finance
├── scripts/tickers.txt     extra tickers to include
└── .github/workflows/publish.yml
```

- **Prices:** browsers can't call Yahoo Finance directly, so a GitHub Action
  (`.github/workflows/publish.yml`) downloads final daily closes. These are adjusted to include
  dividends and distributions, and come with the actual closes and currencies. The Action covers
  every ticker the app uses, plus everything in `scripts/tickers.txt` and the exchange rates to CAD.
  It writes the files into the site and force-pushes the finished site to the **`site`** branch.
  The `site` branch keeps one commit, so the repository doesn't grow.
  The Action runs on every push to `main`, every weekday after the markets close, and when you start it
  from *Actions → Publish site → Run workflow*. If a download fails, it keeps the previous day's prices.
- **Your data** (portfolios, transactions, agent replies, follow dates, snapshots) is stored **in your
  browser** (localStorage). It is never sent to a server. Use *System → Data*:
  - **Download a backup** / **Restore a backup** to save your data or move it to another browser or device.
  - **Import from the desktop app** to load the `lab.db` file from Agents Lab (Windows, Linux or Android).
    This copies over your portfolios, replies, forecasts, follow dates and snapshots.

The calculations are a line-by-line port of the Python app. On the same prices they give identical
results: copy simulator, portfolio valuation and time-weighted return, forecast resolution, Brier
scores, the report, and the prompt text sent to the agents.

## Deploy on Kinsta (Static Site Hosting)

1. **Build the site once.** Push to `main`, or open *Actions → Publish site → Run workflow*. Wait until
   it finishes (about 6–8 minutes) and check that a `site` branch exists.
   - If the Action can't push, go to *Settings → Actions → General → Workflow permissions* and select
     **Read and write permissions**.
2. In MyKinsta, open **Static Sites → Add site → GitHub** and choose this repository.
3. Use these settings:
   - **Branch:** `site`
   - **Automatic deployment on commit:** on. Every daily price update then redeploys the site.
   - **Build command:** leave empty
   - **Node version:** any (it isn't used)
   - **Publish directory:** leave empty (the site is at the root of the `site` branch)
4. Create the site. Kinsta gives you a `*.kinsta.page` URL, and you can add your own domain afterwards.

## Common tasks

| Task | How |
|---|---|
| Add a company or fund that search can't find | Add its Yahoo Finance ticker on a new line in `scripts/tickers.txt` (for example `ENB.TO`, `ASML.AS`, `7203.T`) and commit. The site is republished with its prices a few minutes later. *System → Data* lists the tickers you tried that are missing. |
| Refresh prices now | *Actions → Publish site → Run workflow* |
| Change experiment settings (fund list, core questions, stock-pick limits) | Edit `site/config.json`. **Don't change it during a running experiment**, because the prompts must stay the same every month. |
| Update the investor list | Replace `site/data/investors.json` (same format as the desktop app). |
| Test locally | `python scripts/build_data.py` then `cd site && python -m http.server 8000` and open http://localhost:8000 |

## Notes

- Prices come from Yahoo Finance and are for personal, non-commercial use. This is a paper-trading tool:
  no real money is moved.
- The site is public, but each visitor only sees the data in their own browser.
- `site/vendor/sql-wasm.*` is [sql.js](https://github.com/sql-js/sql.js) (MIT). It is used only to read
  `lab.db` when you import from the desktop app.
