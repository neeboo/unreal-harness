#!/usr/bin/env python3
"""DeepSeek token pricing, including peak and off-peak rates.

Kept as its own module because the peak/off-peak distinction is not a detail:
off-peak rates are exactly half of peak rates, so a matrix that straddles the
boundary produces costs that differ by 2x for reasons that have nothing to do
with the agent under test. A cost comparison has to say which window it ran in.

Source: <https://api-docs.deepseek.com/quick_start/pricing/> (retrieved
2026-09-22). Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through
Friday, excluding Chinese public holidays; everything else is off-peak. The
public-holiday exclusion is deliberately not modelled — it would require a
maintained calendar, and ignoring it can only make this module over-estimate a
peak window, never under-estimate a bill.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

#: USD per 1M tokens, as (off_peak, peak).
RATES: dict[str, dict[str, tuple[float, float]]] = {
    "deepseek-flash": {
        "cache_miss": (0.15, 0.30),
        "cache_hit": (0.003, 0.006),
        "output": (0.60, 1.20),
    },
    "deepseek-v4-pro": {
        "cache_miss": (0.66, 1.32),
        "cache_hit": (0.022, 0.044),
        "output": (1.98, 3.96),
    },
}

#: Peak windows in UTC, as half-open [start, end) hours.
PEAK_WINDOWS: tuple[tuple[int, int], ...] = ((1, 4), (6, 10))


def is_peak(moment: datetime) -> bool:
    """Whether ``moment`` falls in a DeepSeek peak-pricing window."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    local = moment.astimezone(timezone.utc)
    if local.weekday() >= 5:  # Saturday and Sunday are entirely off-peak.
        return False
    return any(start <= local.hour < end for start, end in PEAK_WINDOWS)


@dataclass(frozen=True)
class TokenUsage:
    """One trial's token counts, in the disjoint buckets the API reports."""

    uncached_input: int
    cache_read: int
    cache_write: int
    output: int

    @property
    def total_input(self) -> int:
        return self.uncached_input + self.cache_read + self.cache_write


@dataclass(frozen=True)
class PricedUsage:
    usage: TokenUsage
    model: str
    peak: bool
    usd: float
    rates_used: dict[str, float]

    @property
    def window(self) -> str:
        return "peak" if self.peak else "off-peak"


def price_usage(
    usage: TokenUsage,
    model: str = "deepseek-flash",
    moment: datetime | None = None,
) -> PricedUsage:
    """Price one trial's usage.

    Uses the *cache-hit* rate for tokens the API served from cache and the
    *cache-miss* rate for the rest. Collapsing them would overstate a
    cache-heavy run by up to 50x on the input side, because that is the whole
    point of the cached/miss split.
    """
    table = RATES.get(model)
    if table is None:
        raise KeyError(
            f"no pricing table for {model!r}; known models: {sorted(RATES)}. "
            "Add rates from https://api-docs.deepseek.com/quick_start/pricing/ "
            "rather than assuming one."
        )

    when = moment or datetime.now(timezone.utc)
    peak = is_peak(when)
    index = 1 if peak else 0

    miss_rate = table["cache_miss"][index]
    hit_rate = table["cache_hit"][index]
    out_rate = table["output"][index]

    usd = (
        usage.uncached_input * miss_rate
        + usage.cache_read * hit_rate
        + usage.cache_write * miss_rate
        + usage.output * out_rate
    ) / 1_000_000

    return PricedUsage(
        usage=usage,
        model=model,
        peak=peak,
        usd=usd,
        rates_used={
            "cache_miss_per_mtok": miss_rate,
            "cache_hit_per_mtok": hit_rate,
            "output_per_mtok": out_rate,
        },
    )


def next_off_peak_start(moment: datetime) -> datetime | None:
    """The next instant at or after ``moment`` that is off-peak.

    Returns ``None`` when ``moment`` is already off-peak, so a caller can decide
    whether to wait. Used to keep a benchmark matrix inside one pricing window.
    """
    if not is_peak(moment):
        return None
    local = moment.astimezone(timezone.utc)
    for start, end in PEAK_WINDOWS:
        if start <= local.hour < end:
            return local.replace(hour=end, minute=0, second=0, microsecond=0)
    return None


if __name__ == "__main__":
    import sys

    now = datetime.now(timezone.utc)
    print(f"now (UTC): {now.isoformat()}  {'PEAK' if is_peak(now) else 'off-peak'}")
    for model in sorted(RATES):
        sample = TokenUsage(uncached_input=10_000, cache_read=200_000, cache_write=0, output=3_000)
        priced = price_usage(sample, model, now)
        print(
            f"  {model}: ${priced.usd:.6f} for 10k miss + 200k hit + 3k out "
            f"({priced.window})"
        )
    resume = next_off_peak_start(now)
    if resume is not None:
        print(f"  peak: off-peak resumes at {resume.isoformat()}")
    sys.exit(0)
