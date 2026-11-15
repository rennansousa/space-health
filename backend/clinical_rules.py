"""Space Health rules engine.

Deterministic and auditable: the same input always gives the same output, and
every parameter comes from switch_config.json (rules, analyteCatalog) or
knowledge_base.json (guidance text and sources). No generative model is used.

Pipeline for one blood draw:
    measurements -> classify (lab range + personal baseline + red flag)
                 -> detect_draw_artifacts (whole crew, same draw)
                 -> assign_risk_tiers
                 -> build_cards (what the astronaut sees)
                 -> score_findings (used by the ground triage queue)
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, Iterable, List, Optional, Tuple

from exam_parser import load_switch_config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KB_PATH = os.path.join(BASE_DIR, "knowledge_base.json")

TIER_ORDER = {"CRITICAL": 0, "ATTENTION": 1, "ROUTINE": 2}
TRIAGE_ORDER = {"RED": 0, "AMBER": 1, "GREEN": 2}


# ---------------------------------------------------------------- helpers

def fmt(value: Optional[float]) -> str:
    if value is None:
        return "n/a"
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.2f}".rstrip("0").rstrip(".")


def lower_first(label: str) -> str:
    """'Glucose' -> 'glucose', 'AST' stays 'AST', 'Urea nitrogen (BUN)' -> 'urea nitrogen (BUN)'."""
    if len(label) > 1 and label[:2].isupper():
        return label
    return label[:1].lower() + label[1:]


def rules_config() -> Dict[str, Any]:
    return load_switch_config()["rules"]


def analyte_meta(analyte: str) -> Dict[str, Any]:
    catalog = load_switch_config()["analyteCatalog"]
    meta = catalog.get(analyte, {})
    return {
        "label": meta.get("label", analyte.replace("_", " ").title()),
        "system": meta.get("system", "other"),
        "scoreWeight": float(meta.get("scoreWeight", 5)),
        "personalTolerancePct": meta.get("personalTolerancePct"),
    }


def load_knowledge_base() -> Dict[str, Any]:
    """Loads guidance. Entries without at least one source URL are dropped."""
    with open(KB_PATH, "r", encoding="utf-8") as fp:
        kb = json.load(fp)
    kept = []
    for entry in kb.get("entries", []):
        sources = [s for s in entry.get("sources", []) if str(s.get("url", "")).startswith("http")]
        if not sources:
            print(f"[knowledge_base] ignored entry without source: {entry.get('id')}")
            continue
        entry["sources"] = sources
        kept.append(entry)
    kb["entries"] = kept
    return kb


def _kb_entry(kb: Dict[str, Any], analyte: str, direction: str) -> Optional[Dict[str, Any]]:
    for e in kb["entries"]:
        if e["analyte"] == analyte and e["direction"] == direction:
            return e
    return None


# ---------------------------------------------------------------- baseline

def build_baselines(points: Iterable[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, float]]:
    """Mean of pre-flight values (missionDay < 0) per (subject, analyte)."""
    acc: Dict[Tuple[str, str], List[float]] = {}
    for p in points:
        if p.get("missionDay") is not None and p["missionDay"] < 0:
            acc.setdefault((p["subject"], p["analyte"]), []).append(float(p["value"]))
    return {k: {"mean": round(sum(v) / len(v), 3), "n": len(v)} for k, v in acc.items()}


def classify(
    measurement: Dict[str, Any],
    baseline: Optional[Dict[str, float]],
    cfg: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Classifies one measurement against the lab range and the personal baseline."""
    cfg = cfg or rules_config()
    bcfg = cfg["baseline"]
    value = float(measurement["value"])
    lab_min, lab_max = measurement.get("labMin"), measurement.get("labMax")

    if lab_min is not None and value < lab_min:
        status = "LOW"
    elif lab_max is not None and value > lab_max:
        status = "HIGH"
    else:
        status = "IN_RANGE"

    delta_pct: Optional[float] = None
    meta = analyte_meta(measurement["analyte"])
    tolerance = meta["personalTolerancePct"] if meta["personalTolerancePct"] is not None else bcfg["outOfRangeTolerancePct"]
    if not baseline or baseline.get("n", 0) < bcfg["minPoints"] or not baseline.get("mean"):
        baseline_flag = "NO_BASELINE"
    else:
        delta_pct = round((value - baseline["mean"]) / baseline["mean"] * 100.0, 1)
        if status != "IN_RANGE":
            baseline_flag = "PERSONAL_NORMAL" if abs(delta_pct) <= tolerance else "SHIFTED"
        else:
            baseline_flag = "SHIFTED" if abs(delta_pct) > bcfg["inRangeShiftPct"] else "STABLE"

    red = cfg.get("redFlags", {}).get(measurement["analyte"])
    red_flag = bool(
        red
        and ((red.get("below") is not None and value < red["below"]) or (red.get("above") is not None and value > red["above"]))
    )

    return {
        "analyte": measurement["analyte"],
        "label": meta["label"],
        "system": meta["system"],
        "value": value,
        "unit": measurement.get("unit", ""),
        "labRange": [lab_min, lab_max],
        "baseline": baseline if baseline_flag != "NO_BASELINE" else None,
        "deltaVsBaselinePct": delta_pct,
        "status": status,
        "baselineFlag": baseline_flag,
        "redFlag": red_flag,
        "artifactSuspected": False,
        "riskTier": None,
    }


# ---------------------------------------------------------------- crew-wide check

def detect_draw_artifacts(
    findings_by_subject: Dict[str, List[Dict[str, Any]]],
    draw_label: str,
    cfg: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Flags analytes where enough of the crew deviate the same way in the same draw.

    Mutates the matching findings (artifactSuspected = True) and returns one
    crew notice per (analyte, direction).
    """
    cfg = cfg or rules_config()
    acfg = cfg["artifact"]
    crew = sorted(findings_by_subject.keys())
    if len(crew) < acfg["minCrew"]:
        return []

    notices: List[Dict[str, Any]] = []
    analytes = sorted({f["analyte"] for fs in findings_by_subject.values() for f in fs})
    for analyte in analytes:
        for direction in ("LOW", "HIGH"):
            hits = [
                (subject, f)
                for subject, fs in findings_by_subject.items()
                for f in fs
                if f["analyte"] == analyte and f["status"] == direction
            ]
            measured = sum(1 for fs in findings_by_subject.values() if any(f["analyte"] == analyte for f in fs))
            if measured < acfg["minCrew"] or len(hits) < max(2, math.ceil(measured * acfg["minFraction"])):
                continue
            for _, f in hits:
                f["artifactSuspected"] = True
                f["artifactCount"] = [len(hits), measured]
            label = analyte_meta(analyte)["label"]
            notices.append(
                {
                    "drawLabel": draw_label,
                    "analyte": analyte,
                    "label": label,
                    "direction": direction,
                    "affected": sorted(s for s, _ in hits),
                    "affectedValues": {s: f["value"] for s, f in hits},
                    "crewMeasured": measured,
                    "text": (
                        f"{len(hits)} of {measured} crew show {direction.lower()} {lower_first(label)} in draw {draw_label}. "
                        "Possible sample-handling problem or shared cause. Repeat before acting."
                    ),
                }
            )
    return notices


# ---------------------------------------------------------------- risk tier and cards

def assign_risk_tier(f: Dict[str, Any]) -> Optional[str]:
    out_of_range = f["status"] != "IN_RANGE"
    if f["redFlag"] and not f["artifactSuspected"]:
        tier = "CRITICAL"
    elif f["artifactSuspected"]:
        tier = "ATTENTION"
    elif out_of_range and f["baselineFlag"] in ("SHIFTED", "NO_BASELINE"):
        tier = "ATTENTION"
    elif (not out_of_range and f["baselineFlag"] == "SHIFTED") or (out_of_range and f["baselineFlag"] == "PERSONAL_NORMAL"):
        tier = "ROUTINE"
    else:
        tier = None
    f["riskTier"] = tier
    return tier


def assign_risk_tiers(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for f in findings:
        assign_risk_tier(f)
    return findings


def _headline(f: Dict[str, Any]) -> str:
    label = f["label"]
    word = "below" if f["status"] == "LOW" or (f["deltaVsBaselinePct"] or 0) < 0 else "above"
    if f["artifactSuspected"]:
        n, of = f.get("artifactCount", ["several", "the"])
        return f"Possible sample problem: {n} of {of} crew show {f['status'].lower()} {lower_first(label)} in the same draw. Repeat before acting."
    if f["riskTier"] == "CRITICAL":
        return f"Act now: {label} {fmt(f['value'])} {f['unit']}".strip()
    if f["riskTier"] == "ATTENTION":
        if f["baselineFlag"] == "NO_BASELINE":
            return f"{label} is {word} the lab range"
        return f"{label} is {word} your normal"
    if f["status"] != "IN_RANGE":
        return f"{label} is outside the lab range but normal for you"
    return f"{label} has moved {word} your normal"


def _what_we_saw(f: Dict[str, Any]) -> str:
    parts = [f"{fmt(f['value'])} {f['unit']}.".replace(" .", ".")]
    if f["baseline"]:
        mean = f["baseline"]["mean"]
        parts.append(f"Your pre-flight average was {fmt(round(mean, 1) if abs(mean) >= 10 else round(mean, 2))} ({f['deltaVsBaselinePct']:+.0f}%).")
    else:
        parts.append("No pre-flight baseline on file.")
    lo, hi = f["labRange"]
    if lo is not None and hi is not None:
        parts.append(f"Lab range {fmt(lo)} to {fmt(hi)}.")
    elif lo is not None:
        parts.append(f"Lab minimum {fmt(lo)}.")
    return " ".join(parts)


def build_card(
    f: Dict[str, Any],
    kb: Dict[str, Any],
    astronaut_id: str,
    draw_id: str,
    draw_label: str,
) -> Optional[Dict[str, Any]]:
    tier = f["riskTier"]
    if tier is None:
        return None

    sources: List[Dict[str, str]] = []
    why = ""
    if f["artifactSuspected"]:
        entry = _kb_entry(kb, "*", "*")
        steps = list(entry["steps"]) if entry else [kb["defaultFirstStep"]]
        sources = entry["sources"] if entry else []
        why = entry.get("why", "") if entry else ""
    elif tier == "ROUTINE":
        steps = ["Keep your normal routine.", "It will be checked again at the next scheduled draw."]
    else:
        entry = _kb_entry(kb, f["analyte"], f["status"]) if f["status"] != "IN_RANGE" else None
        steps = [kb["defaultFirstStep"]]
        extra = list(entry["steps"]) if entry else list(kb["genericSteps"])
        if tier == "CRITICAL":
            steps.append(kb["criticalStep"])
            extra = [x for x in extra if "Crew Medical Officer" not in x]
        steps += extra
        if entry:
            sources = entry["sources"]
            why = entry.get("why", "")

    who = {
        "CRITICAL": "Act now with your Crew Medical Officer. Ground will review at the next link.",
        "ATTENTION": "You can act now. Ground will review at the next link.",
        "ROUTINE": "No action needed. Ground will see this at the next sync.",
    }[tier]

    return {
        "cardId": f"CARD-{draw_id}-{f['analyte']}",
        "astronautId": astronaut_id,
        "drawId": draw_id,
        "drawLabel": draw_label,
        "analyte": f["analyte"],
        "label": f["label"],
        "system": f["system"],
        "riskTier": tier,
        "headline": _headline(f),
        "whatWeSaw": _what_we_saw(f),
        "why": why,
        "whatToDoNow": steps,
        "whoDecides": who,
        "sources": sources,
        "value": f["value"],
        "unit": f["unit"],
        "status": f["status"],
        "artifactSuspected": f["artifactSuspected"],
    }


def build_cards(findings, kb, astronaut_id, draw_id, draw_label) -> List[Dict[str, Any]]:
    cards = [c for c in (build_card(f, kb, astronaut_id, draw_id, draw_label) for f in findings) if c]
    cards.sort(key=lambda c: (TIER_ORDER[c["riskTier"]], c["label"]))
    return cards


def max_tier(findings_or_cards: Iterable[Dict[str, Any]]) -> Optional[str]:
    tiers = [x.get("riskTier") for x in findings_or_cards if x.get("riskTier")]
    return min(tiers, key=lambda t: TIER_ORDER[t]) if tiers else None


# ---------------------------------------------------------------- score and triage

def counts_against_score(f: Dict[str, Any]) -> bool:
    return f["status"] != "IN_RANGE" and not f["artifactSuspected"] and f["baselineFlag"] != "PERSONAL_NORMAL"


def score_findings(findings: List[Dict[str, Any]]) -> Tuple[float, List[str]]:
    """Stability score 0 to 100. Weights come from analyteCatalog.scoreWeight."""
    score = 100.0
    reasons: List[str] = []
    for f in findings:
        if not counts_against_score(f):
            continue
        weight = analyte_meta(f["analyte"])["scoreWeight"]
        lo, hi = f["labRange"]
        if f["status"] == "LOW" and lo:
            pct = (lo - f["value"]) / lo
        elif f["status"] == "HIGH" and hi:
            pct = (f["value"] - hi) / hi
        else:
            pct = 0.0
        score -= min(weight * (1.0 + 2.0 * pct), weight * 1.8)
        reasons.append(finding_reason(f))
    return max(0.0, round(score, 1)), reasons


def finding_reason(f: Dict[str, Any]) -> str:
    text = f"{f['label']} {fmt(f['value'])} {f['unit']} ({f['status'].lower().replace('_', ' ')}"
    if f["deltaVsBaselinePct"] is not None:
        text += f", {f['deltaVsBaselinePct']:+.0f}% vs baseline"
    if f["redFlag"] and not f["artifactSuspected"]:
        text += ", red flag"
    if f["artifactSuspected"]:
        text += ", possible sample problem"
    return text + ")"


def triage_entry(
    astronaut_id: str,
    display_name: str,
    simulated: bool,
    draws: List[Dict[str, Any]],
    cfg: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """draws: [{missionDay, score, label, findings}] for one crew member, any order."""
    cfg = cfg or rules_config()
    tcfg = cfg["triage"]
    ordered = sorted(draws, key=lambda d: d["missionDay"])
    current = ordered[-1]
    previous = ordered[-2] if len(ordered) > 1 else None
    prev_score = previous["score"] if previous else current["score"]
    days = max(1, current["missionDay"] - previous["missionDay"]) if previous else 1
    drop_per_day = max(0.0, prev_score - current["score"]) / days
    urgency = round((100.0 - current["score"]) + tcfg["rateWeight"] * drop_per_day, 1)

    if current["missionDay"] < 0:
        return {
            "rowType": "CREW",
            "astronautId": astronaut_id,
            "displayName": display_name,
            "simulated": simulated,
            "tier": "GREEN",
            "score": current["score"],
            "previousScore": None,
            "daysBetweenDraws": None,
            "dropPerDay": 0.0,
            "urgency": 0.0,
            "lastDrawLabel": current.get("label"),
            "reasons": ["Pre-flight baseline only. No in-flight data received yet."],
        }

    findings = current.get("findings", [])
    red = [f for f in findings if f["redFlag"] and not f["artifactSuspected"]]
    shifted = [
        f for f in findings
        if f["status"] != "IN_RANGE" and not f["artifactSuspected"] and f["baselineFlag"] in ("SHIFTED", "NO_BASELINE")
    ]
    if red:
        tier = "RED"
    elif urgency >= tcfg["amberUrgency"] or shifted:
        tier = "AMBER"
    else:
        tier = "GREEN"

    reasons = [finding_reason(f) for f in findings if f["status"] != "IN_RANGE" or f["baselineFlag"] == "SHIFTED"]
    if current.get("note"):
        reasons.insert(0, current["note"])

    return {
        "rowType": "CREW",
        "astronautId": astronaut_id,
        "displayName": display_name,
        "simulated": simulated,
        "tier": tier,
        "score": current["score"],
        "previousScore": prev_score,
        "daysBetweenDraws": days,
        "dropPerDay": round(drop_per_day, 2),
        "urgency": urgency,
        "lastDrawLabel": current.get("label"),
        "reasons": reasons[:6],
    }


def sort_triage(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows.sort(key=lambda r: (TRIAGE_ORDER[r["tier"]], -r.get("urgency", 0), 0 if r.get("trendWatch") else 1))
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


TRIAGE_FORMULA = (
    "urgency = (100 - score) + rateWeight x max(0, previousScore - score) / daysBetweenDraws. "
    "Order: RED (any red-flag value not explained by a sample problem) first, then AMBER "
    "(urgency >= amberUrgency or a value outside the lab range and away from the personal baseline), then GREEN."
)


# ---------------------------------------------------------------- trend watch (not a forecast)

def _linear_fit(points: List[Tuple[float, float]]) -> Tuple[float, float, float]:
    """Least squares y = a + b*x. Returns (a, b, r_squared)."""
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    if sxx == 0:
        return my, 0.0, 0.0
    sxy = sum((p[0] - mx) * (p[1] - my) for p in points)
    b = sxy / sxx
    a = my - b * mx
    ss_tot = sum((p[1] - my) ** 2 for p in points)
    ss_res = sum((p[1] - (a + b * p[0])) ** 2 for p in points)
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return a, b, r2


def trend_watch(
    history: List[Dict[str, Any]],
    cfg: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """history: one crew member's draws [{missionDay, findings}] (any order).

    For each analyte with at least minPoints in-mission values (missionDay >= 0)
    the rule fits a straight line. If the latest value is still inside the lab
    range, the fit is good (R2 >= minRSquared) and the line leaves the range
    within horizonDays, the analyte goes on the watch list. A line through a few
    points is not a forecast; the card says so and asks for a repeat test.
    """
    cfg = cfg or rules_config()
    tcfg = cfg.get("trend", {"minPoints": 3, "horizonDays": 30, "minRSquared": 0.6})
    series: Dict[str, List[Tuple[float, Dict[str, Any]]]] = {}
    for d in history:
        if d.get("missionDay") is None or d["missionDay"] < 0:
            continue
        for f in d.get("findings") or []:
            if f.get("artifactSuspected"):
                continue
            series.setdefault(f["analyte"], []).append((float(d["missionDay"]), f))
    out: List[Dict[str, Any]] = []
    for analyte, pts in series.items():
        if len(pts) < tcfg["minPoints"]:
            continue
        pts.sort(key=lambda p: p[0])
        last_day, last = pts[-1]
        lab_min, lab_max = (last.get("labRange") or [None, None])[:2]
        if last["status"] != "IN_RANGE":
            continue  # already out of range: the card and the triage tier handle it
        a, b, r2 = _linear_fit([(x, float(f["value"])) for x, f in pts])
        if b == 0 or r2 < tcfg["minRSquared"]:
            continue
        if b < 0 and lab_min is not None:
            boundary, limit = "below", float(lab_min)
        elif b > 0 and lab_max is not None:
            boundary, limit = "above", float(lab_max)
        else:
            continue
        fitted_now = a + b * last_day
        days_to_cross = (limit - fitted_now) / b
        if days_to_cross <= 0 or days_to_cross > tcfg["horizonDays"]:
            continue
        unit = last.get("unit", "")
        label = last.get("label") or analyte_meta(analyte)["label"]
        per_week = abs(b) * 7
        out.append(
            {
                "analyte": analyte,
                "label": label,
                "system": last.get("system", analyte_meta(analyte)["system"]),
                "unit": unit,
                "points": len(pts),
                "firstDay": int(pts[0][0]),
                "lastDay": int(last_day),
                "lastValue": float(last["value"]),
                "slopePerWeek": round(b * 7, 3),
                "rSquared": round(r2, 2),
                "boundary": boundary,
                "limit": limit,
                "crossesInDays": int(round(days_to_cross)),
                "horizonDays": tcfg["horizonDays"],
                "text": (
                    f"{label} has been {'falling' if b < 0 else 'rising'} about {fmt(round(per_week, 2))} {unit} per week "
                    f"over {len(pts)} draws. If that line continued, it would go {boundary} {fmt(limit)} {unit} "
                    f"in about {int(round(days_to_cross))} days. A line through a few points is not a forecast: "
                    f"repeat the test sooner."
                ),
            }
        )
    out.sort(key=lambda t: t["crossesInDays"])
    return out


# ---------------------------------------------------------------- vital signs (devices)

def vitals_catalog() -> Dict[str, Any]:
    return load_switch_config().get("vitalsCatalog", {})


def classify_vital(reading_type: str, value: float, cat: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cat = cat or vitals_catalog()
    meta = cat[reading_type]
    lo, hi = meta.get("normalMin"), meta.get("normalMax")
    status = "IN_RANGE"
    if lo is not None and value < lo:
        status = "LOW"
    elif hi is not None and value > hi:
        status = "HIGH"
    return {
        "type": reading_type,
        "label": meta["label"],
        "value": value,
        "unit": meta["unit"],
        "status": status,
        "normalRange": [lo, hi],
        "rangeSource": meta.get("rangeSource", ""),
    }


def _band_score(value: float, bands: List[List[Any]]) -> int:
    """bands: [[upper_inclusive_or_null, score], ...] in ascending order."""
    for upper, score in bands:
        if upper is None or value <= upper:
            return int(score)
    return 0


def news2_partial(latest: Dict[str, Dict[str, Any]], cfg: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Royal College of Physicians NEWS2 parameter scores for the vitals we have.

    latest: {type: {value, measuredAtUtc}}. Consciousness level and supplemental
    oxygen are not measured by these devices, so the result is a partial score
    and says which parameters were used. SpO2 uses Scale 1, air assumed.
    """
    ncfg = (cfg or rules_config()).get("news2")
    if not ncfg:
        return None
    used, scores = [], {}
    for rtype, bands in ncfg["bands"].items():
        if rtype in latest:
            s = _band_score(float(latest[rtype]["value"]), bands)
            scores[rtype] = s
            used.append(rtype)
    if not used:
        return None
    total = sum(scores.values())
    single3 = any(s >= 3 for s in scores.values())
    if total >= ncfg["highAt"]:
        band = "HIGH"
    elif total >= ncfg["mediumAt"]:
        band = "MEDIUM"
    elif single3:
        band = "LOW_MEDIUM"
    else:
        band = "LOW"
    return {
        "score": total,
        "band": band,
        "parameterScores": scores,
        "parametersUsed": used,
        "parametersMissing": [p for p in ncfg["bands"] if p not in used] + ["CONSCIOUSNESS", "SUPPLEMENTAL_O2"],
        "partial": True,
        "source": ncfg["source"],
    }


def vitals_from_canonical(compiled: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Turns a compiled device record into vital readings the catalog knows."""
    cat = vitals_catalog()
    norm = compiled.get("normalized", {})
    pairs: List[Tuple[str, Any]] = []
    if compiled.get("sourceProtocol") == "DEVICE_JSON":
        pairs = [(r["type"], r["value"]) for r in norm.get("readings", [])]
    else:
        mapping = {
            "HR_BPM": "HEART_RATE", "heartRateBpm": "HEART_RATE",
            "SPO2_PCT": "SPO2", "spo2Pct": "SPO2",
            "systolicMmHg": "SYSTOLIC_BP",
            "CO2_AMBIENT_MMHG": "CABIN_CO2_MMHG", "co2MmHg": "CABIN_CO2_MMHG",
        }
        pairs = [(mapping[k], v) for k, v in norm.items() if k in mapping and v is not None]
    out = []
    for rtype, value in pairs:
        if rtype in cat:
            out.append(classify_vital(rtype, float(value), cat))
    return out
