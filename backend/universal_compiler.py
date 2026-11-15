"""Space Health input switch: converts a device frame into one canonical record.

Which adapters exist, and whether each is ACTIVE, SIMULATED or FUTURE, is
declared in switch_config.json. Future adapters are listed there to show how a
new device plugs in; they have no implementation and are refused here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from exam_parser import extract_measurements, load_switch_config


def compile_heterogeneous_input(source_protocol: str, raw_input: Any) -> Dict[str, Any]:
    cfg = load_switch_config()
    protocol = (source_protocol or "").upper().strip()
    meta = cfg.get("adapters", {}).get(protocol)
    if meta is None:
        raise ValueError(f"Unknown adapter {protocol!r}. Add it to switch_config.json first.")
    if meta.get("status") == "FUTURE" or not meta.get("enabled", True):
        raise ValueError(f"Adapter {protocol} is listed as a future adapter and is not implemented.")

    notes: List[str] = []
    normalized: Dict[str, Any] = {}
    data = raw_input if isinstance(raw_input, dict) else {}

    if protocol == "BLE_SUIT":
        # Simulated frame "A5:HR:SPO2:TEMPF*10" in hex, or a dict with the same fields.
        if isinstance(raw_input, str) and ":" in raw_input:
            parts = raw_input.strip().split(":")
            hr = int(parts[1], 16) if len(parts) > 1 else None
            spo2 = int(parts[2], 16) if len(parts) > 2 else None
            temp_f = int(parts[3], 16) / 10.0 if len(parts) > 3 else None
            notes.append(f"Decoded simulated BLE frame {raw_input!r}")
        else:
            hr, spo2, temp_f = data.get("heart_rate"), data.get("spo2"), data.get("temp_fahrenheit")
        normalized = {
            "HR_BPM": hr,
            "SPO2_PCT": spo2,
            "skinTempC": round((float(temp_f) - 32.0) * 5.0 / 9.0, 1) if temp_f is not None else None,
        }
        if temp_f is not None:
            notes.append(f"Converted {temp_f} F to {normalized['skinTempC']} C")

    elif protocol == "LAN_CABIN":
        co2_ppm = float(data.get("co2_ppm", 0))
        normalized = {
            "CO2_AMBIENT_MMHG": round(co2_ppm / 1315.79, 2),
            "cabinTempC": round(float(data.get("cabin_temp_k", 273.15)) - 273.15, 1),
        }
        notes.append(f"Converted {int(co2_ppm)} ppm CO2 to {normalized['CO2_AMBIENT_MMHG']} mmHg partial pressure at 760 mmHg cabin")

    elif protocol == "HRF_RIC_BUS":
        mappings = meta.get("defaultMappings", {})
        for raw_key, value in data.items():
            normalized[mappings.get(raw_key, raw_key)] = value
        notes.append("Renamed rack-bus keys to canonical keys (simulated adapter)")

    elif protocol == "PDF_EXAM":
        content = data.get("content", "") if data else str(raw_input)
        parsed = extract_measurements(content)
        normalized = {"measurements": parsed["measurements"], "detectedFormat": parsed["detectedFormat"]}
        notes.append(f"Extracted {len(parsed['measurements'])} lab values from {parsed['detectedFormat']}")

    elif protocol == "DEVICE_JSON":
        readings = data.get("readings") if isinstance(raw_input, dict) else raw_input
        normalized = {"readings": _device_readings(readings, cfg.get("vitalsCatalog", {}), notes)}
        notes.append(f"Accepted {len(normalized['readings'])} reading(s) from a generic device")

    elif protocol == "OSD575_CSV_EXCEL":
        normalized = {"rows": data.get("rows", [])}
        notes.append("Lab analyzer export in the NASA OSDR OSD-575 column format")

    return {
        "schema": cfg.get("schemaVersion", "SH-CANONICAL-1"),
        "sourceProtocol": protocol,
        "adapterLabel": meta.get("label", protocol),
        "simulated": bool(meta.get("simulated", False)),
        "compiledAtUtc": datetime.now(timezone.utc).isoformat(),
        "conversions": notes,
        "normalized": normalized,
    }


def _device_readings(readings: Any, catalog: Dict[str, Any], notes: List[str]) -> List[Dict[str, Any]]:
    """Validates generic device readings against vitalsCatalog.

    Each reading: {"type": "HEART_RATE", "value": 72, "unit": "bpm", "measuredAt": "...optional ISO time"}.
    Unknown types, non-numbers and physically impossible values are refused with
    a message that says which reading failed, so a device developer can fix it.
    """
    if not isinstance(readings, list) or not readings:
        raise ValueError('Send {"readings": [{"type": "HEART_RATE", "value": 72, "unit": "bpm"}]} with at least one reading.')
    if len(readings) > 50:
        raise ValueError("At most 50 readings per request.")
    alias = {a.upper(): key for key, meta in catalog.items() for a in [key] + meta.get("aliases", [])}
    out: List[Dict[str, Any]] = []
    for i, r in enumerate(readings):
        if not isinstance(r, dict):
            raise ValueError(f"readings[{i}] must be an object.")
        rtype = alias.get(str(r.get("type", "")).upper().strip())
        if not rtype:
            raise ValueError(f"readings[{i}].type {r.get('type')!r} is not known. Known types: {', '.join(catalog)}.")
        try:
            value = float(r.get("value"))
        except (TypeError, ValueError):
            raise ValueError(f"readings[{i}].value must be a number.")
        meta = catalog[rtype]
        unit = str(r.get("unit") or meta["unit"]).strip()
        if rtype == "BODY_TEMP_C" and unit.upper().lstrip("°") == "F":
            notes.append(f"Converted {value} F to {round((value - 32) * 5 / 9, 1)} C")
            value = round((value - 32) * 5 / 9, 1)
        elif rtype == "CABIN_CO2_MMHG" and unit.lower() == "ppm":
            notes.append(f"Converted {value} ppm CO2 to {round(value / 1315.79, 2)} mmHg at 760 mmHg cabin pressure")
            value = round(value / 1315.79, 2)
        if not (meta["plausibleMin"] <= value <= meta["plausibleMax"]):
            raise ValueError(
                f"readings[{i}] {rtype}={value} is outside what a sensor can plausibly report "
                f"({meta['plausibleMin']} to {meta['plausibleMax']} {meta['unit']}). Check the sensor."
            )
        out.append({"type": rtype, "value": value, "unit": meta["unit"], "measuredAt": r.get("measuredAt")})
    return out

