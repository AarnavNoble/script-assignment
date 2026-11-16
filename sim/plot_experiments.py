"""Charts for results/experiments.md.

usage: python3 sim/plot_experiments.py results
Reads lease_sweep.csv, forecast_series.csv, forecast_events.csv; writes lease_tradeoff.png, forecast.png.
Single y-axis per panel (small multiples instead of a dual axis).
"""
import csv
import math
import os
import sys
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

BLUE, ORANGE, GREEN, GOLD = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
INK, INK2, GRID, SURFACE, MUTED = "#0b0b0b", "#52514e", "#e6e5e0", "#fcfcfb", "#a3a29c"
LANG_COLORS = {"en": BLUE, "es": ORANGE, "hi": GREEN, "pt": GOLD}
PAY_PER_MIN = 5 / 60


def style(ax, title, ylabel, xlabel=None):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=10.5, color=INK, pad=8)
    ax.set_ylabel(ylabel, fontsize=9, color=INK2)
    if xlabel:
        ax.set_xlabel(xlabel, fontsize=9, color=INK2)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=8.5)


def read(path):
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return list(csv.DictReader(fh))


def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def lease_chart(res):
    rows = [r for r in read(os.path.join(res, "lease_sweep.csv")) if r["primary"] == "true"]
    if not rows:
        return
    rows.sort(key=lambda r: float(r["leaseMin"]))
    L = [float(r["leaseMin"]) for r in rows]
    fig, axes = plt.subplots(1, 3, figsize=(13, 3.9), facecolor=SURFACE)

    ax = axes[0]
    style(ax, "Abandoned script idle (last heartbeat to re-claim)", "simulated minutes", "lease (sim-min)")
    ax.plot(L, [num(r["idleMean"]) for r in rows], color=BLUE, lw=2, marker="o", ms=6, label="mean")
    ax.plot(L, [num(r["idleP95"]) for r in rows], color=BLUE, lw=2, ls="--", marker="o", ms=6, mfc=SURFACE, label="p95")
    ax.legend(frameon=False, fontsize=8.5, labelcolor=INK2)

    ax = axes[1]
    style(ax, "Wasted takes (stalled, lease expired, re-claimed)", "takes per simulated hour", "lease (sim-min)")
    simh = [float(r["simHours"]) for r in rows]
    ax.plot(L, [int(r["wasted"]) / h for r, h in zip(rows, simh)], color=ORANGE, lw=2, marker="o", ms=6, label="wasted (rejected)")
    ax.plot(L, [int(r["lateTotal"]) / h for r, h in zip(rows, simh)], color=ORANGE, lw=2, ls="--", marker="o", ms=6, mfc=SURFACE, label="all false expiries")
    ax.legend(frameon=False, fontsize=8.5, labelcolor=INK2)

    ax = axes[2]
    style(ax, "Cost per simulated hour ($5/h of contributor time)", "$ per simulated hour", "lease (sim-min)")
    wasted = [float(r["dollarsLostPerH"]) for r in rows]
    idle = [float(r["starvedIdleMinPerH"]) * PAY_PER_MIN for r in rows]
    total = [a + b for a, b in zip(wasted, idle)]
    ax.plot(L, wasted, color=ORANGE, lw=2, marker="o", ms=6, label="wasted takes")
    ax.plot(L, idle, color=BLUE, lw=2, marker="o", ms=6, label="idle scripts while language was out")
    ax.plot(L, total, color=INK, lw=2, marker="o", ms=6, label="total (lowest_id)")
    best = min(range(len(L)), key=lambda i: total[i])
    ax.annotate(f"min at {L[best]:g} min", (L[best], total[best]), xytext=(0, 10), textcoords="offset points", ha="center", fontsize=8.5, color=INK)
    ff = sorted((r for r in read(os.path.join(res, "lease_sweep.csv")) if r.get("order") == "fresh_first"), key=lambda r: float(r["leaseMin"]))
    if ff:
        fl = [float(r["leaseMin"]) for r in ff]
        ft = [float(r["dollarsLostPerH"]) + float(r["starvedIdleMinPerH"]) * PAY_PER_MIN for r in ff]
        ax.plot(fl, ft, color=INK2, lw=2, ls="--", marker="o", ms=6, mfc=SURFACE, label="total (fresh_first v2, 1 seed)")
        fb = min(range(len(fl)), key=lambda i: ft[i])
        ax.annotate(f"min at {fl[fb]:g} min", (fl[fb], ft[fb]), xytext=(0, -14), textcoords="offset points", ha="center", fontsize=8.5, color=INK2)
    ax.legend(frameon=False, fontsize=8.5, labelcolor=INK2)
    for a in axes:
        a.set_xticks(L)
        a.set_ylim(bottom=0)
    fig.tight_layout()
    fig.savefig(os.path.join(res, "lease_tradeoff.png"), dpi=150, facecolor=SURFACE)


def forecast_chart(res):
    series = read(os.path.join(res, "forecast_series.csv"))
    events = read(os.path.join(res, "forecast_events.csv"))
    if not series:
        return
    by = defaultdict(list)
    for r in series:
        v = num(r["forecast_runout_h"])
        if v is not None:
            by[(r["source"], r["language"])].append((float(r["sim_min"]) / 60, v))
    ev = {(r["source"], r["language"]): r for r in events}
    langs = ["en", "es", "hi", "pt"]
    fig, axes = plt.subplots(1, 4, figsize=(14, 3.9), facecolor=SURFACE, sharey=True)
    for ax, lang in zip(axes, langs):
        style(ax, lang, "forecast run-out (sim h)" if lang == "en" else "", "snapshot time (sim h)")
        c = LANG_COLORS[lang]
        for src, color, ls, lab in (("baseline", c, "-", "forecast, QA on"), ("noqa", MUTED, "-", "forecast, QA off")):
            pts = sorted(by.get((src, lang), []))
            e = ev.get((src, lang))
            out = num(e["ran_out_h"]) if e else None
            pts = [p for p in pts if out is None or p[0] <= out]  # forecasts made before the run-out
            if not pts:
                continue
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, lw=2, ls=ls, label=lab)
            low = num(e["first_low_pool_h"]) if e else None
            if out is not None:
                ax.axhline(out, color=color, lw=1.2, ls=":")
                ax.annotate(f"ran out {out:.2f} h", (0.02, out), xycoords=("axes fraction", "data"), xytext=(0, 3 if src == "baseline" else -11),
                            textcoords="offset points", fontsize=8, color=INK2)
            if low is not None:
                ax.axvline(low, color=color, lw=1.2, ls="--")
        ax.set_ylim(0, 8)
    axes[0].legend(frameon=False, fontsize=8, labelcolor=INK2, loc="upper right")
    fig.text(0.01, 0.005, "solid: snapshot time + hours_left; dotted: actual run-out; dashed vertical: first low_pool alert", fontsize=8, color=INK2)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(os.path.join(res, "forecast.png"), dpi=150, facecolor=SURFACE)


if __name__ == "__main__":
    res = sys.argv[1] if len(sys.argv) > 1 else "results"
    lease_chart(res)
    forecast_chart(res)
