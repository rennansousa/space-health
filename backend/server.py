"""Space Health API server. Python standard library only.

    py -3 server.py            (Windows)
    python3 server.py          (macOS / Linux)

Listens on http://127.0.0.1:8000. If the web app is built (app/dist after
`npm run build` in app/, or the first version in ../dist), it is served from
the same address.

Every endpoint except /api/health, /api/users and /api/login needs
"Authorization: Bearer <token>". The role comes from the user record on the
server, never from the request.
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import assistant  # noqa: E402
import database_manager as dm  # noqa: E402
import osd575  # noqa: E402
import reset_demo  # noqa: E402
from exam_parser import load_switch_config  # noqa: E402

mimetypes.add_type("application/wasm", ".wasm")  # Windows registries often lack these; MediaPipe needs them
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")  # PWA manifest of the app/ build
mimetypes.add_type("model/gltf-binary", ".glb")  # 3D body model
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _pick_web_dir() -> str:
    """Web app served on this port. Order: SPACE_HEALTH_WEB_DIR, the current app (app/dist),
    then the first web version (dist/ at the project root, routes #/crew, #/ground, #/lab)."""
    override = os.environ.get("SPACE_HEALTH_WEB_DIR")
    if override:
        return os.path.abspath(override)
    for rel in (("..", "app", "dist"), ("..", "dist")):
        candidate = os.path.abspath(os.path.join(BASE_DIR, *rel))
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    return os.path.abspath(os.path.join(BASE_DIR, "..", "app", "dist"))


DIST_DIR = _pick_web_dir()
MAX_BODY_BYTES = 15 * 1024 * 1024

TOKENS: Dict[str, str] = {}  # token -> user_id (in memory; restarting the server logs everyone out)

DEVICE_MAX_BODY_BYTES = 64 * 1024
DEVICE_RATE_PER_MINUTE = int(os.environ.get("SPACE_HEALTH_DEVICE_RATE", "120"))
_RATE: Dict[str, list] = {}
_RATE_LOCK = threading.Lock()


def _rate_ok(key_id: str) -> bool:
    """Sliding one-minute window per device key, in memory."""
    now = time.monotonic()
    with _RATE_LOCK:
        hits = [t for t in _RATE.get(key_id, []) if now - t < 60]
        if len(hits) >= DEVICE_RATE_PER_MINUTE:
            _RATE[key_id] = hits
            return False
        hits.append(now)
        _RATE[key_id] = hits
        return True

CREW_SIDE = ("CREW", "CREW_MEDICAL_OFFICER")
GROUND_SIDE = ("FLIGHT_SURGEON",)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "SpaceHealth/1.0"

    # ------------------------------------------------------------ plumbing
    def log_message(self, fmt: str, *args: Any) -> None:  # quieter console
        if "/api/crew/state" in (args[0] if args else "") or "/api/ground/state" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Key")

    def _body(self, limit: int = MAX_BODY_BYTES) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise ApiError(413, f"Request body too large (limit {limit // 1024} KB).")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Body must be JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Body must be a JSON object.")
        return data

    def _user(self) -> Dict[str, Any]:
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        user_id = TOKENS.get(token)
        user = dm.get_user(user_id) if user_id else None
        if not user:
            raise ApiError(401, "Sign in first.")
        return user

    @staticmethod
    def _require(user: Dict[str, Any], roles: Tuple[str, ...]) -> None:
        if user["role"] not in roles:
            raise ApiError(403, f"Role {user['role']} cannot do this.")

    @staticmethod
    def _crew_target(user: Dict[str, Any], requested: Optional[str]) -> str:
        """Crew members act on themselves; the Crew Medical Officer may act on any crew member."""
        if user["role"] == "CREW":
            if requested and requested != user["user_id"]:
                raise ApiError(403, "Crew members can only see their own data.")
            return user["user_id"]
        if user["role"] == "CREW_MEDICAL_OFFICER":
            if not requested:
                raise ApiError(400, "astronautId is required for the Crew Medical Officer.")
            return requested
        raise ApiError(403, "This is a crew-side action.")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if not path.startswith("/api"):
                if method == "GET":
                    return self._static(path)
                raise ApiError(404, "Not found.")
            if path.startswith("/api/v1/"):
                return self._send(200, self._device_route(method, path))
            body = self._body() if method == "POST" else {}
            result = self._route(method, path, query, body)
            self._send(200, result)
        except ApiError as e:
            self._send(e.status, {"error": e.message})
        except dm.LinkUnavailable as e:
            self._send(409, {"error": str(e), "code": "NO_LINK"})
        except dm.Conflict as e:
            self._send(409, {"error": str(e), "code": "CONFLICT"})
        except PermissionError as e:
            self._send(403 if "cannot write" in str(e) or "registered for" in str(e) else 401, {"error": str(e)})
        except (ValueError, KeyError) as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # pragma: no cover
            traceback.print_exc()
            self._send(500, {"error": f"Server error: {e}"})

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    # ------------------------------------------------------------ static web app
    def do_HEAD(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path.startswith("/api"):
            self.send_response(405)
            self.end_headers()
            return
        try:
            self._static(path, head=True)
        except ApiError as e:
            self.send_response(e.status)
            self.end_headers()

    def _static(self, path: str, head: bool = False) -> None:
        if not os.path.isdir(DIST_DIR):
            raise ApiError(404, "Web app not built. In app/: `npm run dev` (http://localhost:5174) or `npm run build`.")
        rel = path.lstrip("/") or "index.html"
        full = os.path.abspath(os.path.join(DIST_DIR, rel))
        if not full.startswith(DIST_DIR) or not os.path.isfile(full):
            if os.path.splitext(rel)[1] not in ("", ".html"):
                raise ApiError(404, f"File not found: /{rel}")  # a missing asset is a 404, not the app page
            full = os.path.join(DIST_DIR, "index.html")
        with open(full, "rb") as fp:
            data = fp.read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)

    # ------------------------------------------------------------ machine API (device keys)
    def _device_route(self, method: str, path: str) -> Any:
        """Routes for machines. Authenticated by a device key, never by a user token.

        GET  /api/v1/schema   the contract a device developer needs (no key needed, no data)
        POST /api/v1/ingest   readings from one device; header X-Device-Key: shk_<id>_<secret>
        """
        if (method, path) == ("GET", "/api/v1/schema"):
            cfg = load_switch_config()
            return {
                "endpoint": "POST /api/v1/ingest",
                "auth": "Header X-Device-Key: shk_<keyId>_<secret> (or Authorization: Device shk_...). Keys are created by the Crew Medical Officer.",
                "limits": {"bodyBytes": DEVICE_MAX_BODY_BYTES, "requestsPerMinutePerKey": DEVICE_RATE_PER_MINUTE, "readingsPerRequest": 50},
                "adapters": {k: {"label": v["label"], "status": v.get("status")} for k, v in cfg["adapters"].items()
                             if k not in ("PDF_EXAM", "OSD575_CSV_EXCEL") and v.get("status") != "FUTURE"},
                "readingTypes": {k: {"unit": v["unit"], "aliases": v.get("aliases", []), "acceptsUnits": v.get("acceptsUnits", [v["unit"]]),
                                     "plausible": [v["plausibleMin"], v["plausibleMax"]]} for k, v in cfg.get("vitalsCatalog", {}).items()},
                "example": {"readings": [{"type": "HEART_RATE", "value": 72, "unit": "bpm"}, {"type": "SPO2", "value": 98, "unit": "%"},
                                         {"type": "BODY_TEMP_C", "value": 36.8, "unit": "C", "measuredAt": "2026-11-15T15:00:00Z"}]},
                "responses": {"200": "accepted", "400": "invalid reading (message says which)", "401": "missing, unknown or revoked key",
                              "403": "key used for another crew member or adapter", "413": "body too large", "429": "rate limit"},
            }
        if (method, path) == ("POST", "/api/v1/ingest"):
            auth = self.headers.get("Authorization", "")
            api_key = self.headers.get("X-Device-Key") or (auth[7:].strip() if auth.lower().startswith("device ") else "")
            key = dm.authenticate_device(api_key)
            if not _rate_ok(key["key_id"]):
                raise ApiError(429, f"Rate limit: at most {DEVICE_RATE_PER_MINUTE} requests per minute per device key.")
            return dm.ingest_device(key, self._body(DEVICE_MAX_BODY_BYTES))
        raise ApiError(404, f"No endpoint {method} {path}.")

    # ------------------------------------------------------------ routes
    def _route(self, method: str, path: str, q: Dict[str, str], b: Dict[str, Any]) -> Any:
        if (method, path) == ("GET", "/api/health"):
            return {"status": "ONLINE", "service": "Space Health API", "databases": dm.databases_exist()}

        if (method, path) == ("GET", "/api/users"):
            return {"users": dm.list_users(), "demoPin": reset_demo.DEMO_PIN}

        if (method, path) == ("POST", "/api/login"):
            user = dm.check_pin(str(b.get("userId", "")), str(b.get("pin", "")))
            if not user:
                raise ApiError(401, "Wrong user or PIN.")
            token = secrets.token_urlsafe(24)
            TOKENS[token] = user["user_id"]
            return {"token": token, "user": user}

        user = self._user()

        if (method, path) == ("GET", "/api/me"):
            return {k: v for k, v in user.items() if k != "pin_hash"}

        # ---- crew side (ship database)
        if (method, path) == ("GET", "/api/crew/state"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, q.get("astronautId"))
            state = dm.crew_state(target)
            if user["role"] == "CREW_MEDICAL_OFFICER":
                state["crewList"] = [u for u in dm.list_users() if u["role"] == "CREW"]
            return state

        if (method, path) == ("POST", "/api/exams/analyze"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, b.get("astronautId"))
            return dm.analyze_exam(target, str(b.get("filename") or "manual entry"), str(b.get("content") or ""))

        if (method, path) == ("POST", "/api/exams/load-draw"):
            self._require(user, CREW_SIDE)
            return dm.load_osd575_draw(str(b.get("draw", "")))

        if (method, path) == ("POST", "/api/cards/step"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, b.get("astronautId"))
            return dm.set_step(target, str(b["cardId"]), int(b["stepIndex"]), bool(b.get("done", True)))

        if (method, path) == ("POST", "/api/sync/downlink"):
            self._require(user, CREW_SIDE)
            return dm.downlink()

        if (method, path) == ("POST", "/api/ingest"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, b.get("astronautId"))
            return dm.ingest_sensor(target, str(b.get("sourceProtocol", "")), b.get("rawInput"))

        if (method, path) == ("POST", "/api/symptoms"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, b.get("astronautId"))
            return dm.report_symptom(
                target,
                str(b.get("region") or ""),
                str(b.get("discomfortType") or ""),
                str(b.get("intensity") or "leve"),
                str(b.get("onset") or "Agora"),
                str(b.get("duration") or "Em andamento"),
                str(b.get("description") or ""),
            )

        # ---- device keys (registry on board, managed by the Crew Medical Officer)
        if (method, path) == ("GET", "/api/devices/keys"):
            self._require(user, ("CREW_MEDICAL_OFFICER",))
            return {"keys": dm.list_device_keys()}

        if (method, path) == ("POST", "/api/devices/keys"):
            self._require(user, ("CREW_MEDICAL_OFFICER",))
            return dm.create_device_key(str(b.get("label", "")), str(b.get("astronautId", "")), str(b.get("adapter") or "DEVICE_JSON"),
                                        user["user_id"])

        if (method, path) == ("POST", "/api/devices/keys/revoke"):
            self._require(user, ("CREW_MEDICAL_OFFICER",))
            return dm.revoke_device_key(str(b.get("keyId", "")))

        # ---- on-board assistant
        if (method, path) == ("GET", "/api/assistant/status"):
            self._require(user, CREW_SIDE)
            return assistant.status()

        if (method, path) == ("POST", "/api/assistant/ask"):
            self._require(user, CREW_SIDE)
            target = self._crew_target(user, b.get("astronautId"))
            cards = dm.crew_state(target)["cards"]
            entry_ids = b.get("entryIds")
            if entry_ids is not None and not (isinstance(entry_ids, list) and all(isinstance(i, str) for i in entry_ids)):
                raise ApiError(400, "entryIds must be a list of topic ids.")
            trigger = b.get("trigger") if isinstance(b.get("trigger"), dict) else None
            result = assistant.ask(str(b.get("question") or ""), cards, entry_ids=entry_ids, emergency=bool(b.get("emergency")),
                                   trigger=trigger)
            result.update(dm.log_assistant_event(target, result))
            return result

        # ---- ground side (earth database)
        if (method, path) == ("GET", "/api/ground/state"):
            self._require(user, GROUND_SIDE)
            return dm.ground_state()

        if (method, path) == ("POST", "/api/governance/decide"):
            self._require(user, GROUND_SIDE)
            return dm.decide(str(b.get("govId", "")), str(b.get("decision", "")), str(b.get("humanDirective") or ""), user["display_name"])

        # ---- shared
        if path == "/api/link":
            if method == "POST":
                return dm.set_link(b.get("profile"), b.get("blackout"))
            return dm.get_link()

        if (method, path) == ("GET", "/api/audit/verify"):
            db = q.get("db", "ship")
            if db not in ("ship", "earth"):
                raise ApiError(400, "db must be ship or earth.")
            return dm.verify_chain(db)

        if (method, path) == ("POST", "/api/demo/tamper"):
            return dm.tamper_record(b.get("recordId"))

        if (method, path) == ("POST", "/api/demo/reset"):
            return reset_demo.reset()

        if (method, path) == ("GET", "/api/switch-config"):
            return {"switchConfig": load_switch_config(), "osd575": osd575.summary()}

        raise ApiError(404, f"No endpoint {method} {path}.")


def main() -> None:
    if not dm.databases_exist():
        print("No databases found; creating the demo state.")
        reset_demo.reset()
    dm.init_schema()
    host = os.environ.get("SPACE_HEALTH_HOST", "127.0.0.1")
    port = int(os.environ.get("SPACE_HEALTH_PORT", "8000"))
    try:
        server = _ExclusiveHTTPServer((host, port), Handler)
    except OSError as exc:
        raise SystemExit(
            f"Port {port} is already in use ({exc}). Another Space Health server is probably still running: "
            f"close it, or start this one with SPACE_HEALTH_PORT set to a free port."
        )
    print(f"Space Health API on http://{host}:{port}  (demo PIN for every user: {reset_demo.DEMO_PIN})", flush=True)
    print(f"  ship database : {dm.SHIP_DB}", flush=True)
    print(f"  earth database: {dm.EARTH_DB}", flush=True)
    web = DIST_DIR if os.path.isfile(os.path.join(DIST_DIR, "index.html")) else "not built (cd app; npm run build)"
    print(f"  web app       : {web}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


class _ExclusiveHTTPServer(ThreadingHTTPServer):
    """On Windows SO_REUSEADDR lets a second process bind the same port silently,
    so requests land on whichever server (possibly a stale one). Bind exclusively."""

    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    main()
