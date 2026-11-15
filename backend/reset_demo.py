"""Deletes both databases and seeds the demo state.

    py -3 reset_demo.py

Seeds:
  * users and PINs (all demo PINs are 2026);
  * the three real pre-flight draws (L-92, L-44, L-3) of crew C001 to C004 from
    NASA OSDR OSD-575 on Earth, copied to the ship at boarding: they are the
    personal baselines;
  * two simulated crew members whose score histories show the triage rule
    (an abrupt drop versus a slow drift to the same score). They are marked
    simulated everywhere.

  * one simulated crew member (Marcus) whose potassium drifts down across four
    in-flight draws while staying in range: the trend watch example;
  * two demo device keys, so a script or an Arduino can post data at once
    (DEMO_DEVICE_KEYS below; create real keys from the Crew Medical Officer screen).

Post-flight draws (R+1, R+45, R+82, R+194) are NOT seeded: you load them during
the demo from the crew screen, as an analyzer export arriving on board.

Every health column is stored sealed (see crypto_engine.seal).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import clinical_rules as rules  # noqa: E402
import database_manager as dm  # noqa: E402
import osd575  # noqa: E402

DEMO_PIN = "2026"

USERS = [
    ("C001", "Crew member C001", "CREW", "Inspiration4 crew, real NASA blood data", 0),
    ("C002", "Crew member C002", "CREW", "Inspiration4 crew, real NASA blood data", 0),
    ("C003", "Crew member C003", "CREW", "Inspiration4 crew, real NASA blood data", 0),
    ("C004", "Crew member C004", "CREW", "Inspiration4 crew, real NASA blood data", 0),
    ("sim_alex", "Alex (simulated)", "CREW", "Simulated crew member for the triage example", 1),
    ("sim_elena", "Elena (simulated)", "CREW", "Simulated crew member for the triage example", 1),
    ("sim_marcus", "Marcus (simulated)", "CREW", "Simulated crew member for the trend watch example", 1),
    ("cmo", "Crew Medical Officer", "CREW_MEDICAL_OFFICER", "Crew member with medical training, on board", 0),
    ("surgeon", "Flight Surgeon", "FLIGHT_SURGEON", "Physician in mission control, on Earth", 0),
]

SIMULATED_HISTORIES = {
    "sim_alex": ([(9, 100.0), (10, 90.0)], "Simulated example: score fell from 100 to 90 in one day."),
    "sim_elena": ([(7, 98.0), (8, 96.0), (9, 91.0), (10, 90.0)], "Simulated example: score drifted from 98 to 90 over four days."),
}


# Marcus: stable panel, potassium drifting down inside the range (4.6 -> 3.8 mmol/L over 60 days).
MARCUS_PANEL = {"GLUCOSE": 88.0, "SODIUM": 140.0, "CALCIUM": 9.4, "CREATININE": 0.95, "UREA_NITROGEN_BUN": 14.0}
MARCUS_POTASSIUM = {-30: 4.5, -10: 4.5, 20: 4.6, 40: 4.3, 60: 4.0, 80: 3.8}

DEMO_DEVICE_KEYS = [
    # (key_id, secret, label, astronaut_id, adapter) -> full key shk_<key_id>_<secret>
    ("DEVDEMO", "spacehealth2026", "Demo wristband (C003)", "C003", "DEVICE_JSON"),
    ("DEVCABIN", "spacehealth2026", "Demo cabin CO2 sensor", "CABIN", "DEVICE_JSON"),
]


def _marcus_draws(earth, kb) -> None:
    ranges = rules.load_switch_config()["clinicalReferenceRanges"]
    def panel(day):
        values = dict(MARCUS_PANEL, POTASSIUM=MARCUS_POTASSIUM[day])
        return [
            {"analyte": a, "value": v, "unit": ranges[a]["unit"], "labMin": ranges[a]["min"], "labMax": ranges[a]["max"]}
            for a, v in values.items()
        ]
    pre = [{"subject": "sim_marcus", "analyte": m["analyte"], "value": m["value"], "missionDay": d}
           for d in MARCUS_POTASSIUM if d < 0 for m in panel(d)]
    baselines = rules.build_baselines(pre)
    now = dm.now_utc()
    for day in sorted(MARCUS_POTASSIUM):
        findings = [rules.classify(m, baselines.get(("sim_marcus", m["analyte"])) if day >= 0 else None) for m in panel(day)]
        dm._store_draw(
            earth, batch_id="SIM-sim_marcus", astronaut_id="sim_marcus",
            draw_label=f"{'L-' if day < 0 else 'Day '}{abs(day)} (simulated)", mission_day=day,
            origin="SIMULATED", findings=findings, record_id=None, source_exam="Simulated panel", kb=kb,
            sync_status="EARTH_RECORD", received_at=now, with_governance=False, simulated=True,
            note="Simulated example: potassium drifting down inside the range over four in-flight draws." if day == 80 else None,
        )


def reset() -> dict:
    for path in (dm.SHIP_DB, dm.EARTH_DB):
        if os.path.exists(path):
            os.remove(path)
    dm.init_schema()
    now = dm.now_utc()
    kb = rules.load_knowledge_base()

    with dm._conn(dm.EARTH_DB) as earth:
        earth.executemany(
            "INSERT INTO users_auth VALUES (?, ?, ?, ?, ?, ?, 0)",
            [(u, name, role, mrole, sim, dm.pin_hash(u, DEMO_PIN)) for u, name, role, mrole, sim in USERS],
        )

        rows = osd575.load_rows()
        baselines = rules.build_baselines(rows)
        preflight = {}
        for r in rows:
            if r["missionDay"] < 0:
                preflight.setdefault((r["subject"], r["draw"]), []).append(r)
        for (subject, draw), measurements in sorted(preflight.items(), key=lambda kv: (kv[0][0], kv[1][0]["missionDay"])):
            findings = [rules.classify(m, baselines.get((subject, m["analyte"]))) for m in measurements]
            dm._store_draw(
                earth,
                batch_id=f"BOARD-{draw}",
                astronaut_id=subject,
                draw_label=draw,
                mission_day=measurements[0]["missionDay"],
                origin="NASA_OSDR_OSD575",
                findings=findings,
                record_id=None,
                source_exam=f"NASA OSDR OSD-575 draw {draw}",
                kb=kb,
                sync_status="EARTH_RECORD",
                received_at=now,
                with_governance=False,
            )

        for crew_id, (history, note) in SIMULATED_HISTORIES.items():
            for i, (day, score) in enumerate(history):
                earth.execute(
                    f"INSERT INTO crew_draws ({dm.DRAW_COLUMNS}) VALUES (?, ?, ?, ?, ?, 'SIMULATED', 1, '[]', '[]', ?, ?, NULL, 'EARTH_RECORD', ?, ?)",
                    (f"SIM-{crew_id}-{day}", f"SIM-{crew_id}", crew_id, f"Day {day} (simulated)", day, score,
                     note if i == len(history) - 1 else None, now, now),
                )

        _marcus_draws(earth, kb)

        users = earth.execute("SELECT * FROM users_auth").fetchall()
        draws = earth.execute("SELECT * FROM crew_draws").fetchall()

    with dm._conn(dm.SHIP_DB) as ship:
        ship.executemany("INSERT INTO users_auth VALUES (?, ?, ?, ?, ?, ?, ?)", [tuple(u) for u in users])
        for d in draws:
            data = dict(d)
            data["sync_status"] = "BOARDED"
            cols = ", ".join(data.keys())
            ship.execute(f"INSERT INTO crew_draws ({cols}) VALUES ({', '.join('?' * len(data))})", tuple(data.values()))
        for conn in (ship,):
            conn.execute(
                "INSERT INTO sync_audit_trail VALUES ('PKT-BOARDING', 'EARTH_TO_SHIP_BOARDING', 'LEO', 0, ?, '', ?, ?)",
                (len(draws), now, now),
            )
    with dm._conn(dm.EARTH_DB) as earth:
        earth.execute(
            "INSERT INTO sync_audit_trail VALUES ('PKT-BOARDING', 'EARTH_TO_SHIP_BOARDING', 'LEO', 0, ?, '', ?, ?)",
            (len(draws), now, now),
        )

    demo_keys = [
        dm.create_device_key(label, astronaut, adapter, "reset_demo", fixed_secret=secret, key_id=key_id)["apiKey"]
        for key_id, secret, label, astronaut, adapter in DEMO_DEVICE_KEYS
    ]

    return {"users": len(USERS), "boardedDraws": len(draws), "pin": DEMO_PIN, "demoDeviceKeys": demo_keys,
            "ship": dm.SHIP_DB, "earth": dm.EARTH_DB}


if __name__ == "__main__":
    info = reset()
    print("Space Health demo reset.")
    print(json.dumps(info, indent=2))
