"""Space Health data layer: two SQLite databases and the link between them.

    ship.db   on board. Works with no link. Every new record starts here as
              LOCAL_ONLY_OFFLINE and is chained by hash.
    earth.db  on the ground. Receives only new records (delta sync). A record
              becomes visible on Earth only after the simulated light delay.

Decisions from the flight surgeon travel the other way through an uplink
queue and reach the ship only after the same delay. During a blackout the
downlink is refused and decisions wait in the queue.

Link delays use a demo time scale: 1 real minute of light time is played as
1 second, so Mars at 4 minutes one way takes 4 seconds on screen.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import clinical_rules as rules
import osd575
from crypto_engine import compute_blackbox_hash, decrypt_health_payload, encrypt_health_payload, open_sealed, seal
from exam_parser import extract_measurements, load_switch_config
from universal_compiler import compile_heterogeneous_input

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_DIR = os.environ.get("SPACE_HEALTH_DB_DIR", os.path.join(BASE_DIR, "databases"))
SHIP_DB = os.path.join(DB_DIR, "ship.db")
EARTH_DB = os.path.join(DB_DIR, "earth.db")

_LOCK = threading.RLock()

LINK_PROFILES: Dict[str, Dict[str, Any]] = {
    "LEO": {"label": "Low Earth orbit", "oneWaySeconds": 0.5},
    "MOON": {"label": "Moon", "oneWaySeconds": 1.3},
    "MARS_NEAR": {"label": "Mars, closest", "oneWaySeconds": 4 * 60},
    "MARS_FAR": {"label": "Mars, farthest", "oneWaySeconds": 24 * 60},
}
DEMO_TIME_SCALE = 60.0  # real seconds of light time per demo second

TABLES = """
CREATE TABLE IF NOT EXISTS users_auth (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    mission_role TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 0,
    pin_hash TEXT NOT NULL,
    xp_score INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS telemetry_blackbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT UNIQUE NOT NULL,
    astronaut_id TEXT NOT NULL,
    source_protocol TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    previous_hash TEXT NOT NULL,
    integrity_hash TEXT NOT NULL,
    sync_status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    received_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS crew_draws (
    draw_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    astronaut_id TEXT NOT NULL,
    draw_label TEXT NOT NULL,
    mission_day INTEGER NOT NULL,
    origin TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 0,
    findings_json TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    score REAL,
    note TEXT,
    record_id TEXT,
    sync_status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    received_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS crew_notices (
    notice_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    draw_label TEXT NOT NULL,
    notice_json TEXT NOT NULL,
    sync_status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    received_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS clinical_governance_queue (
    gov_id TEXT PRIMARY KEY,
    draw_id TEXT NOT NULL,
    astronaut_id TEXT NOT NULL,
    source_exam TEXT NOT NULL,
    risk_tier TEXT NOT NULL,
    acting_authority TEXT NOT NULL,
    findings_json TEXT NOT NULL,
    cards_json TEXT NOT NULL,
    status TEXT NOT NULL,
    manager_decision_by TEXT,
    human_directive TEXT,
    decided_at_utc TEXT,
    delivered_at_utc TEXT,
    sync_status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    received_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS card_progress (
    card_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    astronaut_id TEXT NOT NULL,
    done INTEGER NOT NULL,
    updated_at_utc TEXT NOT NULL,
    PRIMARY KEY (card_id, step_index)
);
CREATE TABLE IF NOT EXISTS sync_audit_trail (
    packet_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    link_profile TEXT NOT NULL,
    one_way_seconds REAL NOT NULL,
    records_count INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,
    timestamp_utc TEXT NOT NULL,
    arrives_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS uplink_queue (
    packet_id TEXT PRIMARY KEY,
    gov_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    human_directive TEXT,
    manager TEXT NOT NULL,
    decided_at_utc TEXT NOT NULL,
    deliver_after_utc TEXT,
    delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS device_keys (
    key_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    astronaut_id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    secret_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    last_used_at_utc TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vital_readings (
    reading_id TEXT PRIMARY KEY,
    astronaut_id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    key_id TEXT,
    record_id TEXT,
    reading_json TEXT NOT NULL,
    flagged INTEGER NOT NULL DEFAULT 0,
    measured_at_utc TEXT NOT NULL,
    sync_status TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    received_at_utc TEXT
);
CREATE TABLE IF NOT EXISTS link_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    profile TEXT NOT NULL,
    blackout INTEGER NOT NULL,
    updated_at_utc TEXT NOT NULL
);
"""

GOV_COLUMNS = (
    "gov_id, draw_id, astronaut_id, source_exam, risk_tier, acting_authority, findings_json, cards_json, status, "
    "manager_decision_by, human_directive, decided_at_utc, delivered_at_utc, sync_status, created_at_utc, received_at_utc"
)
DRAW_COLUMNS = (
    "draw_id, batch_id, astronaut_id, draw_label, mission_day, origin, simulated, findings_json, cards_json, score, "
    "note, record_id, sync_status, created_at_utc, received_at_utc"
)


CREW_WIDE = "CREW-WIDE"  # key owner for records about the whole crew (draw notices)


class LinkUnavailable(Exception):
    """Raised when a transfer is attempted during a blackout."""


class Conflict(Exception):
    """Raised when an action would duplicate existing data."""


# ---------------------------------------------------------------- basics

def now_utc(offset_seconds: float = 0.0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat(timespec="milliseconds")


class _ClosingConnection(sqlite3.Connection):
    """sqlite3.Connection whose `with` block commits/rolls back AND closes.

    The stock context manager only ends the transaction and leaves the file
    open; on Windows that keeps the .db locked (reset_demo cannot delete it).
    """

    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            self.close()


def _conn(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=10, factory=_ClosingConnection)
    conn.row_factory = sqlite3.Row
    return conn


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


def pin_hash(user_id: str, pin: str) -> str:
    return hashlib.sha256(f"{user_id}:{pin}".encode("utf-8")).hexdigest()


def init_schema() -> None:
    os.makedirs(DB_DIR, exist_ok=True)
    for path in (SHIP_DB, EARTH_DB):
        with _conn(path) as c:
            c.executescript(TABLES)
    with _conn(EARTH_DB) as c:
        c.execute(
            "INSERT OR IGNORE INTO link_state (id, profile, blackout, updated_at_utc) VALUES (1, 'MARS_NEAR', 0, ?)",
            (now_utc(),),
        )


def databases_exist() -> bool:
    return os.path.exists(SHIP_DB) and os.path.exists(EARTH_DB)


# ---------------------------------------------------------------- users

def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    with _conn(EARTH_DB) as c:
        row = c.execute("SELECT * FROM users_auth WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def check_pin(user_id: str, pin: str) -> Optional[Dict[str, Any]]:
    user = get_user(user_id)
    if user and user["pin_hash"] == pin_hash(user_id, pin):
        return {k: v for k, v in user.items() if k != "pin_hash"}
    return None


def list_users() -> List[Dict[str, Any]]:
    with _conn(EARTH_DB) as c:
        rows = c.execute(
            "SELECT user_id, display_name, role, mission_role, simulated FROM users_auth ORDER BY role, user_id"
        ).fetchall()
    return [dict(r) for r in rows]


def crew_ids(conn: sqlite3.Connection) -> List[str]:
    return [r["user_id"] for r in conn.execute("SELECT user_id FROM users_auth WHERE role = 'CREW' ORDER BY user_id")]


# ---------------------------------------------------------------- link

def get_link() -> Dict[str, Any]:
    with _conn(EARTH_DB) as c:
        row = c.execute("SELECT * FROM link_state WHERE id = 1").fetchone()
    profile = row["profile"] if row else "MARS_NEAR"
    meta = LINK_PROFILES[profile]
    return {
        "profile": profile,
        "label": meta["label"],
        "blackout": bool(row["blackout"]) if row else False,
        "oneWaySeconds": meta["oneWaySeconds"],
        "demoDelaySeconds": round(meta["oneWaySeconds"] / DEMO_TIME_SCALE, 2),
        "timeScale": "1 minute of light time is shown as 1 second",
        "profiles": {k: {"label": v["label"], "oneWaySeconds": v["oneWaySeconds"]} for k, v in LINK_PROFILES.items()},
    }


def set_link(profile: Optional[str] = None, blackout: Optional[bool] = None) -> Dict[str, Any]:
    with _LOCK:
        current = get_link()
        new_profile = profile or current["profile"]
        if new_profile not in LINK_PROFILES:
            raise ValueError(f"Unknown link profile {new_profile!r}. Use one of {list(LINK_PROFILES)}.")
        new_blackout = current["blackout"] if blackout is None else bool(blackout)
        with _conn(EARTH_DB) as c:
            c.execute(
                "UPDATE link_state SET profile = ?, blackout = ?, updated_at_utc = ? WHERE id = 1",
                (new_profile, int(new_blackout), now_utc()),
            )
            if current["blackout"] and not new_blackout:
                delay = LINK_PROFILES[new_profile]["oneWaySeconds"] / DEMO_TIME_SCALE
                c.execute(
                    "UPDATE uplink_queue SET deliver_after_utc = ? WHERE deliver_after_utc IS NULL AND delivered = 0",
                    (now_utc(delay),),
                )
    return get_link()


# ---------------------------------------------------------------- hash-chained record

def _append_blackbox(conn: sqlite3.Connection, astronaut_id: str, protocol: str, payload: Dict[str, Any]) -> str:
    token = encrypt_health_payload(payload, astronaut_id)
    last = conn.execute("SELECT integrity_hash FROM telemetry_blackbox ORDER BY seq DESC LIMIT 1").fetchone()
    prev_hash = last["integrity_hash"] if last else "0" * 64
    record_id = _new_id("REC")
    created = now_utc()
    integrity = compute_blackbox_hash(prev_hash, record_id, astronaut_id, token, created)
    conn.execute(
        "INSERT INTO telemetry_blackbox (record_id, astronaut_id, source_protocol, encrypted_payload, previous_hash, "
        "integrity_hash, sync_status, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_ONLY_OFFLINE', ?)",
        (record_id, astronaut_id, protocol, token, prev_hash, integrity, created),
    )
    return record_id


def verify_chain(db: str = "ship") -> Dict[str, Any]:
    path = SHIP_DB if db == "ship" else EARTH_DB
    with _conn(path) as c:
        rows = c.execute("SELECT * FROM telemetry_blackbox ORDER BY seq").fetchall()
    expected_prev = "0" * 64
    for r in rows:
        recomputed = compute_blackbox_hash(
            r["previous_hash"], r["record_id"], r["astronaut_id"], r["encrypted_payload"], r["created_at_utc"]
        )
        if r["previous_hash"] != expected_prev or recomputed != r["integrity_hash"]:
            return {"db": db, "ok": False, "records": len(rows), "firstBrokenRecordId": r["record_id"]}
        expected_prev = r["integrity_hash"]
    return {"db": db, "ok": True, "records": len(rows), "firstBrokenRecordId": None}


def tamper_record(record_id: Optional[str] = None) -> Dict[str, Any]:
    """Demo only: changes one character of a stored record on the ship."""
    with _LOCK, _conn(SHIP_DB) as c:
        row = (
            c.execute("SELECT * FROM telemetry_blackbox WHERE record_id = ?", (record_id,)).fetchone()
            if record_id
            else c.execute("SELECT * FROM telemetry_blackbox ORDER BY seq DESC LIMIT 1").fetchone()
        )
        if not row:
            raise ValueError("No record to tamper with.")
        payload = row["encrypted_payload"]
        i = len(payload) // 2
        flipped = payload[:i] + ("A" if payload[i] != "A" else "B") + payload[i + 1 :]
        c.execute("UPDATE telemetry_blackbox SET encrypted_payload = ? WHERE record_id = ?", (flipped, row["record_id"]))
    return {"tamperedRecordId": row["record_id"]}


# ---------------------------------------------------------------- draws

def _baselines_for(conn: sqlite3.Connection, astronaut_ids: List[str]) -> Dict[Any, Dict[str, float]]:
    points = []
    qmarks = ",".join("?" * len(astronaut_ids))
    for r in conn.execute(
        f"SELECT astronaut_id, mission_day, findings_json FROM crew_draws WHERE mission_day < 0 AND astronaut_id IN ({qmarks})",
        astronaut_ids,
    ):
        for f in open_sealed(r["findings_json"], r["astronaut_id"]):
            points.append({"subject": r["astronaut_id"], "analyte": f["analyte"], "value": f["value"], "missionDay": r["mission_day"]})
    return rules.build_baselines(points)


def _next_mission_day(conn: sqlite3.Connection, astronaut_id: str) -> int:
    row = conn.execute("SELECT MAX(mission_day) AS d FROM crew_draws WHERE astronaut_id = ?", (astronaut_id,)).fetchone()
    return max(int(row["d"]) if row and row["d"] is not None else 0, 0) + 1


def _store_draw(
    conn: sqlite3.Connection,
    *,
    batch_id: str,
    astronaut_id: str,
    draw_label: str,
    mission_day: int,
    origin: str,
    findings: List[Dict[str, Any]],
    record_id: Optional[str],
    source_exam: str,
    kb: Dict[str, Any],
    sync_status: str = "LOCAL_ONLY_OFFLINE",
    received_at: Optional[str] = None,
    with_governance: bool = True,
    simulated: bool = False,
    note: Optional[str] = None,
) -> Dict[str, Any]:
    draw_id = _new_id("DRW")
    rules.assign_risk_tiers(findings)
    cards = rules.build_cards(findings, kb, astronaut_id, draw_id, draw_label)
    score, _ = rules.score_findings(findings)
    created = now_utc()
    conn.execute(
        f"INSERT INTO crew_draws ({DRAW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (draw_id, batch_id, astronaut_id, draw_label, mission_day, origin, int(simulated),
         seal(findings, astronaut_id), seal(cards, astronaut_id), score, note, record_id, sync_status, created, received_at),
    )
    gov_id = None
    tier = rules.max_tier(cards)
    if with_governance and tier:
        gov_id = _new_id("GOV")
        status = "INFORM_ONLY" if tier == "ROUTINE" else "PENDING_EARTH_REVIEW"
        authority = "CREW_MEDICAL_OFFICER" if tier == "CRITICAL" else "CREW"
        conn.execute(
            f"INSERT INTO clinical_governance_queue ({GOV_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)",
            (gov_id, draw_id, astronaut_id, source_exam, tier, authority, seal(findings, astronaut_id),
             seal(cards, astronaut_id), status, sync_status, created),
        )
    return {"drawId": draw_id, "govId": gov_id, "score": score, "riskTier": tier, "cards": cards, "findings": findings}


def analyze_exam(astronaut_id: str, filename: str, content: str) -> Dict[str, Any]:
    """One crew member enters a lab report (text or PDF). Runs fully on board."""
    parsed = extract_measurements(content)
    if not parsed["measurements"]:
        details = [f"{r['matchedText']}: {r['reason']}" for r in parsed["rejected"]]
        if parsed["unrecognized"]:
            details.append("not in the catalog: " + ", ".join(parsed["unrecognized"]))
        raise ValueError(
            "No lab value could be read safely. " + ("; ".join(details) + ". " if details else "")
            + "Try a line such as 'Potassium: 3.0 mmol/L'."
        )
    kb = rules.load_knowledge_base()
    with _LOCK, _conn(SHIP_DB) as c:
        baselines = _baselines_for(c, [astronaut_id])
        findings = [rules.classify(m, baselines.get((astronaut_id, m["analyte"]))) for m in parsed["measurements"]]
        record_id = _append_blackbox(
            c, astronaut_id, "PDF_EXAM",
            {"filename": filename, "format": parsed["detectedFormat"], "measurements": parsed["measurements"],
             "rejected": parsed["rejected"], "unrecognized": parsed["unrecognized"]},
        )
        stored = _store_draw(
            c,
            batch_id=_new_id("BAT"),
            astronaut_id=astronaut_id,
            draw_label=f"Exam: {filename or 'manual entry'}"[:60],
            mission_day=_next_mission_day(c, astronaut_id),
            origin="CREW_ENTRY",
            findings=findings,
            record_id=record_id,
            source_exam=filename or "manual entry",
            kb=kb,
        )
    return {
        "detectedFormat": parsed["detectedFormat"],
        "recordId": record_id,
        **stored,
        "notices": [],
        "conversions": parsed["conversions"],
        "rejected": parsed["rejected"],
        "unrecognized": parsed["unrecognized"],
    }


def load_osd575_draw(draw_label: str) -> Dict[str, Any]:
    """Loads one real OSD-575 draw for the whole crew, as an analyzer export would arrive on board."""
    if draw_label not in osd575.DRAW_ORDER or draw_label.startswith("L"):
        raise ValueError(f"Choose a post-flight draw: {[d for d in osd575.DRAW_ORDER if d.startswith('R')]}")
    by_subject = osd575.rows_for_draw(draw_label)
    kb = rules.load_knowledge_base()
    with _LOCK, _conn(SHIP_DB) as c:
        exists = c.execute(
            "SELECT COUNT(*) AS n FROM crew_draws WHERE origin = 'NASA_OSDR_OSD575' AND draw_label = ?", (draw_label,)
        ).fetchone()["n"]
        if exists:
            raise Conflict(f"Draw {draw_label} is already loaded.")
        subjects = sorted(by_subject)
        baselines = _baselines_for(c, subjects)
        findings_by = {
            s: [rules.classify(m, baselines.get((s, m["analyte"]))) for m in by_subject[s]] for s in subjects
        }
        notices = rules.detect_draw_artifacts(findings_by, draw_label)
        batch_id = _new_id("BAT")
        results = {}
        for s in subjects:
            record_id = _append_blackbox(
                c, s, "OSD575_CSV_EXCEL",
                {"dataset": "NASA OSDR OSD-575", "draw": draw_label, "measurements": by_subject[s]},
            )
            results[s] = _store_draw(
                c,
                batch_id=batch_id,
                astronaut_id=s,
                draw_label=draw_label,
                mission_day=by_subject[s][0]["missionDay"],
                origin="NASA_OSDR_OSD575",
                findings=findings_by[s],
                record_id=record_id,
                source_exam=f"NASA OSDR OSD-575 draw {draw_label}",
                kb=kb,
            )
        for n in notices:
            c.execute(
                "INSERT INTO crew_notices VALUES (?, ?, ?, ?, 'LOCAL_ONLY_OFFLINE', ?, NULL)",
                (_new_id("NTC"), batch_id, draw_label, seal(n, CREW_WIDE), now_utc()),
            )
    return {
        "drawLabel": draw_label,
        "batchId": batch_id,
        "crew": {s: {"score": r["score"], "riskTier": r["riskTier"], "cards": len(r["cards"])} for s, r in results.items()},
        "notices": notices,
    }


def ingest_sensor(astronaut_id: str, protocol: str, raw_input: Any, key_id: Optional[str] = None) -> Dict[str, Any]:
    """Sends one device frame through the Switch, stores it in the hash chain and
    keeps any vital signs it carries as readings (sealed, synced like everything else)."""
    compiled = compile_heterogeneous_input(protocol, raw_input)
    readings = rules.vitals_from_canonical(compiled)
    with _LOCK, _conn(SHIP_DB) as c:
        record_id = _append_blackbox(c, astronaut_id, compiled["sourceProtocol"], compiled)
        created = now_utc()
        for r in readings:
            measured = next(
                (x.get("measuredAt") for x in compiled["normalized"].get("readings", []) if x.get("type") == r["type"] and x.get("measuredAt")),
                None,
            )
            c.execute(
                "INSERT INTO vital_readings VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_ONLY_OFFLINE', ?, NULL)",
                (_new_id("VIT"), astronaut_id, compiled["sourceProtocol"], key_id, record_id, seal(r, astronaut_id),
                 int(r["status"] != "IN_RANGE"), measured or created, created),
            )
    return {
        "recordId": record_id,
        "canonical": compiled,
        "readings": readings,
        "flagged": [r for r in readings if r["status"] != "IN_RANGE"],
    }


# ---------------------------------------------------------------- device keys (machines that post data)

KEY_PREFIX = "shk_"


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def create_device_key(label: str, astronaut_id: str, adapter: str, created_by: str, *, fixed_secret: Optional[str] = None,
                      key_id: Optional[str] = None) -> Dict[str, Any]:
    """Registers a device on board and returns its API key. The full key is shown once;
    only a SHA-256 of the secret part is stored."""
    label = (label or "").strip()[:60]
    if not label:
        raise ValueError("Give the device a name, for example 'Wristband C003'.")
    adapter = (adapter or "DEVICE_JSON").upper().strip()
    meta = load_switch_config()["adapters"].get(adapter)
    if not meta or meta.get("status") == "FUTURE" or adapter in ("PDF_EXAM", "OSD575_CSV_EXCEL"):
        raise ValueError(f"Adapter {adapter} cannot be used by a device key. Use DEVICE_JSON, BLE_SUIT, LAN_CABIN or HRF_RIC_BUS.")
    with _LOCK, _conn(SHIP_DB) as c:
        if astronaut_id != "CABIN" and not c.execute(
            "SELECT 1 FROM users_auth WHERE user_id = ? AND role = 'CREW'", (astronaut_id,)
        ).fetchone():
            raise ValueError(f"Unknown crew member {astronaut_id!r}. Use a crew id, or CABIN for an environment sensor.")
        key_id = key_id or ("DEV" + secrets.token_hex(4).upper())
        secret = fixed_secret or secrets.token_urlsafe(24).replace("_", "x").replace("-", "y")
        c.execute(
            "INSERT INTO device_keys VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)",
            (key_id, label, astronaut_id, adapter, _hash_secret(secret), created_by, now_utc()),
        )
    return {
        "keyId": key_id,
        "apiKey": f"{KEY_PREFIX}{key_id}_{secret}",
        "label": label,
        "astronautId": astronaut_id,
        "adapter": adapter,
        "note": "Copy the key now. It is not shown again; only a hash is stored.",
    }


def list_device_keys() -> List[Dict[str, Any]]:
    with _conn(SHIP_DB) as c:
        rows = c.execute("SELECT * FROM device_keys ORDER BY created_at_utc DESC").fetchall()
    return [
        {
            "keyId": r["key_id"],
            "label": r["label"],
            "astronautId": r["astronaut_id"],
            "adapter": r["adapter"],
            "createdBy": r["created_by"],
            "createdAtUtc": r["created_at_utc"],
            "lastUsedAtUtc": r["last_used_at_utc"],
            "uses": r["uses"],
            "revoked": bool(r["revoked"]),
        }
        for r in rows
    ]


def revoke_device_key(key_id: str) -> Dict[str, Any]:
    with _LOCK, _conn(SHIP_DB) as c:
        n = c.execute("UPDATE device_keys SET revoked = 1 WHERE key_id = ?", (key_id,)).rowcount
    if not n:
        raise ValueError(f"No device key {key_id}.")
    return {"keyId": key_id, "revoked": True}


def authenticate_device(api_key: str) -> Dict[str, Any]:
    """Returns the key row or raises PermissionError. Constant-time comparison."""
    api_key = (api_key or "").strip()
    if not api_key.startswith(KEY_PREFIX) or api_key.count("_") < 2:
        raise PermissionError("Missing or malformed device key. Send the header X-Device-Key: shk_<id>_<secret>.")
    key_id, secret = api_key[len(KEY_PREFIX):].split("_", 1)
    with _conn(SHIP_DB) as c:
        row = c.execute("SELECT * FROM device_keys WHERE key_id = ?", (key_id,)).fetchone()
    if not row or not hmac.compare_digest(row["secret_sha256"], _hash_secret(secret)):
        raise PermissionError("Unknown device key.")
    if row["revoked"]:
        raise PermissionError("This device key was revoked.")
    return dict(row)


def ingest_device(key: Dict[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
    """Data posted by a machine with a device key. The key, not the body, decides whose record it is."""
    requested = body.get("astronautId")
    if requested and requested != key["astronaut_id"]:
        raise PermissionError(f"This key belongs to {key['astronaut_id']}; it cannot write data for {requested}.")
    adapter = str(body.get("adapter") or key["adapter"]).upper()
    if adapter != key["adapter"]:
        raise PermissionError(f"This key is registered for adapter {key['adapter']}, not {adapter}.")
    raw = {"readings": body.get("readings")} if adapter == "DEVICE_JSON" else body.get("rawInput")
    result = ingest_sensor(key["astronaut_id"], adapter, raw, key_id=key["key_id"])
    with _LOCK, _conn(SHIP_DB) as c:
        c.execute(
            "UPDATE device_keys SET uses = uses + 1, last_used_at_utc = ? WHERE key_id = ?", (now_utc(), key["key_id"])
        )
    return {
        "accepted": True,
        "astronautId": key["astronaut_id"],
        "recordId": result["recordId"],
        "readings": result["readings"],
        "flagged": result["flagged"],
        "conversions": result["canonical"]["conversions"],
    }


def _latest_vitals(conn: sqlite3.Connection, astronaut_id: str, arrived_only: bool = False) -> Dict[str, Dict[str, Any]]:
    sql = "SELECT * FROM vital_readings WHERE astronaut_id = ?"
    params: tuple = (astronaut_id,)
    if arrived_only:
        sql += " AND received_at_utc IS NOT NULL AND received_at_utc <= ?"
        params += (now_utc(),)
    latest: Dict[str, Dict[str, Any]] = {}
    for r in conn.execute(sql + " ORDER BY measured_at_utc", params):
        reading = open_sealed(r["reading_json"], astronaut_id)
        reading["measuredAtUtc"] = r["measured_at_utc"]
        reading["adapter"] = r["adapter"]
        latest[reading["type"]] = reading
    return latest


def _fresh(vitals: Dict[str, Dict[str, Any]], max_age_minutes: float) -> Dict[str, Dict[str, Any]]:
    limit = now_utc(-max_age_minutes * 60)
    return {k: v for k, v in vitals.items() if (v.get("measuredAtUtc") or "") >= limit}


def _vitals_view(vitals: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    ncfg = rules.rules_config().get("news2", {})
    fresh = _fresh(vitals, ncfg.get("maxAgeMinutes", 360))
    return {
        "latest": sorted(vitals.values(), key=lambda v: v["type"]),
        "news2": rules.news2_partial(fresh),
    }


def _history_for_trends(draw_rows: List[sqlite3.Row], astronaut_id: str) -> List[Dict[str, Any]]:
    return [
        {"missionDay": d["mission_day"], "findings": open_sealed(d["findings_json"], astronaut_id)}
        for d in draw_rows
        if d["mission_day"] >= 0
    ]


# ---------------------------------------------------------------- sync

def _arrived(conn: sqlite3.Connection, table: str, where: str = "1=1", params: tuple = ()) -> List[sqlite3.Row]:
    return conn.execute(
        f"SELECT * FROM {table} WHERE received_at_utc IS NOT NULL AND received_at_utc <= ? AND {where}",
        (now_utc(),) + params,
    ).fetchall()


def downlink() -> Dict[str, Any]:
    """Sends every record created on board since the last sync. Refused during a blackout."""
    link = get_link()
    if link["blackout"]:
        raise LinkUnavailable("No link to Earth right now. Records stay on board and will be sent later.")
    delay = link["demoDelaySeconds"]
    arrives = now_utc(delay)
    counts: Dict[str, int] = {}
    digest = hashlib.sha256()
    with _LOCK, _conn(SHIP_DB) as ship, _conn(EARTH_DB) as earth:
        for table, key in (
            ("telemetry_blackbox", "record_id"),
            ("crew_draws", "draw_id"),
            ("crew_notices", "notice_id"),
            ("clinical_governance_queue", "gov_id"),
            ("vital_readings", "reading_id"),
        ):
            rows = ship.execute(
                f"SELECT * FROM {table} WHERE sync_status = 'LOCAL_ONLY_OFFLINE'"
                + (" ORDER BY seq" if table == "telemetry_blackbox" else "")
            ).fetchall()
            for r in rows:
                data = dict(r)
                data["sync_status"] = "SYNCED_WITH_EARTH"
                data["received_at_utc"] = arrives
                cols = ", ".join(data.keys())
                earth.execute(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({', '.join('?' * len(data))})", tuple(data.values()))
                ship.execute(f"UPDATE {table} SET sync_status = 'SYNCED_WITH_EARTH' WHERE {key} = ?", (r[key],))
                digest.update(str(r[key]).encode())
            counts[table] = len(rows)
        packet = {
            "packet_id": _new_id("PKT-DOWN"),
            "direction": "SHIP_TO_EARTH",
            "link_profile": link["profile"],
            "one_way_seconds": link["oneWaySeconds"],
            "records_count": sum(counts.values()),
            "payload_sha256": digest.hexdigest(),
            "timestamp_utc": now_utc(),
            "arrives_at_utc": arrives,
        }
        for conn in (ship, earth):
            conn.execute(
                "INSERT INTO sync_audit_trail VALUES (:packet_id, :direction, :link_profile, :one_way_seconds, "
                ":records_count, :payload_sha256, :timestamp_utc, :arrives_at_utc)",
                packet,
            )
    return {"packetId": packet["packet_id"], "records": counts, "arrivesAtUtc": arrives, "demoDelaySeconds": delay}


def _apply_arrived_uplinks() -> None:
    """Applies flight-surgeon decisions whose light delay has passed."""
    with _LOCK, _conn(EARTH_DB) as earth, _conn(SHIP_DB) as ship:
        due = earth.execute(
            "SELECT * FROM uplink_queue WHERE delivered = 0 AND deliver_after_utc IS NOT NULL AND deliver_after_utc <= ?",
            (now_utc(),),
        ).fetchall()
        for u in due:
            ship.execute(
                "UPDATE clinical_governance_queue SET status = ?, manager_decision_by = ?, human_directive = ?, "
                "decided_at_utc = ?, delivered_at_utc = ? WHERE gov_id = ?",
                (u["decision"], u["manager"], u["human_directive"], u["decided_at_utc"], u["deliver_after_utc"], u["gov_id"]),
            )
            earth.execute("UPDATE uplink_queue SET delivered = 1 WHERE packet_id = ?", (u["packet_id"],))
            earth.execute(
                "UPDATE clinical_governance_queue SET delivered_at_utc = ? WHERE gov_id = ?",
                (u["deliver_after_utc"], u["gov_id"]),
            )


def decide(gov_id: str, decision: str, human_directive: str, manager: str) -> Dict[str, Any]:
    decision = (decision or "").upper().strip()
    if decision not in ("APPROVED", "REJECTED", "DIRECTIVE_SENT"):
        raise ValueError("decision must be APPROVED, REJECTED or DIRECTIVE_SENT.")
    if decision == "DIRECTIVE_SENT" and not (human_directive or "").strip():
        raise ValueError("A directive needs text.")
    link = get_link()
    deliver_after = None if link["blackout"] else now_utc(link["demoDelaySeconds"])
    decided = now_utc()
    with _LOCK, _conn(EARTH_DB) as earth:
        row = earth.execute("SELECT * FROM clinical_governance_queue WHERE gov_id = ?", (gov_id,)).fetchone()
        if not row or not row["received_at_utc"] or row["received_at_utc"] > decided:
            raise ValueError(f"Review item {gov_id} has not reached Earth.")
        text = (human_directive or "").strip()
        sealed_directive = seal(text, row["astronaut_id"]) if text else None
        earth.execute(
            "UPDATE clinical_governance_queue SET status = ?, manager_decision_by = ?, human_directive = ?, decided_at_utc = ? WHERE gov_id = ?",
            (decision, manager, sealed_directive, decided, gov_id),
        )
        packet_id = _new_id("PKT-UP")
        earth.execute(
            "INSERT INTO uplink_queue VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
            (packet_id, gov_id, decision, sealed_directive, manager, decided, deliver_after),
        )
        earth.execute(
            "INSERT INTO sync_audit_trail VALUES (?, 'EARTH_TO_SHIP', ?, ?, 1, ?, ?, ?)",
            (packet_id, link["profile"], link["oneWaySeconds"], hashlib.sha256(packet_id.encode()).hexdigest(), decided, deliver_after),
        )
    return {
        "govId": gov_id,
        "status": decision,
        "packetId": packet_id,
        "deliverAfterUtc": deliver_after,
        "queuedForBlackout": deliver_after is None,
    }


# ---------------------------------------------------------------- crew view (ship database)

def _open_text(value: Optional[str], owner: str) -> Optional[str]:
    """Directives are stored sealed; rows from before encryption at rest are plain text."""
    if value is None:
        return None
    if value.startswith("ENCv1$"):
        return open_sealed(value, owner)
    return value


def _system_tiers(cards: List[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    systems = ["neuro", "cardiovascular", "respiratory", "metabolic", "blood", "musculoskeletal"]
    out: Dict[str, Optional[str]] = {s: None for s in systems}
    for card in cards:
        s = card.get("system")
        if s in out and (out[s] is None or rules.TIER_ORDER[card["riskTier"]] < rules.TIER_ORDER[out[s]]):
            out[s] = card["riskTier"]
    return out


def _review_view(gov: Optional[sqlite3.Row]) -> Dict[str, Any]:
    if not gov:
        return {"status": "NONE", "label": "Logged on board"}
    delivered = bool(gov["delivered_at_utc"])
    status = gov["status"]
    label = {
        "INFORM_ONLY": "For information; no review needed",
        "PENDING_EARTH_REVIEW": "Awaiting ground review" if gov["sync_status"] == "SYNCED_WITH_EARTH" else "Awaiting ground review (not sent yet)",
        "APPROVED": "Confirmed by Flight Surgeon",
        "REJECTED": "Flight Surgeon did not confirm this guidance",
        "DIRECTIVE_SENT": "Directive from Flight Surgeon",
    }.get(status, status)
    return {
        "govId": gov["gov_id"],
        "status": status,
        "label": label,
        "riskTier": gov["risk_tier"],
        "actingAuthority": gov["acting_authority"],
        "sentToEarth": gov["sync_status"] == "SYNCED_WITH_EARTH",
        "decidedBy": gov["manager_decision_by"] if delivered else None,
        "decidedAtUtc": gov["decided_at_utc"] if delivered else None,
        "humanDirective": _open_text(gov["human_directive"], gov["astronaut_id"]) if delivered else None,
    }


def crew_state(astronaut_id: str) -> Dict[str, Any]:
    _apply_arrived_uplinks()
    cfg = load_switch_config()
    with _conn(SHIP_DB) as c:
        user = c.execute("SELECT user_id, display_name, role, mission_role, simulated, xp_score FROM users_auth WHERE user_id = ?", (astronaut_id,)).fetchone()
        if not user:
            raise ValueError(f"Unknown crew member {astronaut_id}.")
        draws = c.execute(
            "SELECT * FROM crew_draws WHERE astronaut_id = ? ORDER BY mission_day DESC, created_at_utc DESC", (astronaut_id,)
        ).fetchall()
        govs = {g["draw_id"]: g for g in c.execute("SELECT * FROM clinical_governance_queue WHERE astronaut_id = ?", (astronaut_id,))}
        latest = next(
            (d for d in draws if d["mission_day"] >= 0 and (d["origin"] != "SIMULATED" or user["simulated"]) and d["cards_json"] != "[]"),
            None,
        )
        cards: List[Dict[str, Any]] = []
        review = _review_view(None)
        notices: List[Dict[str, Any]] = []
        if latest:
            cards = open_sealed(latest["cards_json"], astronaut_id)
            review = _review_view(govs.get(latest["draw_id"]))
            for card in cards:
                card["review"] = review
            notices = [
                n
                for n in (
                    open_sealed(r["notice_json"], CREW_WIDE)
                    for r in c.execute("SELECT notice_json FROM crew_notices WHERE batch_id = ?", (latest["batch_id"],))
                )
                if astronaut_id in n["affected"]
            ]
        progress_rows = c.execute("SELECT card_id, step_index, done FROM card_progress WHERE astronaut_id = ?", (astronaut_id,)).fetchall()
        done = {(p["card_id"], p["step_index"]) for p in progress_rows if p["done"]}
        total_steps = 0
        done_steps = 0
        for card in cards:
            card["stepsDone"] = [(card["cardId"], i) in done for i in range(len(card["whatToDoNow"]))]
            if card["riskTier"] != "ROUTINE":
                total_steps += len(card["whatToDoNow"])
                done_steps += sum(card["stepsDone"])
        pending = sum(
            c.execute(f"SELECT COUNT(*) AS n FROM {t} WHERE sync_status = 'LOCAL_ONLY_OFFLINE'").fetchone()["n"]
            for t in ("telemetry_blackbox", "crew_draws", "crew_notices", "clinical_governance_queue", "vital_readings")
        )
        last_sync = c.execute(
            "SELECT timestamp_utc FROM sync_audit_trail WHERE direction = 'SHIP_TO_EARTH' ORDER BY timestamp_utc DESC LIMIT 1"
        ).fetchone()
        loaded_draws = {
            r["draw_label"] for r in c.execute("SELECT DISTINCT draw_label FROM crew_draws WHERE origin = 'NASA_OSDR_OSD575'")
        }
        last_seen = {
            r["source_protocol"]: r["t"]
            for r in c.execute("SELECT source_protocol, MAX(created_at_utc) AS t FROM telemetry_blackbox GROUP BY source_protocol")
        }
        vitals = _vitals_view(_latest_vitals(c, astronaut_id))
        cabin = _latest_vitals(c, "CABIN")
        symptom_rows = c.execute(
            "SELECT record_id, encrypted_payload, sync_status, created_at_utc FROM telemetry_blackbox WHERE astronaut_id = ? AND source_protocol = 'MANUAL_SYMPTOM' ORDER BY created_at_utc DESC",
            (astronaut_id,),
        ).fetchall()

    symptoms = []
    for sr in symptom_rows:
        try:
            sp = decrypt_health_payload(sr["encrypted_payload"], astronaut_id, "SYSTEM", "FLIGHT_SURGEON")
        except Exception:
            sp = None
        if isinstance(sp, dict):
            symptoms.append(
                {
                    "recordId": sr["record_id"],
                    "astronautId": astronaut_id,
                    "region": sp.get("region", ""),
                    "discomfortType": sp.get("discomfortType", ""),
                    "intensity": sp.get("intensity", "leve"),
                    "onset": sp.get("onset", ""),
                    "duration": sp.get("duration", ""),
                    "description": sp.get("description", ""),
                    "provenance": "Reported by the astronaut (manual entry)",
                    "syncStatus": sr["sync_status"],
                    "createdAtUtc": sr["created_at_utc"],
                }
            )

    history = []
    for d in draws:
        g = govs.get(d["draw_id"])
        findings = open_sealed(d["findings_json"], astronaut_id)
        history.append(
            {
                "drawId": d["draw_id"],
                "label": d["draw_label"],
                "missionDay": d["mission_day"],
                "origin": d["origin"],
                "simulated": bool(d["simulated"]),
                "score": d["score"],
                "note": d["note"],
                "measurements": len(findings),
                "outOfRange": sum(1 for f in findings if f["status"] != "IN_RANGE"),
                "cards": len(open_sealed(d["cards_json"], astronaut_id)),
                "review": _review_view(g)["label"] if g else None,
                "syncStatus": d["sync_status"],
                "createdAtUtc": d["created_at_utc"],
                "findings": findings,
            }
        )

    devices = [
        {
            "adapter": key,
            "label": meta["label"],
            "status": meta.get("status", "ACTIVE"),
            "simulated": meta.get("simulated", False),
            "lastSeenUtc": last_seen.get(key),
        }
        for key, meta in cfg["adapters"].items()
    ]

    return {
        "astronaut": {
            "id": user["user_id"],
            "displayName": user["display_name"],
            "missionRole": user["mission_role"],
            "simulated": bool(user["simulated"]),
            "xp": user["xp_score"],
        },
        "link": get_link(),
        "lastSyncUtc": last_sync["timestamp_utc"] if last_sync else None,
        "pendingUploadRecords": pending,
        "latestDraw": history[0] if history and latest else None,
        "review": review,
        "cards": cards,
        "notices": notices,
        "systems": _system_tiers(cards),
        "progress": {"done": done_steps, "total": total_steps, "pct": round(100 * done_steps / total_steps) if total_steps else 100},
        "history": history,
        "devices": devices,
        "sampleDraws": [
            {"label": d, "loaded": d in loaded_draws} for d in osd575.DRAW_ORDER if d.startswith("R")
        ],
        "vitals": vitals,
        "cabin": sorted(cabin.values(), key=lambda v: v["type"]),
        "trends": rules.trend_watch(_history_for_trends(draws, astronaut_id)),
        "symptoms": symptoms,
    }


def report_symptom(
    astronaut_id: str,
    region: str,
    discomfort_type: str,
    intensity: str,
    onset: str,
    duration: str,
    description: str = "",
) -> Dict[str, Any]:
    region = (region or "").strip()
    discomfort_type = (discomfort_type or "").strip()
    if not region or not discomfort_type:
        raise ValueError("Body region and discomfort type are required.")
    payload = {
        "region": region,
        "discomfortType": discomfort_type,
        "intensity": (intensity or "leve").strip(),
        "onset": (onset or "Agora").strip(),
        "duration": (duration or "Em andamento").strip(),
        "description": (description or "").strip()[:500],
        "provenance": "Reported by the astronaut (manual entry)",
    }
    ts = now_utc()
    with _LOCK, _conn(SHIP_DB) as c:
        rec_id = _append_blackbox(c, astronaut_id, "MANUAL_SYMPTOM", payload)
        c.execute("UPDATE users_auth SET xp_score = xp_score + 5 WHERE user_id = ?", (astronaut_id,))
    return {
        "recordId": rec_id,
        "astronautId": astronaut_id,
        **payload,
        "syncStatus": "LOCAL_ONLY_OFFLINE",
        "createdAtUtc": ts,
    }


def set_step(astronaut_id: str, card_id: str, step_index: int, done: bool) -> Dict[str, Any]:
    with _LOCK, _conn(SHIP_DB) as c:
        prev = c.execute("SELECT done FROM card_progress WHERE card_id = ? AND step_index = ?", (card_id, step_index)).fetchone()
        c.execute(
            "INSERT OR REPLACE INTO card_progress VALUES (?, ?, ?, ?, ?)",
            (card_id, int(step_index), astronaut_id, int(bool(done)), now_utc()),
        )
        if done and not (prev and prev["done"]):
            c.execute("UPDATE users_auth SET xp_score = xp_score + 10 WHERE user_id = ?", (astronaut_id,))
    return {"cardId": card_id, "stepIndex": step_index, "done": bool(done)}


# ---------------------------------------------------------------- ground view (earth database)

def triage() -> Dict[str, Any]:
    cfg = rules.rules_config()
    rows: List[Dict[str, Any]] = []
    with _conn(EARTH_DB) as c:
        users = {u["user_id"]: u for u in c.execute("SELECT * FROM users_auth WHERE role = 'CREW'")}
        draws = _arrived(c, "crew_draws", "score IS NOT NULL")
        notices = _arrived(c, "crew_notices")
    by_crew: Dict[str, List[Dict[str, Any]]] = {}
    last_received: Dict[str, str] = {}
    for d in draws:
        by_crew.setdefault(d["astronaut_id"], []).append(
            {
                "missionDay": d["mission_day"],
                "score": d["score"],
                "label": d["draw_label"],
                "findings": open_sealed(d["findings_json"], d["astronaut_id"]),
                "note": d["note"],
            }
        )
        if d["mission_day"] >= 0:
            last_received[d["astronaut_id"]] = max(last_received.get(d["astronaut_id"], ""), d["received_at_utc"] or "")
    ncfg = cfg.get("news2", {})
    with _conn(EARTH_DB) as c:
        vitals_by_crew = {u: _latest_vitals(c, u, arrived_only=True) for u in users}
    for crew_id, crew_draws in by_crew.items():
        user = users.get(crew_id)
        if not user:
            continue
        entry = rules.triage_entry(crew_id, user["display_name"], bool(user["simulated"]), crew_draws, cfg)
        entry["lastReceivedUtc"] = last_received.get(crew_id)
        entry["trendWatch"] = rules.trend_watch(crew_draws, cfg)
        for t in entry["trendWatch"]:
            entry["reasons"].append(f"Watch: {t['text']}")
        news2 = rules.news2_partial(_fresh(vitals_by_crew.get(crew_id, {}), ncfg.get("maxAgeMinutes", 360)), cfg)
        entry["news2"] = news2
        if news2:
            # Vital signs can raise the tier, never lower it.
            vit_tier = "RED" if news2["band"] == "HIGH" else "AMBER" if news2["band"] in ("MEDIUM", "LOW_MEDIUM") else None
            if vit_tier and rules.TRIAGE_ORDER[vit_tier] < rules.TRIAGE_ORDER[entry["tier"]]:
                entry["tier"] = vit_tier
            if vit_tier:
                entry["reasons"].insert(
                    0, f"Vital signs: partial NEWS2 {news2['score']} ({news2['band'].replace('_', '-').lower()}) from {', '.join(news2['parametersUsed'])}."
                )
        rows.append(entry)
    for n in notices:
        data = open_sealed(n["notice_json"], CREW_WIDE)
        is_assistant = data.get("kind") == "ASSISTANT_EMERGENCY"
        rows.append(
            {
                "rowType": "NOTICE",
                "astronautId": ", ".join(data["affected"]),
                "displayName": "Assistant: emergency words" if is_assistant else f"Crew notice, draw {data['drawLabel']}",
                "simulated": False,
                "tier": data.get("tier", "AMBER"),
                "urgency": 1000 if is_assistant else -1,
                "score": None,
                "reasons": [data["text"]],
                "lastDrawLabel": data["drawLabel"],
                "lastReceivedUtc": n["received_at_utc"],
            }
        )
    return {"formula": rules.TRIAGE_FORMULA, "parameters": cfg["triage"], "queue": rules.sort_triage(rows)}


def governance_items() -> List[Dict[str, Any]]:
    with _conn(EARTH_DB) as c:
        rows = _arrived(c, "clinical_governance_queue")
        uplinks = {u["gov_id"]: u for u in c.execute("SELECT * FROM uplink_queue ORDER BY decided_at_utc")}
        names = {u["user_id"]: u["display_name"] for u in c.execute("SELECT user_id, display_name FROM users_auth")}
    items = []
    for r in rows:
        up = uplinks.get(r["gov_id"])
        delivery = None
        if up:
            delivery = "DELIVERED" if up["delivered"] else ("QUEUED_BLACKOUT" if up["deliver_after_utc"] is None else "IN_TRANSIT")
        items.append(
            {
                "govId": r["gov_id"],
                "drawId": r["draw_id"],
                "astronautId": r["astronaut_id"],
                "displayName": names.get(r["astronaut_id"], r["astronaut_id"]),
                "sourceExam": r["source_exam"],
                "riskTier": r["risk_tier"],
                "actingAuthority": r["acting_authority"],
                "status": r["status"],
                "findings": open_sealed(r["findings_json"], r["astronaut_id"]),
                "cards": open_sealed(r["cards_json"], r["astronaut_id"]),
                "decidedBy": r["manager_decision_by"],
                "humanDirective": _open_text(r["human_directive"], r["astronaut_id"]),
                "decidedAtUtc": r["decided_at_utc"],
                "delivery": delivery,
                "deliverAfterUtc": up["deliver_after_utc"] if up else None,
                "createdAtUtc": r["created_at_utc"],
                "receivedAtUtc": r["received_at_utc"],
            }
        )
    items.sort(key=lambda i: (rules.TIER_ORDER.get(i["riskTier"], 9), i["status"] != "PENDING_EARTH_REVIEW", i["createdAtUtc"]))
    return items


def ground_state() -> Dict[str, Any]:
    _apply_arrived_uplinks()
    with _conn(EARTH_DB) as c:
        in_transit = c.execute(
            "SELECT COUNT(*) AS n FROM crew_draws WHERE received_at_utc > ?", (now_utc(),)
        ).fetchone()["n"]
        audit = [dict(r) for r in c.execute("SELECT * FROM sync_audit_trail ORDER BY timestamp_utc DESC LIMIT 10")]
        arrived_symptoms = _arrived(c, "telemetry_blackbox", "source_protocol = 'MANUAL_SYMPTOM'")
        names = {u["user_id"]: u["display_name"] for u in c.execute("SELECT user_id, display_name FROM users_auth")}
        users = [u["user_id"] for u in c.execute("SELECT user_id FROM users_auth WHERE role = 'CREW'")]
        crew_vitals = {u: _vitals_view(_latest_vitals(c, u, arrived_only=True)) for u in users}
    symptoms = []
    for sr in arrived_symptoms:
        try:
            sp = decrypt_health_payload(sr["encrypted_payload"], sr["astronaut_id"], "SYSTEM", "FLIGHT_SURGEON")
        except Exception:
            sp = None
        if isinstance(sp, dict):
            symptoms.append(
                {
                    "recordId": sr["record_id"],
                    "astronautId": sr["astronaut_id"],
                    "displayName": names.get(sr["astronaut_id"], sr["astronaut_id"]),
                    "region": sp.get("region", ""),
                    "discomfortType": sp.get("discomfortType", ""),
                    "intensity": sp.get("intensity", "leve"),
                    "onset": sp.get("onset", ""),
                    "duration": sp.get("duration", ""),
                    "description": sp.get("description", ""),
                    "provenance": sp.get("provenance", "Reported by the astronaut (manual entry)"),
                    "createdAtUtc": sr["created_at_utc"],
                    "receivedAtUtc": sr["received_at_utc"],
                }
            )
    return {
        "link": get_link(),
        "triage": triage(),
        "governance": governance_items(),
        "recordsInTransit": in_transit,
        "syncLog": audit,
        "symptoms": symptoms,
        "crewVitals": crew_vitals,
    }


# ---------------------------------------------------------------- assistant events

def log_assistant_event(astronaut_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
    """Every assistant answer is kept in the hash chain (sealed). Emergency words also
    create a RED notice for the ground and try to send it at once."""
    payload = {
        "question": result.get("question"),
        "mode": result.get("mode"),
        "engine": result.get("engine"),
        "guardrails": result.get("guardrails", []),
        "sourceIds": [s.get("entryId") for s in result.get("sources", [])],
    }
    out: Dict[str, Any] = {}
    with _LOCK, _conn(SHIP_DB) as c:
        out["recordId"] = _append_blackbox(c, astronaut_id, "ASSISTANT", payload)
        if result.get("mode") == "EMERGENCY":
            trig = result.get("trigger") or {}
            if trig.get("kind") == "sound":
                text = (f"Distress sound heard near {astronaut_id} ({trig.get('detail') or 'sound check'}) and no answer to "
                        "'Are you OK?' in time. The crew was told to call the Crew Medical Officer now.")
            elif trig.get("kind") == "button":
                text = f"{astronaut_id} pressed 'I need help now'. The crew was told to call the Crew Medical Officer now."
            else:
                text = (f"{astronaut_id} used emergency words with the on-board assistant: \"{result.get('question', '')[:160]}\". "
                        "The crew was told to call the Crew Medical Officer now.")
            notice = {
                "kind": "ASSISTANT_EMERGENCY",
                "tier": "RED",
                "drawLabel": "Assistant",
                "affected": [astronaut_id],
                "text": text,
            }
            c.execute(
                "INSERT INTO crew_notices VALUES (?, ?, ?, ?, 'LOCAL_ONLY_OFFLINE', ?, NULL)",
                (_new_id("NTC"), _new_id("ASSIST"), "Assistant", seal(notice, CREW_WIDE), now_utc()),
            )
    if result.get("mode") == "EMERGENCY":
        try:
            sent = downlink()
            out["alert"] = {"sent": True, "arrivesAtUtc": sent["arrivesAtUtc"], "demoDelaySeconds": sent["demoDelaySeconds"]}
        except LinkUnavailable:
            out["alert"] = {"sent": False, "reason": "No link to Earth right now; the alert is queued and goes with the next sync."}
    return out

