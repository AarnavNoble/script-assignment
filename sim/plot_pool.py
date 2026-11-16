"""Available scripts per language over simulated time.

usage: python3 sim/plot_pool.py results/pool_over_time.csv results/runout.csv results/pool_over_time.png
Popular languages get their own color and a direct label; the 12 long-tail languages share one muted color.
"""
import csv
import sys
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

POPULAR = ["en", "es", "hi", "pt"]
COLORS = {"en": "#2a78d6", "es": "#eb6834", "hi": "#1baf7a", "pt": "#eda100"}  # categorical slots 1-4
TAIL = "#a3a29c"
INK, INK2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e6e5e0", "#fcfcfb"


def main(pool_csv: str, runout_csv: str, out_png: str) -> None:
    series = defaultdict(list)
    with open(pool_csv) as fh:
        for r in csv.DictReader(fh):
            series[r["language"]].append((float(r["sim_min"]) / 60, int(r["available"])))
    runout = {}
    with open(runout_csv) as fh:
        for r in csv.DictReader(fh):
            series[r["language"]].append((0.0, int(r["scripts"])))  # the seeded pool at t=0
            if r["first_empty_claim_sim_min"] not in ("", "n/a"):
                runout[r["language"]] = float(r["first_empty_claim_sim_min"]) / 60

    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=150)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)
    tail_labeled = False
    for lang, pts in sorted(series.items(), key=lambda kv: kv[0] in POPULAR):
        pts.sort()
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        if lang in POPULAR:
            ax.plot(xs, ys, color=COLORS[lang], lw=2, label=lang, zorder=3, solid_capstyle="round")
        else:
            ax.plot(xs, ys, color=TAIL, lw=1, alpha=0.8, zorder=2, label=None if tail_labeled else "12 long-tail languages")
            tail_labeled = True

    # direct labels at the run-out point (or the line end) for the popular languages
    ran_out = sorted((runout[l], l) for l in POPULAR if l in runout and l in series)
    for i, (x, lang) in enumerate(ran_out):
        ax.plot([x], [0], marker="o", ms=8, color=COLORS[lang], mec=SURFACE, mew=2, zorder=4)
        ax.annotate(f"{lang} out at {x:.2f} h", (x, 0), xytext=(6, 12 + 15 * i),
                    textcoords="offset points", fontsize=9, color=INK)
    for lang in POPULAR:
        if lang not in series or lang in runout:
            continue
        x, y = series[lang][-1]
        ax.annotate(lang, (x, y), xytext=(4, 0), textcoords="offset points", fontsize=9, color=INK, va="center")

    ax.set_title("Available scripts per language (each language starts with the same pool)", loc="left", fontsize=12, color=INK)
    ax.set_xlabel("simulated hours", color=INK2)
    ax.set_ylabel("available scripts", color=INK2)
    ax.set_ylim(bottom=0)
    ax.set_xlim(left=0)
    ax.grid(axis="y", color=GRID, lw=0.8)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=INK2)
    leg = ax.legend(frameon=False, loc="upper right", fontsize=9)
    for t in leg.get_texts():
        t.set_color(INK)
    fig.tight_layout()
    fig.savefig(out_png, facecolor=SURFACE)


if __name__ == "__main__":
    main(*sys.argv[1:4])
