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
main branch (source)                          site branch (what Kinsta deploys)
├── site/            the website              ├── index.html, engine.js, …
│   ├── index.html   dashboard                └── data/
│   ├── engine.js    the app logic                ├── index.json        list of securities
│   ├── config.json  experiment settings          └── prices/*.json     daily prices since 2016
│   └── data/investors.json
├── scripts/build_data.py       downloads prices and publishes the site
├── scripts/publish_prices.bat  Windows: double-click to publish (.sh for Linux/macOS)
├── scripts/schedule_windows.bat  Windows: publish automatically every weekday
├── scripts/tickers.txt         extra tickers to include
└── .github/workflows/publish.yml  republishes code changes (keeps the prices)
```

- **Prices are published from your computer.** Yahoo Finance refuses requests from GitHub's servers,
  so `scripts/publish_prices` runs on your PC. It downloads prices over your own connection, the same
  way the desktop app does, and writes them into the site. It then pushes the finished site to the
  **`site`** branch, and Kinsta redeploys it. Prices are final daily closes, adjusted for dividends and
  distributions, with the actual closes and currencies.
  - The first run downloads the full history for about 480 tickers, which takes 5–10 minutes.
  - After that, it fetches only the last few weeks for each ticker, in a minute or two. It downloads a
    ticker's full history again only when a new dividend or split changes it.
  - The `site` branch always holds a single commit, so the repository doesn't grow.
- **Code changes** pushed to `main` are republished by the GitHub Action. It keeps the prices that are
  already on `site` and never contacts Yahoo.
- **Your data** (portfolios, transactions, agent replies, follow dates, snapshots) is stored **in your
  browser** (localStorage). It is never sent to a server. Use *System → Data*:
  - **Download a backup** / **Restore a backup** to save your data or move it to another browser or device.
  - **Import from the desktop app** to load the `lab.db` file from Agents Lab (Windows, Linux or Android).
    This copies over your portfolios, replies, forecasts, follow dates and snapshots.

The calculations are a line-by-line port of the Python app. On the same prices they give identical
results: copy simulator, portfolio valuation and time-weighted return, forecast resolution, Brier
scores, the report, and the prompt text sent to the agents.

## Setup

### 1. On your computer (once)

You need **Python 3.11+** (already installed if you use the Agents Lab desktop app) and
**[Git](https://git-scm.com/downloads)**. On Windows: `winget install Git.Git`.

```
git clone https://github.com/Khaled-barbar/Portfolio_Simulator
```

Then publish the prices for the first time:

- **Windows:** double-click `Portfolio_Simulator\scripts\publish_prices.bat`.
- **Linux/macOS:** `Portfolio_Simulator/scripts/publish_prices.sh`

The first time you push, Git asks you to sign in to GitHub. A browser window opens; approve it.

### 2. On Kinsta (once)

1. In MyKinsta, open **Static Sites → Add site → GitHub** and choose this repository.
2. Use these settings:
   - **Branch:** `site`
   - **Automatic deployment on commit:** on. Every price publish then redeploys the site.
   - **Build command:** leave empty
   - **Node version:** any (it isn't used)
   - **Publish directory:** leave empty (the site is at the root of the `site` branch)
3. Create the site. Kinsta gives you a `*.kinsta.page` URL, and you can add your own domain afterwards.

### 3. Daily prices (optional)

- **Windows:** double-click `scripts\schedule_windows.bat` once. It creates a scheduled task that
  publishes every weekday at 18:45, after the TSX/NYSE close. If the computer is off at that time, the
  task runs when it is next on. The log is in `logs\publish.log`.
- **Linux/macOS:** add this line with `crontab -e`:
  `45 18 * * 1-5 /path/to/Portfolio_Simulator/scripts/publish_prices.sh --scheduled`

You can also just run `publish_prices` whenever you want fresh prices.

## Password

The site asks for a password on the first visit in each browser, then remembers it on that device.
*System → Data → Sign out on this device* forgets it. `site/auth.json` holds only a salted
PBKDF2-SHA256 hash, never the password itself.

- **Change the password:** `python scripts/set_password.py`, then commit and push. The site is
  republished automatically, and every browser asks for the new password once.
- **Remove the password:** `python scripts/set_password.py --remove`, then commit and push.

The site is static, so the check runs in the browser. It keeps casual visitors and bots out, and
`robots.txt` plus a `noindex` tag keep the site out of search engines. It is not bank-grade security.
Visitors can't change anything for other people: everything a visitor enters (replies, portfolios)
stays in their own browser.

## Common tasks

| Task | How |
|---|---|
| Add a company or fund that search can't find | Add its Yahoo Finance ticker on a new line in `scripts/tickers.txt` (for example `ENB.TO`, `ASML.AS`, `7203.T`), then run `publish_prices`. *System → Data* on the site lists the tickers you tried that are missing. If you edited the file on GitHub, the publish script picks it up automatically: it runs `git pull` first. |
| Refresh prices now | Run `scripts/publish_prices.bat` (or `.sh`) |
| Re-download every ticker's full history | `python scripts/build_data.py --full --publish` |
| Change experiment settings (fund list, core questions, stock-pick limits) | Edit `site/config.json`. **Don't change it during a running experiment**, because the prompts must stay the same every month. |
| Update the investor list | Replace `site/data/investors.json` (same format as the desktop app). |
| Test locally | `python scripts/build_data.py` then `cd site && python -m http.server 8000` and open http://localhost:8000 |

## Notes

- Prices come from Yahoo Finance and are for personal, non-commercial use. This is a paper-trading tool:
  no real money is moved.
- If Yahoo answers "HTTP 429" to many requests, the script stops asking, keeps the previous prices and
  still publishes. Try again an hour later.
- The site is public, but each visitor only sees the data in their own browser.
- `site/vendor/sql-wasm.*` is [sql.js](https://github.com/sql-js/sql.js) (MIT). It is used only to read
  `lab.db` when you import from the desktop app.
