"""Exam text and PDF parser.

Turns a lab report (plain text, a raw PDF, or a base64 data URI of a PDF) into a
list of measurements. Uses only the Python standard library: PDF streams are
inflated with zlib and text is read from the Tj/TJ operators. Extraction rules
(regular expressions, PT and EN) live in switch_config.json.

This module only extracts numbers. Classification and guidance live in
clinical_rules.py.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import re
import zipfile
import zlib
from xml.etree import ElementTree
from typing import Any, Dict, List, Tuple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SWITCH_CONFIG_PATH = os.path.join(BASE_DIR, "switch_config.json")


def load_switch_config() -> Dict[str, Any]:
    with open(SWITCH_CONFIG_PATH, "r", encoding="utf-8") as fp:
        return json.load(fp)


def _decode_pdf_bytes_to_text(pdf_bytes: bytes) -> str:
    """Extracts text from a PDF using only zlib and regular expressions."""
    chunks: List[str] = [pdf_bytes.decode("latin-1", errors="ignore")]

    for match in re.finditer(rb"stream\r?\n(.*?)(?:\r?\n)?endstream", pdf_bytes, flags=re.DOTALL):
        stream_data = match.group(1)
        head = pdf_bytes[max(0, match.start() - 300) : match.start()]
        if b"ASCII85Decode" in head:
            # Some generators (ReportLab, older Acrobat) wrap the deflated stream in ASCII85.
            try:
                raw = stream_data.strip()
                raw = raw[2:] if raw.startswith(b"<~") else raw
                stream_data = base64.a85decode(raw if raw.endswith(b"~>") else raw + b"~>", adobe=False)
            except Exception:
                try:
                    stream_data = base64.a85decode(stream_data.strip().rstrip(b"~>").rstrip(), adobe=False)
                except Exception:
                    pass
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS, zlib.MAX_WBITS | 32):
            try:
                chunks.append(zlib.decompress(stream_data, wbits).decode("latin-1", errors="ignore"))
                break
            except Exception:
                continue

    combined = "\n".join(chunks)
    literals: List[str] = []
    for lit in re.finditer(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|\"|\])", combined):
        token = lit.group(1).replace(r"\(", "(").replace(r"\)", ")").replace(r"\\", "\\")
        token = re.sub(
            r"\\([0-7]{3})",
            lambda m: bytes([int(m.group(1), 8)]).decode("latin-1", errors="ignore"),
            token,
        )
        if any(ch.isalnum() for ch in token):
            literals.append(token)

    if literals:
        return "\n".join(literals)
    return pdf_bytes.decode("utf-8", errors="ignore")


_XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _xlsx_rows(data: bytes) -> List[List[str]]:
    """Reads the first worksheet of an .xlsx file with zipfile + XML (no extra packages)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared: List[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _XLSX_NS):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % _XLSX_NS["m"])))
        sheets = sorted(n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        if not sheets:
            raise ValueError("The spreadsheet has no worksheet.")
        root = ElementTree.fromstring(z.read(sheets[0]))
    rows: List[List[str]] = []
    for row in root.iter("{%s}row" % _XLSX_NS["m"]):
        cells: List[str] = []
        for cell in row.findall("m:c", _XLSX_NS):
            ref = cell.get("r", "")
            col = 0
            for ch in re.sub(r"[0-9]", "", ref):
                col = col * 26 + (ord(ch.upper()) - 64)
            while len(cells) < col - 1:
                cells.append("")
            ctype = cell.get("t")
            v = cell.find("m:v", _XLSX_NS)
            if ctype == "s" and v is not None:
                value = shared[int(v.text)]
            elif ctype == "inlineStr":
                value = "".join(t.text or "" for t in cell.iter("{%s}t" % _XLSX_NS["m"]))
            else:
                value = v.text if v is not None and v.text is not None else ""
            cells.append(value.strip())
        if any(cells):
            rows.append(cells)
    return rows


def _data_lines(text: str) -> List[str]:
    return [l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]


def _csv_rows(text: str) -> List[List[str]]:
    text = "\n".join(_data_lines(text))
    sample = text[:2000]
    delimiter = ";" if sample.count(";") > sample.count(",") else ("\t" if sample.count("\t") > sample.count(",") else ",")
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), delimiter=delimiter) if any(c.strip() for c in row)]


def _looks_tabular(text: str) -> bool:
    """True when most of the first lines split into the same number of columns."""
    lines = _data_lines(text)[:10]
    if len(lines) < 2:
        return False
    for sep in (",", ";", "\t"):
        counts = [l.count(sep) for l in lines]
        common = max(set(counts), key=counts.count)
        if common >= 1 and counts.count(common) >= max(2, int(0.6 * len(lines) + 0.5)):
            return True
    return False


def rows_to_text(rows: List[List[str]]) -> str:
    """Turns spreadsheet rows into 'Analyte: value unit' lines the extractors read.

    Accepts two layouts:
      * any table whose first text column names the test and next numeric column holds the value
        (header such as Test | Result | Unit | Reference);
      * the NASA OSDR OSD-575 layout (ANALYTE, VALUE, UNITS, SUBJECT_ID, ...). A file with several
        crew members is refused here: load it with the crew draw loader instead.
    """
    if not rows:
        return ""
    header = [h.strip().upper() for h in rows[0]]
    if "ANALYTE" in header and "VALUE" in header:
        ia, iv = header.index("ANALYTE"), header.index("VALUE")
        iu = header.index("UNITS") if "UNITS" in header else None
        if "SUBJECT_ID" in header:
            subjects = {r[header.index("SUBJECT_ID")] for r in rows[1:] if len(r) > header.index("SUBJECT_ID")}
            if len(subjects) > 1:
                raise ValueError(
                    f"This file has {len(subjects)} crew members ({', '.join(sorted(subjects))}). "
                    "Upload one person's results, or load the whole draw with the crew draw buttons."
                )
        lines = []
        for r in rows[1:]:
            if len(r) > max(ia, iv):
                lines.append(f"{r[ia]}: {r[iv]} {r[iu] if iu is not None and len(r) > iu else ''}".strip())
        return "\n".join(lines)
    lines = []
    for r in rows:
        name = next((c for c in r if c and not re.fullmatch(r"[-+]?[0-9]+(?:[.,][0-9]+)?", c)), None)
        if not name:
            continue
        rest = r[r.index(name) + 1 :]
        value = next((c for c in rest if re.fullmatch(r"[-+]?[0-9]+(?:[.,][0-9]+)?", c)), None)
        if value is None:
            continue
        after = rest[rest.index(value) + 1 :]
        unit = after[0] if after and not re.search(r"[0-9]", after[0]) else ""
        lines.append(f"{name}: {value} {unit}".strip())
    return "\n".join(lines)


def normalize_exam_input(raw_content: str) -> Tuple[str, str]:
    """Returns (text, detected_format) for a data URI, a raw PDF, a spreadsheet or plain text."""
    text = (raw_content or "").strip()
    if not text:
        return "", "EMPTY"

    if text.lower().startswith("data:") and ";base64," in text.lower():
        b64_part = text.split(",", 1)[1].strip()
        try:
            decoded = base64.b64decode(b64_part, validate=False)
        except Exception:
            decoded = b""
        if decoded.lstrip().startswith(b"%PDF-"):
            return _decode_pdf_bytes_to_text(decoded), "PDF"
        if decoded.startswith(b"PK"):
            try:
                return rows_to_text(_xlsx_rows(decoded)), "XLSX"
            except zipfile.BadZipFile:
                raise ValueError("The file looks like a zip archive but is not an .xlsx spreadsheet.")
        if decoded:
            text = decoded.decode("utf-8-sig", errors="ignore").strip()
            if _looks_tabular(text):
                return rows_to_text(_csv_rows(text)), "CSV"
            return text, "TEXT_FILE"

    if text.startswith("JVBERi0"):
        try:
            return _decode_pdf_bytes_to_text(base64.b64decode(text, validate=False)), "PDF"
        except Exception:
            pass

    if text.lstrip().startswith("%PDF-"):
        return _decode_pdf_bytes_to_text(text.encode("latin-1", errors="ignore")), "PDF"

    if _looks_tabular(text):
        return rows_to_text(_csv_rows(text)), "CSV"

    return text, "TEXT"


UNIT_VOCAB = {
    "mg/dl", "mg/l", "g/dl", "g/l", "mmol/l", "umol/l", "nmol/l", "pmol/l", "meq/l", "ug/dl", "ug/l", "ng/ml",
    "ng/dl", "pg/ml", "u/l", "ui/l", "iu/l", "mui/l", "miu/l", "mu/l", "uui/ml", "uiu/ml", "%", "mmhg", "msv",
    "msv/day", "msv/d", "um", "bpm", "ppm", "kpa", "fl", "pg", "mg/24h",
}
_UNIT_RE = re.compile(r"\s*([a-zA-Zµμ%][a-zA-Zµμ%0-9/\.]{0,9})")


def _norm_unit(token: str) -> str:
    t = token.lower().replace("µ", "u").replace("μ", "u").replace("mcg", "ug").replace("mcmol", "umol")
    t = t.replace("dl.", "dl").rstrip(".,;:)")
    return {"meq/dl": "meq/dl", "mg/dl.": "mg/dl", "u/i": "u/l"}.get(t, t)


def _unit_after(text: str, pos: int) -> str:
    """The unit printed right after a number, if it is a known unit; '' otherwise."""
    m = _UNIT_RE.match(text, pos)
    if not m:
        return ""
    unit = _norm_unit(m.group(1))
    return unit if unit in UNIT_VOCAB else ""


def _fmt_num(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".")


def _run_extractors(text: str, config: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
    """Finds known tests, reads the printed unit, converts it to the canonical unit, and
    refuses what it cannot read safely. Returns measurements, rejected values and
    'name: number unit' lines that no extractor knows (so nothing disappears silently)."""
    ranges = config["clinicalReferenceRanges"]
    clean = re.sub(r"[ \t\r]+", " ", text)
    measurements: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    consumed: List[Tuple[int, int]] = []
    seen = set()

    def overlaps(a: int, b: int) -> bool:
        return any(a < e and s < b for s, e in consumed)

    for rule in config["pdfRegexExtractors"]:
        analyte = rule["analyte"]
        if analyte in seen:
            continue
        ref = ranges.get(analyte, {})
        canonical = ref.get("unit", rule.get("defaultUnit", ""))
        units = rule.get("units") or {_norm_unit(canonical): 1}
        lo, hi = (rule.get("plausible") or [None, None])[:2]
        for pattern in rule["patterns"]:
            for m in re.finditer(pattern, clean, flags=re.IGNORECASE | re.UNICODE):
                if overlaps(m.start(), m.end()):
                    continue
                try:
                    raw = float(m.group(1).replace(",", "."))
                except ValueError:
                    continue
                unit = _unit_after(clean, m.end(1))
                shown = m.group(0).strip() + (f" {unit}" if unit else "")
                if unit and unit not in units:
                    rejected.append({"analyte": analyte, "matchedText": shown, "span": (m.start(), m.end()),
                                     "reason": f"unit {unit} is not accepted for {rule.get('displayName', analyte)} "
                                               f"(accepted: {', '.join(units)})"})
                    continue  # another extractor may own this unit (for example blood CO2 vs cabin CO2)
                factor = units.get(unit, 1.0) if unit else float(units.get("", 1.0) if "" in units else next(iter(units.values())))
                value = raw if factor == 1.0 else round(raw * factor, 2 if abs(raw * factor) < 10 else 1)
                if lo is not None and not (lo <= value <= hi):
                    rejected.append({"analyte": analyte, "matchedText": shown, "span": (m.start(), m.end()),
                                     "reason": f"{_fmt_num(value)} {canonical} is not a plausible value; "
                                               f"check the unit (write it after the number) or the decimal point"})
                    consumed.append((m.start(), m.end()))
                    break
                item = {
                    "analyte": analyte,
                    "value": value,
                    "unit": canonical,
                    "labMin": ref.get("min"),
                    "labMax": ref.get("max"),
                    "matchedText": shown,
                }
                if factor != 1.0:
                    item["conversion"] = f"{_fmt_num(raw)} {unit or 'as printed'} -> {_fmt_num(value)} {canonical} ({rule.get('displayName', analyte)})"
                measurements.append(item)
                consumed.append((m.start(), m.end()))
                seen.add(analyte)
                break
            if analyte in seen:
                break

    accepted_spans = consumed
    rejected = [
        {k: v for k, v in r.items() if k != "span"}
        for r in rejected
        if not any(r["span"][0] < e and s < r["span"][1] and r["analyte"] in seen for s, e in accepted_spans)
        or r["analyte"] not in seen
    ]
    # De-duplicate rejections of the same text.
    uniq, keys = [], set()
    for r in rejected:
        if r["matchedText"] in keys or r["analyte"] in seen:
            continue
        keys.add(r["matchedText"])
        uniq.append(r)

    unrecognized: List[str] = []
    for m in re.finditer(r"([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ()\-\.,;/]{1,40}?)\s*[:=]?\s*[-+]?([0-9]+(?:[.,][0-9]+)?)", clean):
        if overlaps(m.start(2), m.end(2)) or any(r["matchedText"].startswith(m.group(1).strip()[:6]) for r in uniq):
            continue
        if _unit_after(clean, m.end(2)):
            name = m.group(1).strip(" :;,-")
            if name and name not in unrecognized:
                unrecognized.append(name)
    return {"measurements": measurements, "rejected": uniq, "unrecognized": unrecognized[:20]}


def extract_measurements(raw_content: str) -> Dict[str, Any]:
    """Extracts measurements with the lab ranges from switch_config.json.

    Returns {"detectedFormat", "textPreview", "measurements": [{analyte, value, unit,
    labMin, labMax, matchedText, conversion?}], "rejected": [{analyte, matchedText, reason}],
    "unrecognized": [test names with a number and a unit that no extractor knows], "conversions": [...]}.
    """
    config = load_switch_config()
    text, detected = normalize_exam_input(raw_content)
    result = _run_extractors(text, config)
    if detected == "CSV" and not (raw_content or "").lower().startswith("data:"):
        # Pasted text that only looked like a table: keep whichever reading finds more values.
        plain = _run_extractors(raw_content, config)
        if len(plain["measurements"]) > len(result["measurements"]):
            text, detected, result = raw_content, "TEXT", plain
    clean = re.sub(r"[ \t\r]+", " ", text)
    return {
        "detectedFormat": detected,
        "textPreview": clean[:400],
        "measurements": result["measurements"],
        "rejected": result["rejected"],
        "unrecognized": result["unrecognized"],
        "conversions": [m["conversion"] for m in result["measurements"] if m.get("conversion")],
    }
