#!/usr/bin/env python
"""Fetch market quotes through free/no-key providers.

The script expects a normalized symbol, such as NVDA, 1810.HK, 600519.SS,
000001.SZ, or BTC-USD. It returns one normalized JSON object and includes
provider attempts so the harness can explain failures without inventing prices.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


def clean_number(value: Any) -> float | None:
    if value is None or value == "" or value == "N/D" or value == "-":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def normalize_symbol(symbol: str) -> str:
    normalized = symbol.strip().upper().replace(" ", "")
    if normalized == "BTC":
        return "BTC-USD"
    if normalized.endswith(".SH"):
        return f"{normalized[:-3]}.SS"
    return normalized


def detect_market(symbol: str) -> str:
    if symbol in {"BTC-USD", "BTC-USDT"} or symbol.startswith("BTC"):
        return "crypto"
    if symbol.endswith(".HK"):
        return "hk"
    if symbol.endswith(".SS") or symbol.endswith(".SZ"):
        return "cn"
    if symbol.isalpha():
        return "us"
    return "unknown"


def http_text(url: str, timeout: int) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "MAGI-market-quote/0.1",
            "Accept": "application/json,text/csv,text/plain,*/*",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def http_json(url: str, timeout: int) -> Any:
    return json.loads(http_text(url, timeout))


def parse_time(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp, timezone.utc)
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None
        if candidate.isdigit():
            return parse_time(int(candidate))
        try:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def freshness(market: str, quote_time: datetime | None) -> dict[str, Any]:
    checked_at = datetime.now(timezone.utc)
    if quote_time is None:
        return {
            "status": "unknown",
            "ageSeconds": None,
            "checkedAt": checked_at.isoformat(),
        }

    quote_time_utc = quote_time.astimezone(timezone.utc)
    age_seconds = max(0, int((checked_at - quote_time_utc).total_seconds()))
    if market == "crypto":
        status = "recent" if age_seconds <= 15 * 60 else "stale_or_delayed"
    elif age_seconds <= 30 * 60:
        status = "recent"
    elif age_seconds <= 4 * 24 * 60 * 60:
        status = "latest_session_or_delayed"
    else:
        status = "stale"

    return {
        "status": status,
        "ageSeconds": age_seconds,
        "checkedAt": checked_at.isoformat(),
    }


def quote_result(
    *,
    source: str,
    symbol: str,
    market: str,
    price: Any,
    quote_time: datetime | None,
    currency: str,
    previous_close: Any = None,
    change: Any = None,
    change_percent: Any = None,
    volume: Any = None,
    open_price: Any = None,
    day_high: Any = None,
    day_low: Any = None,
    delay: str | None = None,
    raw: dict[str, Any] | None = None,
) -> dict[str, Any]:
    price_number = clean_number(price)
    previous_close_number = clean_number(previous_close)
    change_number = clean_number(change)
    change_percent_number = clean_number(change_percent)
    if change_number is None and price_number is not None and previous_close_number:
        change_number = price_number - previous_close_number
    if change_percent_number is None and change_number is not None and previous_close_number:
        change_percent_number = change_number / previous_close_number * 100

    return {
        "ok": price_number is not None,
        "source": source,
        "symbol": symbol,
        "market": market,
        "currency": currency,
        "price": price_number,
        "previousClose": previous_close_number,
        "change": clean_number(change_number),
        "changePercent": clean_number(change_percent_number),
        "open": clean_number(open_price),
        "dayHigh": clean_number(day_high),
        "dayLow": clean_number(day_low),
        "volume": clean_number(volume),
        "quoteTime": quote_time.isoformat() if quote_time else None,
        "freshness": freshness(market, quote_time),
        "delay": delay,
        "raw": raw or {},
    }


def quote_crypto_coinbase(symbol: str, timeout: int) -> dict[str, Any]:
    product = "BTC-USD" if symbol in {"BTC", "BTC-USD", "BTC-USDT"} else symbol.replace("-", "-")
    data = http_json(f"https://api.exchange.coinbase.com/products/{urllib.parse.quote(product)}/ticker", timeout)
    return quote_result(
        source="coinbase.exchange",
        symbol=product,
        market="crypto",
        price=data.get("price"),
        quote_time=parse_time(data.get("time")),
        currency="USD" if product.endswith("-USD") else "USDT",
        volume=data.get("volume"),
        raw={"trade_id": data.get("trade_id"), "bid": data.get("bid"), "ask": data.get("ask")},
    )


def quote_crypto_okx(symbol: str, timeout: int) -> dict[str, Any]:
    inst_id = "BTC-USDT" if symbol in {"BTC", "BTC-USD", "BTC-USDT"} else symbol.replace("-USD", "-USDT")
    data = http_json(f"https://www.okx.com/api/v5/market/ticker?instId={urllib.parse.quote(inst_id)}", timeout)
    row = (data.get("data") or [{}])[0]
    return quote_result(
        source="okx.public",
        symbol=inst_id,
        market="crypto",
        price=row.get("last"),
        quote_time=parse_time(row.get("ts")),
        currency="USDT",
        previous_close=row.get("sodUtc0"),
        volume=row.get("vol24h"),
        day_high=row.get("high24h"),
        day_low=row.get("low24h"),
        raw={"bid": row.get("bidPx"), "ask": row.get("askPx")},
    )


def quote_crypto_coingecko(symbol: str, timeout: int) -> dict[str, Any]:
    coin_id = "bitcoin" if symbol in {"BTC", "BTC-USD", "BTC-USDT"} else symbol.lower()
    data = http_json(
        "https://api.coingecko.com/api/v3/simple/price?"
        f"ids={urllib.parse.quote(coin_id)}&vs_currencies=usd&include_last_updated_at=true&include_24hr_change=true",
        timeout,
    )
    row = data.get(coin_id) or {}
    return quote_result(
        source="coingecko.simple",
        symbol=symbol,
        market="crypto",
        price=row.get("usd"),
        quote_time=parse_time(row.get("last_updated_at")),
        currency="USD",
        change_percent=row.get("usd_24h_change"),
        raw={},
    )


def eastmoney_secid(symbol: str) -> str:
    code = symbol.split(".")[0]
    if symbol.endswith(".SS"):
        return f"1.{code}"
    if symbol.endswith(".SZ"):
        return f"0.{code}"
    if symbol.endswith(".HK"):
        return f"116.{code.zfill(5)}"
    raise ValueError(f"Eastmoney does not support symbol: {symbol}")


def eastmoney_scale(symbol: str) -> int:
    return 1000 if symbol.endswith(".HK") else 100


def scale_eastmoney(value: Any, scale: int) -> float | None:
    number = clean_number(value)
    return None if number is None else number / scale


def quote_eastmoney(symbol: str, timeout: int) -> dict[str, Any]:
    secid = eastmoney_secid(symbol)
    fields = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f107,f116,f169,f170"
    data = http_json(f"https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields={fields}", timeout)
    row = data.get("data") or {}
    if not row:
        raise ValueError(f"Eastmoney returned no data for {symbol}")
    scale = eastmoney_scale(symbol)
    market = "hk" if symbol.endswith(".HK") else "cn"
    currency = "HKD" if symbol.endswith(".HK") else "CNY"
    return quote_result(
        source="eastmoney.push2",
        symbol=symbol,
        market=market,
        price=scale_eastmoney(row.get("f43"), scale),
        quote_time=parse_time(row.get("f86")),
        currency=currency,
        previous_close=scale_eastmoney(row.get("f60"), scale),
        change=scale_eastmoney(row.get("f169"), scale),
        change_percent=scale_eastmoney(row.get("f170"), 100),
        volume=row.get("f47"),
        open_price=scale_eastmoney(row.get("f46"), scale),
        day_high=scale_eastmoney(row.get("f44"), scale),
        day_low=scale_eastmoney(row.get("f45"), scale),
        delay="HK quotes may be delayed depending on upstream source." if market == "hk" else None,
        raw={"name": row.get("f58"), "code": row.get("f57"), "secid": secid},
    )


def quote_stooq(symbol: str, timeout: int) -> dict[str, Any]:
    if symbol.endswith(".HK"):
        stooq_symbol = symbol.lower()
        market = "hk"
        currency = "HKD"
    else:
        stooq_symbol = f"{symbol.lower()}.us"
        market = "us"
        currency = "USD"
    url = f"https://stooq.com/q/l/?s={urllib.parse.quote(stooq_symbol)}&f=sd2t2ohlcv&h&e=csv"
    text = http_text(url, timeout)
    rows = list(csv.DictReader(text.splitlines()))
    if not rows:
        raise ValueError(f"Stooq returned no rows for {symbol}")
    row = rows[0]
    close = clean_number(row.get("Close"))
    if close is None:
        raise ValueError(f"Stooq returned no quote for {symbol}")
    quote_time = parse_time(f"{row.get('Date')}T{row.get('Time')}+00:00")
    return quote_result(
        source="stooq.csv",
        symbol=row.get("Symbol") or symbol,
        market=market,
        price=close,
        quote_time=quote_time,
        currency=currency,
        volume=row.get("Volume"),
        open_price=row.get("Open"),
        day_high=row.get("High"),
        day_low=row.get("Low"),
        delay="Stooq can be delayed; use quoteTime/freshness.",
        raw={"date": row.get("Date"), "time": row.get("Time")},
    )


def quote_yahoo_chart(symbol: str, timeout: int) -> dict[str, Any]:
    data = http_json(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?range=1d&interval=1m",
        timeout,
    )
    result = (data.get("chart", {}).get("result") or [{}])[0]
    meta = result.get("meta") or {}
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    latest_time = parse_time(timestamps[-1]) if timestamps else parse_time(meta.get("regularMarketTime"))
    latest_close = next((item for item in reversed(closes) if item is not None), None)
    latest_volume = next((item for item in reversed(volumes) if item is not None), None)
    return quote_result(
        source="yahoo.chart",
        symbol=symbol,
        market=detect_market(symbol),
        price=meta.get("regularMarketPrice") or latest_close,
        quote_time=latest_time,
        currency=meta.get("currency") or ("USD" if detect_market(symbol) == "us" else ""),
        previous_close=meta.get("previousClose"),
        volume=latest_volume,
        raw={"exchangeName": meta.get("exchangeName")},
    )


PROVIDERS = {
    "crypto": [quote_crypto_coinbase, quote_crypto_okx, quote_crypto_coingecko, quote_yahoo_chart],
    "cn": [quote_eastmoney, quote_yahoo_chart],
    "hk": [quote_eastmoney, quote_stooq, quote_yahoo_chart],
    "us": [quote_stooq, quote_yahoo_chart],
    "unknown": [quote_yahoo_chart],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch quote data through free/no-key providers.")
    parser.add_argument("symbol", help="Normalized symbol, e.g. NVDA, 1810.HK, 600519.SS, BTC-USD.")
    parser.add_argument("--provider", default="auto", help="auto, coinbase, okx, coingecko, eastmoney, stooq, yahoo.")
    parser.add_argument("--timeout", type=int, default=12, help="HTTP timeout seconds per provider.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbol = normalize_symbol(args.symbol)
    market = detect_market(symbol)
    attempts: list[dict[str, Any]] = []
    provider_map = {
        "coinbase": quote_crypto_coinbase,
        "okx": quote_crypto_okx,
        "coingecko": quote_crypto_coingecko,
        "eastmoney": quote_eastmoney,
        "stooq": quote_stooq,
        "yahoo": quote_yahoo_chart,
    }
    providers = [provider_map[args.provider]] if args.provider in provider_map else PROVIDERS.get(market, PROVIDERS["unknown"])

    for provider in providers:
        name = provider.__name__.replace("quote_", "")
        try:
            result = provider(symbol, args.timeout)
            attempts.append({
                "provider": result.get("source") or name,
                "ok": bool(result.get("ok")),
                "freshness": result.get("freshness"),
                "price": result.get("price"),
            })
            if result.get("ok"):
                result["inputSymbol"] = args.symbol
                result["normalizedSymbol"] = symbol
                result["attempts"] = attempts
                print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
                return 0
        except Exception as error:
            attempts.append({
                "provider": name,
                "ok": False,
                "error": str(error),
            })

    print(json.dumps({
        "ok": False,
        "source": "multi-provider",
        "inputSymbol": args.symbol,
        "normalizedSymbol": symbol,
        "market": market,
        "error": "All quote providers failed.",
        "attempts": attempts,
        "freshness": freshness(market, None),
    }, ensure_ascii=False, indent=2 if args.pretty else None))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
