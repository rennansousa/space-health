"""Loader for the NASA OSDR OSD-575 comprehensive metabolic panel (Inspiration4).

The CSV has one row per (crew member, draw, analyte). This module maps the CSV
analyte names to the canonical keys in switch_config.json and converts draw
labels to a mission day:

    L-n  -> -n          (n days before launch)
    R+n  -> 3 + n       (n days after return; Inspiration4 flew for 3 days)

eGFR rows are skipped: they are derived values with no upper limit.
"""

from __future__ import annotations

import csv
import os
import re
from typing import Any, Dict, List

from exam_parser import load_switch_config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OSD_575_CSV_PATH = os.path.join(BASE_DIR, "data", "osd_575_real_astronaut_blood.csv")
DRAW_ORDER = ["L-92", "L-44", "L-3", "R+1", "R+45", "R+82", "R+194"]


def mission_day(label: str, offset_after_return: int = 3) -> int:
    m = re.fullmatch(r"\s*([LR])\s*([+-])\s*(\d+)\s*", label or "")
    if not m:
        raise ValueError(f"Unknown draw label: {label!r}")
    side, _, n = m.groups()
    return -int(n) if side == "L" else offset_after_return + int(n)


def _num(text: str):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def _csv_name_map() -> Dict[str, str]:
    catalog = load_switch_config()["analyteCatalog"]
    out: Dict[str, str] = {}
    for key, meta in catalog.items():
        for name in meta.get("csvNames", []):
            out[name.upper()] = key
    return out


def load_rows() -> List[Dict[str, Any]]:
    """All usable rows as dicts: subject, draw, missionDay, analyte, value, unit, labMin, labMax."""
    if not os.path.exists(OSD_575_CSV_PATH):
        return []
    offset = load_switch_config()["rules"].get("missionDayOffsetAfterReturn", 3)
    names = _csv_name_map()
    rows: List[Dict[str, Any]] = []
    with open(OSD_575_CSV_PATH, "r", encoding="utf-8-sig", errors="ignore") as fp:
        for r in csv.DictReader(fp):
            raw_name = (r.get("ANALYTE") or "").strip().upper()
            if raw_name.startswith("EGFR"):
                continue
            key = names.get(raw_name)
            value = _num((r.get("VALUE") or "").strip())
            if key is None or value is None:
                continue
            draw = (r.get("timepoint") or "").strip()
            rows.append(
                {
                    "subject": (r.get("SUBJECT_ID") or "").strip(),
                    "draw": draw,
                    "missionDay": mission_day(draw, offset),
                    "analyte": key,
                    "value": value,
                    "unit": (r.get("UNITS") or "").strip(),
                    "labMin": _num(r.get("RANGE_MIN")),
                    "labMax": _num(r.get("RANGE_MAX")),
                }
            )
    return rows


def rows_for_draw(draw: str) -> Dict[str, List[Dict[str, Any]]]:
    """Measurements of one draw, grouped by crew member."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for r in load_rows():
        if r["draw"] == draw:
            out.setdefault(r["subject"], []).append(r)
    return out


def summary() -> Dict[str, Any]:
    rows = load_rows()
    return {
        "dataset": "NASA OSDR OSD-575 (SpaceX Inspiration4 comprehensive metabolic panel)",
        "rows": len(rows),
        "crew": sorted({r["subject"] for r in rows}),
        "draws": [d for d in DRAW_ORDER if any(r["draw"] == d for r in rows)],
        "analytes": sorted({r["analyte"] for r in rows}),
    }
