"""Strip plot of script-check error rates per language: correct readings vs wrong ones, with thresholds.

python3 sim/plot_script_check.py results/script-check.csv results/script-check.json results/script-check.png
(called by sim/script-eval.ts)
"""
import csv
import json
import random
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

csv_path, json_path, out_path = sys.argv[1:4]
rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
chosen = json.load(open(json_path, encoding="utf-8"))["chosen"]
meta = json.load(open(json_path, encoding="utf-8"))
langs = meta["langs"]
skip = set(meta.get("skip", []))

CORRECT = {"correct", "correct_slow", "noisy_fast"}
# reference categorical palette, slots 1-4 (blue = correct; wrong kinds orange / aqua / yellow), plus marker shape
STYLE = {
    "correct": ("#2a78d6", "o", "correct (3 voices/rates, incl. noisy)"),
    "wrong_script": ("#eb6834", "^", "wrong sentence"),
    "partial": ("#1baf7a", "s", "first half only"),
    "wrong_language": ("#eda100", "D", "wrong language"),
}
CAP = 1.5

fig, ax = plt.subplots(figsize=(13, 5.5), dpi=150)
fig.patch.set_facecolor("#fcfcfb")
ax.set_facecolor("#fcfcfb")
rnd = random.Random(7)
for xi, lang in enumerate(langs):
    th = chosen[lang]
    m = "cer"
    for r in rows:
        if r["lang"] != lang:
            continue
        kind = "correct" if r["kind"] in CORRECT else r["kind"]
        color, marker, _ = STYLE[kind]
        off = {"correct": -0.27, "wrong_script": -0.03, "partial": 0.12, "wrong_language": 0.27}[kind]
        y = min(CAP, float(r[m]))
        ax.scatter(xi + off + rnd.uniform(-0.06, 0.06), y, s=9, c=color, marker=marker, alpha=0.55, linewidths=0)
    if lang in skip:
        continue
    ax.hlines(th["pass"], xi - 0.42, xi + 0.42, colors="#0b0b0b", linewidth=1.6)
    if th["fail"] is not None:
        ax.hlines(th["fail"], xi - 0.42, xi + 0.42, colors="#0b0b0b", linewidth=1.6, linestyles=(0, (3, 2)))

ax.set_xticks(range(len(langs)))
ax.set_xticklabels([l + ("\n(check off)" if l in skip else "") for l in langs], color="#52514e", fontsize=9)
ax.set_ylim(-0.03, CAP + 0.05)
ax.set_ylabel("character error rate vs script (capped at 1.5)", color="#52514e")
ax.set_title("Script check: error rate per take, correct vs wrong readings (Whisper small)", loc="left", fontsize=12, color="#0b0b0b")
ax.grid(axis="y", color="#e4e3df", linewidth=0.6)
ax.set_axisbelow(True)
for s in ("top", "right"):
    ax.spines[s].set_visible(False)
for s in ("left", "bottom"):
    ax.spines[s].set_color("#b5b4ae")
handles = [plt.Line2D([], [], marker=mk, color=c, linestyle="", markersize=6, label=lab) for c, mk, lab in STYLE.values()]
handles += [plt.Line2D([], [], color="#0b0b0b", linewidth=1.6, label="approve if <="),
            plt.Line2D([], [], color="#0b0b0b", linewidth=1.6, linestyle=(0, (3, 2)), label="reject if >")]
ax.legend(handles=handles, loc="upper left", bbox_to_anchor=(1.0, 1.0), frameon=False, fontsize=8.5)
fig.tight_layout()
fig.savefig(out_path, facecolor=fig.get_facecolor())
print(f"[eval] chart -> {out_path}")
