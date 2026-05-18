#!/usr/bin/env python
"""Fetch a normalized market quote with yfinance.

This script intentionally does not resolve company names. Resolve names such as
"Xiaomi" or "ST Zhizhi" to a quote symbol first, then call this script.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from typing import Any


def json_default(value: Any) -> Any:
    if hasattr(value, "item"):
        return value.item()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def clean_number(value: Any) -> Any:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def fast_get(fast_info: Any, key: str) -> Any:
    try:
        if hasattr(fast_info, "get"):
            return clean_number(fast_info.get(key))
        return clean_number(fast_info[key])
    except Exception:
        return None


def normalize_symbol(symbol: str) -> str:
    normalized = symbol.strip().upper().replace(" ", "")
    if normalized == "BTC":
        return "BTC-USD"
    if normalized.endswith(".SH"):
        return f"{normalized[:-3]}.SS"
    return normalized


def freshness(symbol: str, quote_time: datetime | None) -> dict[str, Any]:
    checked_at = datetime.now(timezone.utc)
    if quote_time is None:
        return {
            "status": "unknown",
            "ageSeconds": None,
            "checkedAt": checked_at.isoformat(),
        }

    quote_time_utc = quote_time.astimezone(timezone.utc)
    age_seconds = max(0, int((checked_at - quote_time_utc).total_seconds()))
    crypto = symbol.endswith("-USD") or symbol.endswith("USD")
    if crypto:
        status = "recent" if age_seconds <= 15 * 60 else "stale_or_delayed"
    elif age_seconds <= 20 * 60:
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch quote data through yfinance.")
    parser.add_argument("symbol", help="Normalized Yahoo Finance symbol, e.g. NVDA, 1810.HK, 600519.SS, BTC-USD.")
    parser.add_argument("--period", default="1d", help="yfinance history period. Default: 1d.")
    parser.add_argument("--interval", default="1m", help="yfinance history interval. Default: 1m.")
    parser.add_argument("--prepost", action="store_true", help="Include pre/post-market data when available.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbol = normalize_symbol(args.symbol)

    try:
        import yfinance as yf
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "symbol": symbol,
            "error": f"Missing yfinance dependency: {error}",
            "install": "python -m pip install -r .magi/skills/market-quote/requirements.txt",
        }, ensure_ascii=False))
        return 2

    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(
            period=args.period,
            interval=args.interval,
            prepost=args.prepost,
            auto_adjust=False,
            actions=False,
        )
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "yfinance",
            "inputSymbol": args.symbol,
            "symbol": symbol,
            "error": str(error),
            "freshness": freshness(symbol, None),
        }, ensure_ascii=False))
        return 1

    fast_info = getattr(ticker, "fast_info", {})
    last_bar: dict[str, Any] = {}
    quote_time: datetime | None = None
    latest_close = None
    latest_volume = None

    if history is not None and not history.empty:
        clean_history = history.dropna(how="all")
        if not clean_history.empty:
            row = clean_history.iloc[-1]
            index_value = clean_history.index[-1]
            if hasattr(index_value, "to_pydatetime"):
                quote_time = index_value.to_pydatetime()
            latest_close = clean_number(row.get("Close"))
            latest_volume = clean_number(row.get("Volume"))
            last_bar = {
                "open": clean_number(row.get("Open")),
                "high": clean_number(row.get("High")),
                "low": clean_number(row.get("Low")),
                "close": latest_close,
                "volume": latest_volume,
                "time": quote_time.isoformat() if quote_time else None,
            }

    price = fast_get(fast_info, "lastPrice") or fast_get(fast_info, "regularMarketPrice") or latest_close
    previous_close = fast_get(fast_info, "previousClose")
    change = None
    change_percent = None
    if price is not None and previous_close:
        change = price - previous_close
        change_percent = (change / previous_close) * 100

    result = {
        "ok": True,
        "source": "yfinance",
        "inputSymbol": args.symbol,
        "symbol": symbol,
        "exchange": fast_get(fast_info, "exchange"),
        "quoteType": fast_get(fast_info, "quoteType"),
        "currency": fast_get(fast_info, "currency"),
        "price": clean_number(price),
        "previousClose": clean_number(previous_close),
        "change": clean_number(change),
        "changePercent": clean_number(change_percent),
        "open": fast_get(fast_info, "open"),
        "dayHigh": fast_get(fast_info, "dayHigh"),
        "dayLow": fast_get(fast_info, "dayLow"),
        "volume": fast_get(fast_info, "lastVolume") or latest_volume,
        "marketCap": fast_get(fast_info, "marketCap"),
        "quoteTime": quote_time.isoformat() if quote_time else None,
        "freshness": freshness(symbol, quote_time),
        "history": {
            "period": args.period,
            "interval": args.interval,
            "lastBar": last_bar,
        },
    }

    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None, default=json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
