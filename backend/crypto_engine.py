"""
Space Health: demo payload cipher and hash-chained audit record.

- encrypt_health_payload: DEMO cipher (HMAC-SHA256 keystream + HMAC tag), stdlib
  only. It shows where encryption sits in the design. It is not production
  cryptography; a real system would use AES-256-GCM from a vetted library and
  keys from a key management service.
- compute_blackbox_hash: each record stores the hash of the previous record, so
  any later change to a stored record is detectable (see verify_chain).
"""

import base64
import functools
import hashlib
import hmac
import json
import os
from typing import Any, Dict

# Demo key. Override with the SPACE_HEALTH_SECRET environment variable.
MASTER_CLUSTER_SECRET = os.environ.get("SPACE_HEALTH_SECRET", "space-health-demo-key-change-me").encode("utf-8")

@functools.lru_cache(maxsize=256)
def derive_user_key(astronaut_id: str) -> bytes:
    """Per-user 256-bit key derived with PBKDF2-HMAC-SHA256 (salt = user id). Cached in memory."""
    salt = f"space-health-user:{astronaut_id}".encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", MASTER_CLUSTER_SECRET, salt, iterations=10_000, dklen=32)


def _keystream_xor(data: bytes, key: bytes, iv: bytes) -> bytes:
    """HMAC-SHA256 in counter mode as a keystream, XORed with the data."""
    blocks = (len(data) + 31) // 32
    stream = b"".join(hmac.new(key, iv + i.to_bytes(4, "big"), hashlib.sha256).digest() for i in range(blocks))[: len(data)]
    return (int.from_bytes(data, "big") ^ int.from_bytes(stream, "big")).to_bytes(len(data), "big") if data else b""


def encrypt_health_payload(payload: Dict[str, Any], astronaut_id: str) -> str:
    """
    Encrypts a health record for storage in the Earth or ship database.
    Formato salvo no banco: ENCv1$<iv_b64>$<ciphertext_b64>$<hmac_sha256_tag>
    """
    key = derive_user_key(astronaut_id)
    iv = os.urandom(12)
    plaintext = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ciphertext = _keystream_xor(plaintext, key, iv)

    iv_b64 = base64.urlsafe_b64encode(iv).decode("ascii")
    ct_b64 = base64.urlsafe_b64encode(ciphertext).decode("ascii")

    # HMAC-SHA256 tag: detects tampering with the stored row
    auth_message = f"ENCv1${iv_b64}${ct_b64}".encode("ascii")
    auth_tag = hmac.new(key, auth_message, hashlib.sha256).hexdigest()[:32]

    return f"ENCv1${iv_b64}${ct_b64}${auth_tag}"


def decrypt_health_payload(
    encrypted_token: str,
    astronaut_id: str,
    requester_id: str,
    requester_role: str,
) -> Dict[str, Any]:
    """Decrypts only for the owner, the Crew Medical Officer or the Flight Surgeon."""
    if requester_role not in ("FLIGHT_SURGEON", "CREW_MEDICAL_OFFICER") and requester_id != astronaut_id:
        raise PermissionError(f"User {requester_id!r} may not read records of {astronaut_id!r}.")

    parts = encrypted_token.split("$")
    if len(parts) != 4 or parts[0] != "ENCv1":
        raise ValueError("Invalid encrypted record format.")

    _, iv_b64, ct_b64, received_tag = parts
    key = derive_user_key(astronaut_id)
    auth_message = f"ENCv1${iv_b64}${ct_b64}".encode("ascii")
    expected_tag = hmac.new(key, auth_message, hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(received_tag, expected_tag):
        raise ValueError("Integrity check failed: the stored record was changed.")

    iv = base64.urlsafe_b64decode(iv_b64.encode("ascii"))
    ciphertext = base64.urlsafe_b64decode(ct_b64.encode("ascii"))
    return json.loads(_keystream_xor(ciphertext, key, iv).decode("utf-8"))


def compute_blackbox_hash(
    previous_hash: str,
    record_id: str,
    astronaut_id: str,
    encrypted_payload: str,
    timestamp_utc: str,
) -> str:
    """SHA-256 over the previous hash and this record. Changing any past record breaks every later link."""
    raw_chain = f"{previous_hash}|{record_id}|{astronaut_id}|{encrypted_payload}|{timestamp_utc}"
    return hashlib.sha256(raw_chain.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- at-rest helpers
# The API layer decides who may read what (see server.py). These helpers are the
# storage layer: every health column is written sealed and opened on read.

def seal(obj: Any, owner_id: str) -> str:
    """Encrypts a JSON-serialisable value for storage. owner_id selects the key."""
    return encrypt_health_payload({"v": obj}, owner_id)


def open_sealed(text: Any, owner_id: str) -> Any:
    """Opens a value written by seal(). Plain JSON (rows written before
    encryption at rest existed) is read as is, so old databases keep working."""
    if text is None:
        return None
    if isinstance(text, str) and text.startswith("ENCv1$"):
        return decrypt_health_payload(text, owner_id, "SYSTEM", "FLIGHT_SURGEON")["v"]
    return json.loads(text) if isinstance(text, str) else text


def is_sealed(text: Any) -> bool:
    return isinstance(text, str) and text.startswith("ENCv1$")
