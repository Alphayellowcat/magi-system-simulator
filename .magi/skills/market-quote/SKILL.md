---
name: market-quote
description: Use when the user asks for current or recent quote data for domestic/foreign stocks, Hong Kong stocks, US stocks, A-shares, or Bitcoin price.
---

# Market Quote

Use this skill to retrieve current or recent market quotes. It is a quote lookup skill, not a broad finance research workflow.

## Capability

- US stocks: `NVDA`, `AAPL`, `TSLA`, `MSFT`
- Hong Kong stocks: `0700.HK`, `9988.HK`
- China A-shares: Shanghai `.SS`, Shenzhen `.SZ`
- Crypto: `BTC-USD` / Bitcoin USD price
- Return price, change, percent change, market, currency, quote time, and source when available.

## Symbol Normalization

- US stock: keep the ticker, e.g. `NVDA`
- Hong Kong stock: use 4 digits plus `.HK`, e.g. Tencent `0700.HK`
- Shanghai A-share: use 6 digits plus `.SS`, e.g. Kweichow Moutai `600519.SS`
- Shenzhen A-share: use 6 digits plus `.SZ`, e.g. Ping An Bank `000001.SZ`, CATL `300750.SZ`
- Bitcoin: use `BTC-USD`

## Symbol Resolve

If the user gives a company name, product name, Chinese short name, or ST name instead of a normalized symbol, resolve the symbol first.

Use one focused search query:

```text
web.search.tavily query="小米 股票代码 港股"
web.search.tavily query="Xiaomi stock ticker Hong Kong"
web.search.tavily query="ST智知 股票代码 A股"
web.search.tavily query="贵州茅台 股票代码 A股"
web.search.tavily query="腾讯 股票代码 港股"
```

Resolution rules:

- Prefer exchange tickers from official exchange/company pages or major finance pages.
- For Chinese company names, include `股票代码` plus likely market words such as `A股`, `港股`, or `美股`.
- For ST names, preserve the ST label for display, but use the numeric exchange symbol for quote lookup.
- If one clear match appears, continue with that symbol. Example: `小米` -> `1810.HK`.
- If several plausible symbols appear, list the candidates and state which one was used for the quote.

## Implementation Route

Preferred script route when skill scripts are enabled. This no-key multi-provider script uses Coinbase/OKX/CoinGecko for BTC, Eastmoney for A/HK shares, Stooq/Yahoo for US/HK fallback, and returns one normalized JSON object with provider attempts:

```text
skill.run skill="market-quote" mode="script" script="scripts/quote_multi_provider.ps1" args=["NVDA", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_multi_provider.ps1" args=["1810.HK", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_multi_provider.ps1" args=["600519.SS", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_multi_provider.ps1" args=["000001.SZ", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_multi_provider.ps1" args=["BTC-USD", "--pretty"]
```

The multi-provider PowerShell wrapper uses only Python standard library modules and does not require a paid API key.

Legacy yfinance route when explicitly requested or when the multi-provider script fails:

```text
skill.run skill="market-quote" mode="script" script="scripts/quote_yfinance.py" args=["NVDA", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_yfinance.py" args=["1810.HK", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_yfinance.py" args=["600519.SS", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_yfinance.py" args=["000001.SZ", "--pretty"]
skill.run skill="market-quote" mode="script" script="scripts/quote_yfinance.py" args=["BTC-USD", "--pretty"]
```

The yfinance script expects a normalized Yahoo Finance symbol. Install dependency if needed:

```text
python -m pip install -r .magi/skills/market-quote/requirements.txt
```

Script output fields:

- `symbol`
- `exchange`
- `quoteType`
- `currency`
- `price`
- `previousClose`
- `change`
- `changePercent`
- `volume`
- `quoteTime`
- `freshness.status`
- `attempts`

Fallback direct fetch:

```text
web.fetch url="https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=1m"
web.fetch url="https://query1.finance.yahoo.com/v8/finance/chart/600519.SS?range=1d&interval=1m"
web.fetch url="https://query1.finance.yahoo.com/v8/finance/chart/000001.SZ?range=1d&interval=1m"
web.fetch url="https://query1.finance.yahoo.com/v8/finance/chart/0700.HK?range=1d&interval=1m"
web.fetch url="https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1d&interval=1m"
```

Use no-cache intent for quote fetches. Treat quote pages and search snippets as possibly cached until their own timestamp proves freshness.

Read these Yahoo chart fields when present:

- `chart.result[0].meta.symbol`
- `chart.result[0].meta.exchangeName`
- `chart.result[0].meta.currency`
- `chart.result[0].meta.regularMarketPrice`
- `chart.result[0].meta.previousClose`
- `chart.result[0].meta.regularMarketTime`
- latest `timestamp`
- latest `indicators.quote[0].close`
- latest `indicators.quote[0].volume`

Fallback search when direct fetch fails or the symbol is ambiguous:

```text
web.search.tavily query="NVDA NASDAQ current stock price today"
web.search.tavily query="600519 贵州茅台 今日 实时行情 股价"
web.search.tavily query="000001 平安银行 今日 实时行情 股价"
web.search.tavily query="0700.HK Tencent current stock price today"
web.search.tavily query="BTC USD current price today"
```

## Freshness Gate

Before calling a quote current, check the source timestamp.

- For US/HK/A-share stocks: accept current trading day data, or the latest completed trading session if the market is closed.
- For BTC: accept a recent timestamp because crypto trades continuously.
- If the source timestamp is missing, old, inconsistent, or only appears in a stale search snippet, write `报价新鲜度: 未确认` and do not call it real-time.
- If direct fetch fails and search fallback returns dated snippets, state the date shown by the source and keep searching once with `today/今日/实时` added.
- If every quote route fails or is rate-limited and the only remaining numbers are old search snippets, do not output those numbers as `最新价`. State that live quote retrieval failed and show the failure reason/source instead.
- If two sources disagree, prefer the source with the clearer quote timestamp and mention the discrepancy briefly.

## Workflow

1. Check whether the user input is already a normalized quote symbol.
2. If not, resolve the symbol with one focused `web.search.tavily` query.
3. If skill scripts are enabled, run `scripts/quote_multi_provider.ps1` with the resolved symbol.
4. If the multi-provider script fails, optionally try `scripts/quote_yfinance.ps1` or `web.fetch` against Yahoo chart with the resolved symbol.
5. Validate freshness from the source timestamp.
6. If script/fetch returns unusable or stale quote data, use one focused `web.search.tavily` quote query with `today/今日/实时`.
7. Report quote fields and source timestamp.
8. If several symbols match, list the likely matches and state which one was used.

## Output Shape

```text
标的:
市场:
币种:
最新价:
涨跌:
涨跌幅:
成交量:
报价时间:
报价新鲜度:
来源:
```

## Usage

Load this skill for: `股价`, `股票行情`, `实时报价`, `当前价格`, `quote`, `current price`, `A股`, `港股`, `美股`, `BTC价格`, `比特币价格`.
