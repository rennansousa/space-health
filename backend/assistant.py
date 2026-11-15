"""Space Health on-board assistant: answers questions from checked protocols only.

The assistant never decides anything. Risk tiers, cards and triage come from the
rules engine. The assistant explains them and quotes protocol entries that cite
a source. Order of checks for every question:

    1. Emergency words  -> fixed reply: call the Crew Medical Officer now. No model.
                           A RED notice is queued for the ground.
    2. Medicine / dose  -> fixed reply: medicines are decided by people. Sources shown.
    3. Retrieval        -> BM25 over the protocol corpus and the crew member's own cards.
                           Nothing relevant -> "no checked protocol", no model.
    4. Answer           -> extractive (quotes the entries) by default. If a local model is
                           configured (Ollama), it may rephrase the retrieved entries; its
                           output is checked and replaced by the extractive answer if it
                           cites nothing or adds numbers with units that the sources lack.

Python standard library only. The model is optional: without it the assistant
still works, offline, in extractive mode.
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
import unicodedata
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from exam_parser import load_switch_config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KNOWLEDGE_DIR = os.path.join(BASE_DIR, "knowledge")
KB_PATH = os.path.join(BASE_DIR, "knowledge_base.json")

DISCLAIMER = "Prototype assistant. It explains results and checked protocols; it does not diagnose or prescribe."

EMERGENCY_PATTERNS = [
    r"chest pain", r"pain in (my|the) chest", r"can'?t breathe", r"cannot breathe", r"not breathing", r"trouble breathing",
    r"unconscious", r"passed out", r"fainted", r"unresponsive", r"won'?t wake", r"seizure", r"convuls",
    r"(severe|heavy|a lot of) bleeding", r"bleeding (a lot|heavily)", r"stroke", r"face (is )?droop", r"slurred speech",
    r"can'?t (move|feel) (my )?(arm|leg|face)", r"anaphyla", r"throat (is )?(closing|swelling)", r"tongue (is )?swelling",
    r"(lips?|face|skin) (is |are )?(turning |going )?blue", r"turning blue", r"not (responding|answering|waking)",
    r"can'?t wake", r"chok(ing|es|ed)", r"collaps",
    r"kill myself", r"suicid", r"end my life", r"hurt myself", r"self[- ]harm",
    r"\bfire\b", r"\bsmoke\b", r"depressuri", r"toxic (leak|spill|release)", r"ammonia",
    # Portuguese
    r"dor no peito", r"nao consigo respirar", r"desmai", r"inconscien", r"convuls", r"sangramento (forte|grave)",
    r"nao (responde|acorda)", r"(labios?|boca) (roxos?|azu)", r"engasg",
    r"\bavc\b", r"me matar", r"suicid",
]
MEDICINE_PATTERNS = [
    r"\bdose\b", r"\bdosage\b", r"\bdosing\b", r"\bmg\b", r"milligram", r"\bpills?\b", r"\btablets?\b", r"\bcapsules?\b",
    r"prescri", r"\bmedicines?\b", r"\bmedications?\b", r"\bdrugs?\b", r"antibiotic", r"painkiller", r"ibuprofen",
    r"acetaminophen", r"paracetamol", r"aspirin", r"promethazine", r"scopolamine", r"insulin",
    r"remedio", r"medicamento", r"comprimido", r"quantos mg",
]
SYNONYMS = {
    "potassio": "potassium", "glicose": "glucose", "sodio": "sodium", "calcio": "calcium", "ureia": "urea bun",
    "creatinina": "creatinine", "enjoo": "nausea", "tontura": "dizziness", "visao": "vision", "cabeca": "headache",
    "acucar": "glucose sugar", "sugar": "glucose", "bun": "urea", "k": "potassium", "na": "sodium",
    "pulse": "heart rate", "fever": "temperature", "oxygen": "spo2", "saturation": "spo2",
    "throwing": "vomit", "throw": "vomit", "puke": "vomit", "spinning": "dizzy", "vertigo": "dizzy", "queasy": "nausea",
    "fog": "foggy", "focus": "concentrate", "blurry": "blur vision", "embacada": "blur vision", "fuzzy": "blur vision",
    "latejando": "headache", "abafado": "stuffy co2", "vomito": "vomit", "vomitando": "vomit",
}
STOP = set("a an the is are was were be been my me i you your of to in on for and or it this that what why how do does did "
           "should can could would with at by from as about have has had not no yes am will just up down since get got "
           "feel feels feeling like things thing look looks really very so we us our here there now when".split())


# ---------------------------------------------------------------- corpus

def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    return text


def _tokens(text: str) -> List[str]:
    words = re.findall(r"[a-z0-9]+", _norm(text))
    out: List[str] = []
    for w in words:
        if w in STOP:
            continue
        out.append(w)
        if w in SYNONYMS:
            out.extend(SYNONYMS[w].split())
        if len(w) > 4 and w.endswith("s"):
            out.append(w[:-1])
    return out


def _has_http_source(entry: Dict[str, Any]) -> bool:
    return any(str(s.get("url", "")).startswith("http") for s in entry.get("sources", []))


def _system_entries() -> List[Dict[str, Any]]:
    src = [{"label": "Space Health rules engine (backend/clinical_rules.py, backend/switch_config.json)", "url": "local:rules"}]
    cfg = load_switch_config()["rules"]
    return [
        {"id": "SYS_TIERS", "category": "SYSTEM_RULE", "title": "What Act now, Attention and Logged mean",
         "keywords": ["act now", "attention", "logged", "routine", "critical", "tier", "card", "colour", "color", "red", "amber"],
         "text": "Act now means a value is past a red-flag limit: call your Crew Medical Officer now. Attention means a value is outside the lab range and away from your own normal: repeat the test and review it. Logged means nothing to do now; it is checked at the next scheduled draw.",
         "steps": [], "sources": src},
        {"id": "SYS_BASELINE", "category": "SYSTEM_RULE", "title": "Why my result is compared with my own pre-flight values",
         "keywords": ["baseline", "personal", "normal", "my normal", "pre-flight", "preflight", "compare", "usual", "out of range", "range"],
         "text": f"Space Health compares each value with the lab range and with the average of your own pre-flight draws. A value outside the lab range but within your usual band (for most tests {cfg['baseline']['outOfRangeTolerancePct']}%, tighter for sodium, chloride, calcium and potassium) is marked as your normal. A value that moved more than {cfg['baseline']['inRangeShiftPct']}% from your average is marked as shifted even inside the lab range.",
         "steps": [], "sources": src},
        {"id": "SYS_SAMPLE", "category": "SYSTEM_RULE", "title": "Why several crew members got a 'possible sample problem' notice",
         "keywords": ["sample", "problem", "whole crew", "everyone", "artifact", "same result", "all of us"],
         "text": f"When at least {cfg['artifact']['minCrew']} crew members show the same change in the same draw, a handling or storage problem with the samples is more likely than the same illness in everyone. Space Health then shows one notice and asks for a repeat draw instead of several alarms.",
         "steps": ["Repeat the draw when your Crew Medical Officer schedules it."], "sources": src},
        {"id": "SYS_WHO_DECIDES", "category": "SYSTEM_RULE", "title": "Who decides what to do",
         "keywords": ["who decides", "decide", "doctor", "surgeon", "flight surgeon", "cmo", "medical officer", "approve", "directive", "ground", "earth", "delay"],
         "text": "The app never decides treatment. For Act now cards, your Crew Medical Officer acts on board without waiting for Earth. Other cards go to the flight surgeon on Earth, who confirms them or sends a directive; that reply arrives after the light delay of the link.",
         "steps": [], "sources": src},
        {"id": "SYS_TREND", "category": "SYSTEM_RULE", "title": "What a trend watch means",
         "keywords": ["trend", "watch", "predict", "prediction", "forecast", "going down", "going up", "falling", "rising", "future"],
         "text": f"When at least {cfg['trend']['minPoints']} in-mission draws of one test fall on a fairly straight line (R2 at least {cfg['trend']['minRSquared']}) and that line would leave the lab range within {cfg['trend']['horizonDays']} days, the test goes on a watch list. A line through a few points is not a forecast; it only means: repeat the test sooner.",
         "steps": ["Ask your Crew Medical Officer whether to move the next draw earlier."], "sources": src},
    ]


def load_corpus() -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    with open(KB_PATH, "r", encoding="utf-8") as fp:
        kb = json.load(fp)
    for e in kb.get("entries", []):
        if not _has_http_source(e):
            continue
        label = e.get("analyte", "").replace("_", " ").lower()
        if not re.search(r"[a-z]", label):
            label = ""
        direction = {"LOW": "low", "HIGH": "high"}.get(e.get("direction", ""), "")
        entries.append(
            {
                "id": e["id"], "category": "LAB_RESULT",
                "title": f"{label} {direction}".strip().capitalize() if label else e["id"].replace("_", " ").capitalize(),
                "keywords": [label, direction, e["id"].replace("_", " ").lower()],
                "text": e.get("why", ""), "steps": e.get("steps", []), "sources": e.get("sources", []),
            }
        )
    for path in sorted(glob.glob(os.path.join(KNOWLEDGE_DIR, "*.json"))):
        with open(path, "r", encoding="utf-8") as fp:
            for e in json.load(fp).get("entries", []):
                if _has_http_source(e):
                    entries.append(e)
    entries.extend(_system_entries())
    return entries


def _card_entries(cards: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for c in cards or []:
        out.append(
            {
                "id": f"MY_{c['analyte']}", "category": "MY_RESULT",
                "title": f"Your result: {c['headline']}",
                "keywords": [c.get("label", ""), c["analyte"].replace("_", " ").lower(), "my", "result", c.get("status", "").lower()],
                "text": f"{c.get('whatWeSaw', '')} {c.get('why', '')}".strip(),
                "steps": c.get("whatToDoNow", []), "sources": c.get("sources", []) or [{"label": "Your latest draw", "url": "local:card"}],
                "boost": 1.3,
            }
        )
    return out


# ---------------------------------------------------------------- retrieval

def _bm25(query: str, docs: List[Dict[str, Any]], k1: float = 1.4, b: float = 0.75) -> List[Tuple[float, Dict[str, Any]]]:
    q = _tokens(query)
    if not q or not docs:
        return []
    doc_tokens = [
        _tokens(" ".join([d["title"], " ".join(d.get("keywords", [])) * 2, d.get("text", ""), " ".join(d.get("steps", []))]))
        for d in docs
    ]
    avg = sum(len(t) for t in doc_tokens) / len(doc_tokens)
    n = len(docs)
    df: Dict[str, int] = {}
    for toks in doc_tokens:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1
    scored = []
    for d, toks in zip(docs, doc_tokens):
        tf: Dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        s = 0.0
        for t in set(q):
            if t not in tf:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * len(toks) / avg))
        scored.append((s * d.get("boost", 1.0), d))
    scored.sort(key=lambda x: -x[0])
    return scored


def _matches(patterns: List[str], text: str) -> List[str]:
    t = _norm(text)
    return [p for p in patterns if re.search(p, t)]


# ---------------------------------------------------------------- answers

def _sources_of(docs: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out, seen = [], set()
    for i, d in enumerate(docs, start=1):
        for s in d.get("sources", []):
            key = s.get("url") or s.get("label")
            if key in seen:
                continue
            seen.add(key)
            out.append({"ref": f"S{i}", "entryId": d["id"], "label": s.get("label", ""), "url": s.get("url", "")})
    return out


def _extractive(docs: List[Dict[str, Any]]) -> str:
    parts = []
    for i, d in enumerate(docs, start=1):
        line = f"[S{i}] {d['title']}. {d['text']}".strip()
        if d.get("steps"):
            line += " What to do: " + " ".join(f"({j}) {s}" for j, s in enumerate(d["steps"], start=1))
        parts.append(line)
    return "\n\n".join(parts)


def _numbers_with_units(text: str) -> set:
    return set(m.group(0).replace(" ", "").lower() for m in re.finditer(r"\d+(?:[.,]\d+)?\s?(mg|g|ml|mcg|µg|units?|iu|mmol|meq|mmhg|%)", text, re.I))


def _ask_model(question: str, docs: List[Dict[str, Any]], cfg: Dict[str, Any], model: str) -> str:
    passages = "\n\n".join(
        f"[S{i}] {d['title']}\n{d['text']}\n" + ("Steps: " + " | ".join(d["steps"]) if d.get("steps") else "")
        for i, d in enumerate(docs, start=1)
    )
    system = (
        "You help an astronaut understand checked protocol text. Rules: answer ONLY from the passages; "
        "cite passages as [S1], [S2]; never diagnose; never name a medicine or a dose that is not in the passages; "
        "never contradict the passages; if the passages do not answer the question, say so and tell them to ask "
        "their Crew Medical Officer; at most 120 words; plain English."
    )
    body = json.dumps(
        {
            "model": model,
            "stream": False,
            "think": False,
            "options": {"temperature": 0, "num_predict": 300},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": f"Passages:\n{passages}\n\nQuestion: {question}"},
            ],
        }
    ).encode("utf-8")
    req = urllib.request.Request(cfg["llmUrl"].rstrip("/") + "/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=cfg.get("timeoutSeconds", 90)) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("message") or {}).get("content", "").strip()


def assistant_config() -> Dict[str, Any]:
    cfg = dict(load_switch_config().get("assistant", {}))
    cfg["llmUrl"] = os.environ.get("SPACE_HEALTH_LLM_URL", cfg.get("llmUrl", "http://127.0.0.1:11434"))
    cfg["llmModel"] = os.environ.get("SPACE_HEALTH_LLM_MODEL", cfg.get("llmModel", ""))
    cfg["router"] = os.environ.get("SPACE_HEALTH_ROUTER", cfg.get("router", "none")).lower().strip() or "none"
    rephrase = os.environ.get("SPACE_HEALTH_LLM_REPHRASE")
    cfg["rephrase"] = (rephrase == "1") if rephrase is not None else bool(cfg.get("rephrase", False))
    return cfg


# ---------------------------------------------------------------- router (AI only interprets)

ROUTER_INTENTS = ("PROTOCOL", "EMERGENCY", "MEDICINE", "OUT_OF_SCOPE")

# Fixed, non-clinical steps a fallback model may pick when no protocol fits. The model chooses
# ids; the crew reads this text. Nothing here names a medicine, a dose or a diagnosis.
BASIC_STEPS = {
    "TELL_CMO_NOW": "Tell your Crew Medical Officer now.",
    "TELL_CMO_TODAY": "Tell your Crew Medical Officer today.",
    "STOP_AND_REST": "Stop the task if it is safe to do so and rest where a crewmate can see you.",
    "STAY_WITH_CREWMATE": "Do not stay alone; ask a crewmate to stay with you.",
    "LOG_SYMPTOMS": "Write down what you feel, when it started and what you were doing.",
    "REPEAT_MEASUREMENT": "Repeat the measurement to confirm.",
    "CHECK_CABIN_READINGS": "Check the cabin readings (CO2, temperature) on the station display.",
    "DRINK_WATER": "Drink water unless your Crew Medical Officer told you otherwise.",
}
BASIC_STEPS_SOURCE = {"label": "Space Health basic safe steps (fixed text, no clinical content)", "url": "local:basic-steps"}


def _router_catalog(corpus: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    return [{"id": d["id"], "title": d["title"], "keywords": ", ".join(k for k in d.get("keywords", [])[:8] if k)} for d in corpus]


def _route_ollama(question: str, catalog: List[Dict[str, str]], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Asks a local model to map the words to catalog ids. The JSON schema limits the
    answer to known intents and ids, so the model cannot write free text here."""
    ids = [c["id"] for c in catalog]
    schema = {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": list(ROUTER_INTENTS)},
            "entryIds": {"type": "array", "items": {"type": "string", "enum": ids}, "maxItems": 3},
            "basicSteps": {"type": "array", "items": {"type": "string", "enum": list(BASIC_STEPS)}, "maxItems": 3},
        },
        "required": ["intent", "entryIds"],
    }
    lines = "\n".join(f"{c['id']}: {c['title']} ({c['keywords']})" for c in catalog)
    system = (
        "You route an astronaut's words (typed, spoken, or just keywords, in English or Portuguese, maybe with "
        "speech-recognition errors) to on-board protocol ids. Answer only JSON. intent EMERGENCY if a life may be at "
        "risk now; MEDICINE if they ask which medicine or dose; OUT_OF_SCOPE if no id fits; else PROTOCOL with up to 3 "
        "ids from this list, best first:\n" + lines + "\nWhen intent is OUT_OF_SCOPE you may add up to 3 basicSteps ids "
        "that are safe for what they describe: " + ", ".join(f"{k} ({v})" for k, v in BASIC_STEPS.items())
    )
    body = json.dumps(
        {
            "model": cfg["llmModel"],
            "stream": False,
            "think": False,  # thinking models (for example Qwen3) answer faster without a reasoning pass; ignored by others
            "format": schema,
            "options": {"temperature": 0, "num_predict": 120},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": question}],
        }
    ).encode("utf-8")
    req = urllib.request.Request(cfg["llmUrl"].rstrip("/") + "/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=cfg.get("timeoutSeconds", 90)) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return json.loads((data.get("message") or {}).get("content", "{}"))


def _route_needle(question: str, catalog: List[Dict[str, str]], cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Same job with Cactus Needle (a small on-device tool-calling model, pip install cactus-needle).
    Telemetry of that package is switched off before import. Untested in our CI: the
    weights download from Hugging Face on first use; run samples/try_router.py first."""
    os.environ.setdefault("NEEDLE_TELEMETRY", "0")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    import typing

    import needle  # type: ignore

    ids = tuple(c["id"] for c in catalog)
    picked: Dict[str, Any] = {"intent": "OUT_OF_SCOPE", "entryIds": []}

    def open_protocol(topic):
        picked["intent"] = "PROTOCOL"
        picked["entryIds"].append(topic)
        return {"opened": topic}

    open_protocol.__doc__ = "Open the on-board health protocol that matches what the crew member said. Topics: " + "; ".join(
        f"{c['id']} = {c['title']}" for c in catalog
    )
    open_protocol.__annotations__ = {"topic": typing.Literal[ids]}

    def report_emergency():
        picked["intent"] = "EMERGENCY"
        return {"emergency": True}

    report_emergency.__doc__ = "Someone may die or be badly hurt now: not breathing, unconscious, chest pain, heavy bleeding, fire."

    def ask_about_medicine():
        picked["intent"] = picked["intent"] if picked["intent"] == "EMERGENCY" else "MEDICINE"
        return {"medicine": True}

    ask_about_medicine.__doc__ = "The crew member asks which medicine to take or what dose."

    agent = needle.Needle(tools=[needle.tool(open_protocol), needle.tool(report_emergency), needle.tool(ask_about_medicine)])
    try:
        agent.run(question)
    finally:
        close = getattr(agent, "close", None)
        if close:
            close()
    return picked


def _route_one(engine: str, question: str, catalog: List[Dict[str, str]], cfg: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    known = {c["id"] for c in catalog}
    try:
        if engine == "ollama":
            if not cfg.get("llmModel"):
                return None, ["router_needs_SPACE_HEALTH_LLM_MODEL"]
            raw = _route_ollama(question, catalog, cfg)
        elif engine == "needle":
            raw = _route_needle(question, catalog, cfg)
        else:
            return None, [f"router_unknown_engine ({engine})"]
    except Exception as e:  # any failure falls back to the next engine, then keyword search
        return None, [f"router_unavailable ({engine}: {type(e).__name__})"]
    if not isinstance(raw, dict):
        return None, [f"router_bad_output ({engine})"]
    intent = raw.get("intent") if raw.get("intent") in ROUTER_INTENTS else "OUT_OF_SCOPE"
    ids = [i for i in (raw.get("entryIds") or []) if isinstance(i, str)]
    valid = [i for i in dict.fromkeys(ids) if i in known][:3]
    steps = [i for i in dict.fromkeys(raw.get("basicSteps") or []) if i in BASIC_STEPS][:3]
    guard = [f"router_dropped_unknown_ids ({engine})"] if len(valid) < len(set(ids)) else []
    return {"intent": intent, "entryIds": valid, "basicSteps": steps, "engine": engine}, guard


def route(question: str, corpus: List[Dict[str, Any]], cfg: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Runs the router engines in order (for example "needle,ollama"). The next engine is asked
    only for the exceptions: when the previous one failed or found no protocol. Any engine may
    escalate (EMERGENCY, MEDICINE); none can de-escalate. Returns the decision and guardrails."""
    engines = [e.strip() for e in str(cfg.get("router", "none")).split(",") if e.strip() and e.strip() != "none"]
    if not engines:
        return None, []
    catalog = _router_catalog(corpus)
    guards: List[str] = []
    last: Optional[Dict[str, Any]] = None
    for i, engine in enumerate(engines):
        res, g = _route_one(engine, question, catalog, cfg)
        guards += g
        if res is None:
            continue
        if i > 0:
            guards.append(f"router_fallback_used ({engine})")
        if res["intent"] in ("EMERGENCY", "MEDICINE") or (res["intent"] == "PROTOCOL" and res["entryIds"]):
            return res, guards
        last = res  # OUT_OF_SCOPE: let the next engine try
    return last, guards


def status() -> Dict[str, Any]:
    cfg = assistant_config()
    corpus = load_corpus()
    info = {
        "corpusEntries": len(corpus), "model": cfg["llmModel"] or None, "llmUrl": cfg["llmUrl"], "llmReachable": False,
        "modelInstalled": False, "mode": "extractive", "router": cfg["router"], "rephrase": cfg["rephrase"],
        "topics": [{"id": d["id"], "title": d["title"], "category": d.get("category", "")} for d in corpus],
    }
    if cfg["router"] == "needle":
        try:
            import importlib.util
            info["needleInstalled"] = importlib.util.find_spec("needle") is not None
        except Exception:
            info["needleInstalled"] = False
    if not cfg["llmModel"]:
        return info
    try:
        with urllib.request.urlopen(cfg["llmUrl"].rstrip("/") + "/api/tags", timeout=1.5) as resp:
            tags = json.loads(resp.read().decode("utf-8"))
        info["llmReachable"] = True
        names = {m.get("name", "") for m in tags.get("models", [])}
        info["modelInstalled"] = cfg["llmModel"] in names or f"{cfg['llmModel']}:latest" in names
        info["mode"] = "model" if info["modelInstalled"] and cfg["rephrase"] else "extractive"
    except (urllib.error.URLError, OSError, ValueError):
        pass
    return info


EMERGENCY_REPLY = {
    "mode": "EMERGENCY",
    "engine": "fixed",
    "answer": "This may be an emergency. Call your Crew Medical Officer now, or any crewmate if you cannot reach them, "
              "and start the onboard emergency procedure for this situation. Do not wait for the ground. "
              "Space Health has queued an alert for the flight surgeon.",
    "steps": ["Call your Crew Medical Officer now.", "Start the onboard emergency procedure.", "Stay with the crew member until help arrives."],
    "sources": [],
    "escalate": True,
}
MEDICINE_TEXT = ("Medicines and doses are decided by your Crew Medical Officer with the flight surgeon, using the onboard medical "
                 "checklist. I can explain your results and the checked protocols, but I do not choose or dose a medicine.")


def ask(
    question: str,
    cards: Optional[List[Dict[str, Any]]] = None,
    use_model: bool = True,
    entry_ids: Optional[List[str]] = None,
    emergency: bool = False,
    trigger: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """question: typed or spoken text. entry_ids: topics tapped on screen (no AI, no typing).
    emergency: the one-tap emergency button."""
    question = (question or "").strip()
    cfg = assistant_config()
    corpus = load_corpus() + _card_entries(cards or [])
    by_id = {d["id"]: d for d in corpus}

    if emergency:
        kind = (trigger or {}).get("kind", "button")
        if kind not in ("button", "sound"):
            kind = "button"
        detail = str((trigger or {}).get("detail", ""))[:80]
        return {"question": question or f"[emergency {kind}{': ' + detail if detail else ''}]", "disclaimer": DISCLAIMER,
                **EMERGENCY_REPLY, "guardrails": [f"emergency_{kind}"], "trigger": {"kind": kind, "detail": detail}}

    if entry_ids:
        docs = [by_id[i] for i in dict.fromkeys(entry_ids) if i in by_id][:3]
        if not docs:
            raise ValueError("Unknown topic. Choose one from the list on screen.")
        return {
            "question": question or "[topic chosen on screen]",
            "disclaimer": DISCLAIMER,
            "mode": "ANSWER",
            "engine": "selected",
            "guardrails": [],
            "answer": _extractive(docs),
            "steps": [s for d in docs for s in d.get("steps", [])][:5],
            "sources": _sources_of(docs),
            "interpretedAs": [{"entryId": d["id"], "title": d["title"], "by": "tap"} for d in docs],
        }

    if not question:
        raise ValueError("Ask a question, for example: why is my potassium flagged?")
    if len(question) > 500:
        raise ValueError("Keep the question under 500 characters.")
    base: Dict[str, Any] = {"question": question, "disclaimer": DISCLAIMER, "guardrails": []}

    # 1. Fixed word lists first. The model can never turn these off.
    if _matches(EMERGENCY_PATTERNS, question):
        return {**base, **EMERGENCY_REPLY, "guardrails": ["emergency_words"]}
    medicine_words = bool(_matches(MEDICINE_PATTERNS, question))

    # 2. Optional router: AI only maps words to catalog ids; it may escalate, never de-escalate.
    routed, rguard = (None, [])
    if use_model and not medicine_words:
        routed, rguard = route(question, corpus, cfg)
    base["guardrails"] += rguard
    if routed and routed["intent"] == "EMERGENCY":
        return {**base, **EMERGENCY_REPLY, "engine": f"router:{routed['engine']}",
                "guardrails": base["guardrails"] + ["router_flagged_emergency"]}

    # 3. Keyword search always runs; router picks are added in front of it.
    ranked = [(s, d) for s, d in _bm25(question, corpus) if s > 0]
    best = ranked[0][0] if ranked else 0.0
    top = [d for s, d in ranked[: cfg.get("maxSources", 3)] if s >= max(cfg.get("minScore", 1.2), best * 0.6)]
    interpreted: List[Dict[str, str]] = []
    if routed and routed["intent"] == "PROTOCOL" and routed["entryIds"]:
        picks = [by_id[i] for i in routed["entryIds"]]
        top = (picks + [d for d in top if d["id"] not in routed["entryIds"]])[: cfg.get("maxSources", 3)]
        interpreted = [{"entryId": d["id"], "title": d["title"], "by": f"router:{routed['engine']}"} for d in picks]

    if medicine_words or (routed and routed["intent"] == "MEDICINE"):
        if routed and routed["intent"] == "MEDICINE" and not medicine_words:
            base["guardrails"].append("router_flagged_medicine")
        strong = best >= cfg.get("minScore", 1.2) or bool(interpreted)
        return {
            **base,
            "mode": "MEDICINE_REFUSED",
            "engine": "fixed",
            "guardrails": base["guardrails"] + ["medicine_or_dose"],
            "answer": MEDICINE_TEXT,
            "steps": ["Ask your Crew Medical Officer."],
            "sources": _sources_of(top) if strong else [],
            "related": _extractive(top) if strong else "",
        }

    if (best < cfg.get("minScore", 1.2) and not interpreted) or not top:
        topics = sorted({d["title"] for d in corpus if d["category"] != "MY_RESULT"})
        if routed and routed.get("basicSteps"):
            steps = [BASIC_STEPS[k] for k in routed["basicSteps"]]
            if BASIC_STEPS["TELL_CMO_NOW"] not in steps and BASIC_STEPS["TELL_CMO_TODAY"] not in steps:
                steps.append(BASIC_STEPS["TELL_CMO_TODAY"])
            return {
                **base,
                "mode": "BASIC_STEPS",
                "engine": f"router:{routed['engine']}",
                "guardrails": base["guardrails"] + ["no_checked_protocol", "basic_steps_from_fixed_list"],
                "answer": "No checked protocol matches this. Basic steps until you reach your Crew Medical Officer:",
                "steps": steps,
                "sources": [{"ref": "S1", "entryId": "BASIC_STEPS", **BASIC_STEPS_SOURCE}],
                "topics": topics,
            }
        return {
            **base,
            "mode": "OUT_OF_SCOPE",
            "engine": "fixed",
            "guardrails": base["guardrails"] + ["no_checked_protocol"],
            "answer": "I don't have a checked protocol for that. Ask your Crew Medical Officer. I only answer from the protocols "
                      "loaded on board and from your own latest results. You can also tap a topic below.",
            "topics": topics,
            "sources": [],
        }

    extractive = _extractive(top)
    answer, engine = extractive, "extractive"
    model = cfg.get("llmModel") or ""
    if use_model and model and cfg.get("rephrase"):
        try:
            text = _ask_model(question, top, cfg, model)
            source_text = " ".join(d["text"] + " " + " ".join(d.get("steps", [])) for d in top)
            invented = _numbers_with_units(text) - _numbers_with_units(source_text)
            if not re.search(r"\[S\d\]", text):
                base["guardrails"].append("model_answer_without_citation_replaced")
            elif invented:
                base["guardrails"].append("model_added_numbers_replaced")
            elif _matches(MEDICINE_PATTERNS, text) and not _matches(MEDICINE_PATTERNS, source_text):
                base["guardrails"].append("model_named_medicine_replaced")
            else:
                answer, engine = text, f"ollama:{model}"
        except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
            base["guardrails"].append(f"model_unavailable ({type(e).__name__})")

    alternatives = [{"entryId": d["id"], "title": d["title"]} for s, d in ranked if d not in top][:3]
    return {
        **base,
        "mode": "ANSWER",
        "engine": engine,
        "answer": answer,
        "steps": [s for d in top for s in d.get("steps", [])][:5],
        "sources": _sources_of(top),
        "matched": [{"entryId": d["id"], "title": d["title"]} for d in top],
        "interpretedAs": interpreted or [{"entryId": d["id"], "title": d["title"], "by": "keywords"} for d in top[:1]],
        "alternatives": alternatives,
    }
