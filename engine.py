import os
import re
import json
import math
import time
import base64
import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone
import requests
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DB_PATH = os.path.join(os.path.dirname(__file__), "liftosauring.db")
KEY_FILE_PATH = os.path.join(os.path.dirname(__file__), ".liftosauring.key")

# Keys encrypted before per-install secrets existed used this hardcoded value; it is only
# ever used to decrypt so existing databases keep working (and get re-encrypted on next sync).
LEGACY_SECRET_KEY = hashlib.sha256(b"liftosauring-apex-dino-secret-key-2026").digest()


def _load_secret_key() -> bytes:
    """Per-install AES key: LIFTOSAURING_SECRET env var, else a random key persisted next to the DB."""
    env_secret = os.environ.get("LIFTOSAURING_SECRET", "").strip()
    if env_secret:
        return hashlib.sha256(env_secret.encode("utf-8")).digest()
    try:
        with open(KEY_FILE_PATH, "rb") as f:
            raw = f.read()
        if len(raw) == 32:
            return raw
    except FileNotFoundError:
        pass
    raw = os.urandom(32)
    fd = os.open(KEY_FILE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return raw


SECRET_KEY = _load_secret_key()

LIFTOSAUR_BASE = os.environ.get("LIFTOSAUR_API_BASE", "https://www.liftosaur.com/api/v1").rstrip("/")

# 9 Prehistoric Ranks (0 - 1000 Score Scale)
# Each Tier spans ~111 points, divided into III, II, I (except Hatchling & Apex Meteor)
RANK_TIERS = [
    {"id": "hatchling", "name": "Hatchling", "min": 0, "max": 120, "color": "#71717a", "glow": "rgba(113,113,122,0.15)", "icon": "I", "desc": "Foundation phase. Establishing baseline compound movement patterns."},
    {"id": "compy", "name": "Compy", "min": 120, "max": 240, "color": "#a1a1aa", "glow": "rgba(161,161,170,0.15)", "icon": "II", "desc": "Early progression. Consistent barbell exposure and linear adaptation."},
    {"id": "gallimimus", "name": "Gallimimus", "min": 240, "max": 360, "color": "#94a3b8", "glow": "rgba(148,163,184,0.18)", "icon": "III", "desc": "Novice standard. Solid work capacity across primary compounds."},
    {"id": "raptor", "name": "Velociraptor", "min": 360, "max": 480, "color": "#d4d4d8", "glow": "rgba(212,212,216,0.20)", "icon": "IV", "desc": "Intermediate territory. Above-average pound-for-pound force production."},
    {"id": "triceratops", "name": "Triceratops", "min": 480, "max": 600, "color": "#5eead4", "glow": "rgba(94,234,212,0.20)", "icon": "V", "desc": "Advanced structural strength. Heavy multi-plate compound proficiency."},
    {"id": "stegosaurus", "name": "Stegosaurus", "min": 600, "max": 720, "color": "#34d399", "glow": "rgba(52,211,153,0.22)", "icon": "VI", "desc": "High-tier performance. Top quartile strength across primary lifts."},
    {"id": "allosaurus", "name": "Allosaurus", "min": 720, "max": 840, "color": "#38bdf8", "glow": "rgba(56,189,248,0.25)", "icon": "VII", "desc": "Elite natural territory. Top 10% allometric strength standard."},
    {"id": "trex", "name": "Tyrannosaurus", "min": 840, "max": 940, "color": "#f59e0b", "glow": "rgba(245,158,11,0.28)", "icon": "VIII", "desc": "Master class. Exceptional 1RM output relative to bodyweight."},
    {"id": "meteor", "name": "Apex Extinction", "min": 940, "max": 1500, "color": "#f43f5e", "glow": "rgba(244,63,94,0.30)", "icon": "IX", "desc": "World-class outlier. 99th percentile strength standard."}
]

# Exercise Categorization & Elite Reference Standards (Ratio of e1RM to Bodyweight for Score = 850 T-Rex entry)
# Allows fair pound-for-pound scoring across all exercises!
EXERCISE_META = {
    "Squat": {"muscle": "Legs", "elite_bw_ratio": 2.35, "is_compound": True, "icon": "🦵"},
    "Front Squat": {"muscle": "Legs", "elite_bw_ratio": 1.90, "is_compound": True, "icon": "🦵"},
    "Bench Press": {"muscle": "Chest", "elite_bw_ratio": 1.75, "is_compound": True, "icon": "🛡️"},
    "Deadlift": {"muscle": "Back", "elite_bw_ratio": 2.75, "is_compound": True, "icon": "⛓️"},
    "Overhead Press": {"muscle": "Shoulders", "elite_bw_ratio": 1.15, "is_compound": True, "icon": "🏋️"},
    "Bench Press Close Grip": {"muscle": "Arms", "elite_bw_ratio": 1.55, "is_compound": True, "icon": "💪"},
    "Romanian Deadlift, Barbell": {"muscle": "Legs", "elite_bw_ratio": 2.0, "is_compound": True, "icon": "🦵"},
    "Bent Over Row": {"muscle": "Back", "elite_bw_ratio": 1.45, "is_compound": True, "icon": "🚣"},
    "Pendlay Row": {"muscle": "Back", "elite_bw_ratio": 1.45, "is_compound": True, "icon": "🚣"},
    "Shrug, Barbell": {"muscle": "Back", "elite_bw_ratio": 1.85, "is_compound": False, "icon": "⛰️"},
    "Bicep Curl, Barbell": {"muscle": "Arms", "elite_bw_ratio": 0.78, "is_compound": False, "icon": "💪"},
    "Reverse Curl": {"muscle": "Arms", "elite_bw_ratio": 0.65, "is_compound": False, "icon": "💪"},
    "Reverse Curl, Barbell": {"muscle": "Arms", "elite_bw_ratio": 0.65, "is_compound": False, "icon": "💪"},
    "Triceps Extension, Barbell": {"muscle": "Arms", "elite_bw_ratio": 0.75, "is_compound": False, "icon": "💪"},
    "Upright Row, Barbell": {"muscle": "Shoulders", "elite_bw_ratio": 0.85, "is_compound": False, "icon": "🔺"},
    "Skullcrusher, Barbell": {"muscle": "Arms", "elite_bw_ratio": 0.75, "is_compound": False, "icon": "💀"},
    "Good Morning": {"muscle": "Back", "elite_bw_ratio": 1.25, "is_compound": False, "icon": "🌅"},
    "Glute Bridge, Barbell": {"muscle": "Legs", "elite_bw_ratio": 1.80, "is_compound": False, "icon": "🍑"},
    "Reverse Lunge, Barbell": {"muscle": "Legs", "elite_bw_ratio": 1.35, "is_compound": False, "icon": "🦵"},
    "Chin Up": {"muscle": "Back", "elite_bw_ratio": 1.55, "is_compound": True, "is_bw": True, "bw_mult": 1.0, "icon": "🧗"},
    "Pull Up": {"muscle": "Back", "elite_bw_ratio": 1.55, "is_compound": True, "is_bw": True, "bw_mult": 1.0, "icon": "🧗"},
    "Push Up": {"muscle": "Chest", "elite_bw_ratio": 1.35, "is_compound": False, "is_bw": True, "bw_mult": 0.65, "icon": "🫸"},
    "Bench Dip": {"muscle": "Arms", "elite_bw_ratio": 1.25, "is_compound": False, "is_bw": True, "bw_mult": 0.55, "icon": "📐"},
    "Standing Calf Raise, Bodyweight": {"muscle": "Legs", "elite_bw_ratio": 1.45, "is_compound": False, "is_bw": True, "bw_mult": 0.55, "icon": "🦶"},
    "Bulgarian Split Squat, Bodyweight": {"muscle": "Legs", "elite_bw_ratio": 1.30, "is_compound": False, "is_bw": True, "bw_mult": 0.65, "icon": "🦵"},
}


def encrypt_api_key(raw_key: str) -> str:
    aesgcm = AESGCM(SECRET_KEY)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, raw_key.encode("utf-8"), None)
    return base64.b64encode(nonce + ct).decode("utf-8")


def decrypt_api_key(enc_key: str) -> str:
    try:
        data = base64.b64decode((enc_key or "").encode("utf-8"), validate=True)
    except ValueError:
        data = b""
    nonce, ct = data[:12], data[12:]
    if len(nonce) == 12 and ct:
        for key in (SECRET_KEY, LEGACY_SECRET_KEY):
            try:
                return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8")
            except InvalidTag:
                continue
    raise ValueError("Stored API key could not be decrypted. Please paste your lftsk_ key again.")


def mask_api_key(raw_key: str) -> str:
    if not raw_key or len(raw_key) < 12:
        return "lftsk_****"
    return f"{raw_key[:9]}••••••••{raw_key[-4:]}"


def get_rank_info(score: float) -> dict:
    score = max(0.0, min(1000.0, float(score)))
    chosen = RANK_TIERS[0]
    tier_idx = 0
    for idx, t in enumerate(RANK_TIERS):
        if score >= t["min"]:
            chosen = t
            tier_idx = idx
        else:
            break

    # The index is capped at 1000, so the open-ended top tier effectively ends there
    tier_max = min(chosen["max"], 1000.0)
    span = tier_max - chosen["min"]
    progress_in_tier = score - chosen["min"]

    # Sub-divisions III -> II -> I, each with 0-100 LP!
    if chosen["id"] in ("hatchling", "meteor"):
        division = "I"
        lp = int(min(99, round((progress_in_tier / max(1, span)) * 100)))
        if chosen["id"] == "meteor":
            points_to_next = 0
            next_label = "MAX RANK"
        else:
            points_to_next = max(0.5, round(tier_max - score, 1))
            next_label = f"{RANK_TIERS[tier_idx + 1]['name']} III"
    else:
        div_span = span / 3.0
        div_index = min(2, int(progress_in_tier // div_span))  # 0->III, 1->II, 2->I
        divisions = ["III", "II", "I"]
        division = divisions[div_index]
        sub_prog = progress_in_tier - (div_index * div_span)
        lp = int(min(99, round((sub_prog / div_span) * 100)))
        next_div_threshold = chosen["min"] + ((div_index + 1) * div_span)
        points_to_next = max(0.5, round(next_div_threshold - score, 1))
        if div_index < 2:
            next_label = f"{chosen['name']} {divisions[div_index + 1]}"
        else:
            nxt = RANK_TIERS[min(len(RANK_TIERS) - 1, tier_idx + 1)]
            next_label = nxt["name"] if nxt["id"] == "meteor" else f"{nxt['name']} III"

    return {
        "tierId": chosen["id"],
        "tierName": chosen["name"],
        "division": division,
        "fullTitle": f"{chosen['name']} {division}" if chosen["id"] not in ("hatchling", "meteor") else chosen["name"],
        "lp": lp,
        "score": round(score, 1),
        "color": chosen["color"],
        "glow": chosen["glow"],
        "icon": chosen["icon"],
        "desc": chosen["desc"],
        "nextRankLabel": next_label,
        "scoreNeededForNext": points_to_next,
        "tierIndex": tier_idx,
    }


def canonical_exercise_name(ex_name: str) -> str:
    """Liftosaur may append the default equipment (e.g. "Bench Press, Barbell"); fold that
    back onto the canonical name so Big 4 lookups and reference standards still match."""
    name = (ex_name or "").strip()
    if name in EXERCISE_META:
        return name
    base, sep, equipment = name.rpartition(", ")
    if sep and equipment.lower() == "barbell" and base in EXERCISE_META:
        return base
    return name


def classify_exercise(ex_name: str) -> dict:
    if ex_name in EXERCISE_META:
        return EXERCISE_META[ex_name]
    canonical = canonical_exercise_name(ex_name)
    if canonical in EXERCISE_META:
        return EXERCISE_META[canonical]
    lower = ex_name.lower()
    # Order matters: the more specific patterns ("leg curl", "tricep extension", "lateral raise")
    # must win over the generic keywords they contain.
    if any(k in lower for k in ["leg curl", "leg extension", "hamstring", "calf", "squat", "lunge", "leg press", "hip thrust", "step up"]):
        return {"muscle": "Legs", "elite_bw_ratio": 1.8, "is_compound": "squat" in lower or "leg press" in lower, "icon": "🦵"}
    if any(k in lower for k in ["curl", "tricep", "skull", "dip", "extension", "kickback"]):
        return {"muscle": "Arms", "elite_bw_ratio": 0.75, "is_compound": False, "icon": "💪"}
    if any(k in lower for k in ["overhead", "military", "shoulder", "lateral", "upright", "face pull", "rear delt", "arnold", "push press"]):
        return {"muscle": "Shoulders", "elite_bw_ratio": 1.05, "is_compound": "press" in lower, "icon": "🏋️"}
    if any(k in lower for k in ["bench", "chest", "fly", "push", "pec"]):
        return {"muscle": "Chest", "elite_bw_ratio": 1.5, "is_compound": "bench" in lower, "icon": "🛡️"}
    if any(k in lower for k in ["deadlift", "row", "chin", "pull", "lat ", "lat pulldown", "good morning", "shrug"]):
        return {"muscle": "Back", "elite_bw_ratio": 1.8, "is_compound": True, "icon": "⛓️"}
    if "press" in lower:
        return {"muscle": "Shoulders", "elite_bw_ratio": 1.05, "is_compound": True, "icon": "🏋️"}
    return {"muscle": "Core", "elite_bw_ratio": 1.0, "is_compound": False, "icon": "🧱"}


def calculate_e1rm(weight: float, reps: int, is_bw: bool = False, bw_mult: float = 0.65, bodyweight: float = 197.0) -> float:
    if reps <= 0:
        return 0.0
    if is_bw:
        # Sometimes Liftosaur logs full bodyweight (e.g. 215lb) for bodyweight movements, or 0lb, or added weight (35lb)
        if weight >= bodyweight * 0.8:
            effective_weight = weight * bw_mult
        else:
            effective_weight = (bodyweight * bw_mult) + weight
    else:
        effective_weight = weight
    if effective_weight <= 0:
        return 0.0
    if reps == 1:
        return round(effective_weight, 1)
    capped_reps = min(reps, 15)
    return round(effective_weight * (1.0 + capped_reps / 30.0), 1)


def format_set(weight: float, reps: int, is_bw: bool = False) -> str:
    if is_bw:
        return f"BW × {reps}" if weight <= 0 else f"BW+{weight:g}lb × {reps}"
    return f"{weight:g}lb × {reps}"


def calculate_dots(total_kg: float, bodyweight_kg: float, sex: str = "M") -> float:
    """Official DOTS coefficients; bodyweight is clamped to the formula's valid range per sex."""
    if str(sex).upper() == "F":
        bw = min(150.0, max(40.0, bodyweight_kg))
        a, b, c, d, e = -0.0000010706, 0.0005158568, -0.1126655495, 13.6175032, -57.96288
    else:
        bw = min(210.0, max(40.0, bodyweight_kg))
        a, b, c, d, e = -0.000001093, 0.0007391293, -0.1918759221, 24.0900756, -307.75076
    denom = a * bw ** 4 + b * bw ** 3 + c * bw ** 2 + d * bw + e
    return round((500.0 / denom) * total_kg, 1) if denom > 0 else 0.0


def target_e1rm_for_score(ex_name: str, score: float, bodyweight: float, sex: str = "M") -> float:
    """Inverse of calculate_exercise_score (ignoring its clamps)."""
    elite_ratio = classify_exercise(ex_name)["elite_bw_ratio"] * (0.68 if str(sex).upper() == "F" else 1.0)
    allometric_bw = (bodyweight ** 0.82) * (195.0 ** 0.18)
    return (score / 840.0) * elite_ratio * allometric_bw


def _absolute_liftosaur_url(path):
    if not path or not isinstance(path, str):
        return None
    if path.startswith(("http://", "https://")):
        return path
    return f"https://www.liftosaur.com{path if path.startswith('/') else '/' + path}"


def calculate_exercise_score(ex_name: str, e1rm: float, bodyweight: float, sex: str = "M") -> float:
    if e1rm <= 0 or bodyweight <= 0:
        return 0.0
    meta = classify_exercise(ex_name)
    elite_ratio = meta["elite_bw_ratio"]
    if sex.upper() == "F":
        elite_ratio *= 0.68
    # DOTS-inspired allometric scaling factor so heavier lifters aren't overly penalized and lighter lifters get fair curve
    allometric_bw = bodyweight ** 0.82 * (195.0 ** 0.18)
    ratio = e1rm / allometric_bw
    # Score of 840 corresponds to achieving the elite_ratio (T-Rex Tier entry)
    raw_score = (ratio / elite_ratio) * 840.0
    return round(min(1000.0, max(10.0, raw_score)), 1)


# Header dates come as "2026-10-16 07:59:43 +00:00" or ISO 8601 "2026-02-28T10:45:30Z"
HEADER_DATE_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?"
)

# Completed set notation: "3x8 185lb", "1x5+ 185lb @9", "3x8|7 0lb", "1x1 0kg 52s"
SET_RE = re.compile(r"^(\d+)x(\d+)\+?(?:\|(\d+))?(?:\s+(-?\d+(?:\.\d+)?)\s*(lb|kg))?", re.IGNORECASE)


def parse_header_date(header: str) -> str | None:
    """Returns the workout start as a naive UTC 'YYYY-MM-DD HH:MM:SS' string."""
    m = HEADER_DATE_RE.search(header)
    if not m:
        return None
    day, clock, tz = m.groups()
    if len(clock) == 5:
        clock += ":00"
    try:
        dt = datetime.strptime(f"{day} {clock}", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:4]))
        dt -= sign * offset
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def utcnow_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_history_record(record: dict, bodyweight: float = 197.0) -> dict | None:
    text = record.get("text", "")
    rec_id = record.get("id")
    if not text or "exercises: {" not in text:
        return None

    # Extract header fields
    # Example: 2026-10-16 07:59:43 +00:00 / program: "5/3/1 BBB - Squat/Bench/Deadlift/OHP" / dayName: "Week 2 - Day 2" / week: 2 / dayInWeek: 2 / duration: 4633s / exercises: {
    header_part, exercises_part = text.split("exercises: {", 1)
    exercises_part = exercises_part.rsplit("}", 1)[0]
    # Workout notes ("// ...") may precede the header line
    header_part = "\n".join(l for l in header_part.splitlines() if not l.strip().startswith("//"))

    workout_date = parse_header_date(header_part)
    if not workout_date:
        # Undated records can't be placed on the timeline (cadence, weekly volume), so skip them
        return None

    prog_match = re.search(r'program:\s*"([^"]+)"', header_part)
    program_name = prog_match.group(1) if prog_match else "Custom Workout"

    day_match = re.search(r'dayName:\s*"([^"]+)"', header_part)
    day_name = day_match.group(1) if day_match else "Training Session"

    dur_match = re.search(r'duration:\s*(\d+)s', header_part)
    duration_sec = int(dur_match.group(1)) if dur_match else 2700
    # Cap unrealistic background timers (e.g., 86000s when app left open)
    if duration_sec > 10800:
        duration_sec = 3600

    parsed_exercises = []
    total_volume = 0.0
    total_sets = 0
    total_reps = 0

    for line in exercises_part.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        # Format: Exercise Name / working sets / warmup: ... / target: ...
        parts = [p.strip() for p in line.split(" / ")]
        if len(parts) < 2:
            continue
        ex_name = canonical_exercise_name(parts[0])
        working_sets_str = parts[1].strip()
        if working_sets_str.startswith(("warmup:", "target:")):
            # No completed working sets for this exercise
            continue
        meta = classify_exercise(ex_name)
        is_bw = meta.get("is_bw", False)
        bw_mult = meta.get("bw_mult", 0.65)

        sets_list = []
        best_e1rm = 0.0
        ex_volume = 0.0

        # Parse sets like "1x3 180lb, 1x5+ 230lb @9, 3x8|7 0lb, 4x10 130lb"
        for set_chunk in working_sets_str.split(","):
            set_chunk = set_chunk.strip()
            m = SET_RE.match(set_chunk)
            if m:
                num_sets = int(m.group(1))
                reps = int(m.group(2))
                if m.group(3) is not None:
                    # Unilateral "8|7": the weaker side is what the load was actually moved for
                    reps = min(reps, int(m.group(3)))
                weight = max(0.0, float(m.group(4))) if m.group(4) else 0.0
                unit = (m.group(5) or "lb").lower()
                if unit == "kg":
                    weight = round(weight * 2.20462, 1)

                if reps <= 0 or num_sets <= 0:
                    continue

                e1rm = calculate_e1rm(weight, reps, is_bw=is_bw, bw_mult=bw_mult, bodyweight=bodyweight)
                # Safeguard against accidental typo exercises (e.g., 215lb reverse curl on a light pump day)
                if "reverse curl" in ex_name.lower() and weight > 135:
                    weight = 45.0
                    e1rm = calculate_e1rm(weight, reps, is_bw=is_bw, bw_mult=bw_mult, bodyweight=bodyweight)

                if e1rm > best_e1rm:
                    best_e1rm = e1rm

                effective_vol_weight = weight if weight > 0 else (bodyweight * 0.5 if is_bw else 0)
                vol = num_sets * reps * effective_vol_weight
                ex_volume += vol
                total_volume += vol
                total_sets += num_sets
                total_reps += (num_sets * reps)

                sets_list.append({
                    "sets": num_sets,
                    "reps": reps,
                    "weight": weight,
                    "e1rm": e1rm
                })

        if sets_list:
            parsed_exercises.append({
                "name": ex_name,
                "muscle": meta["muscle"],
                "icon": meta["icon"],
                "sets": sets_list,
                "best_e1rm": best_e1rm,
                "volume": round(ex_volume, 1)
            })

    if not parsed_exercises:
        return None

    return {
        "id": rec_id,
        "date": workout_date,
        "program": program_name,
        "dayName": day_name,
        "durationSec": duration_sec,
        "totalVolume": round(total_volume, 1),
        "totalSets": total_sets,
        "totalReps": total_reps,
        "exercises": parsed_exercises
    }


def _response_data(resp) -> dict:
    """Liftosaur wraps payloads as {"data": {...}}; tolerate null or non-JSON bodies."""
    try:
        body = resp.json()
    except ValueError:
        return {}
    data = body.get("data") if isinstance(body, dict) else None
    return data if isinstance(data, dict) else {}


def _weight_to_lb(raw) -> tuple[str, float]:
    """Accepts "197lb", "89.5 kg", 197, or {"value": 89.5, "unit": "kg"}; returns (display, pounds)."""
    if isinstance(raw, dict):
        raw = f"{raw.get('value', '')}{raw.get('unit', '')}"
    text = str(raw if raw is not None else "")
    num_match = re.search(r"-?\d+(?:\.\d+)?", text)
    num_val = float(num_match.group(0)) if num_match else 0.0
    if "kg" in text.lower():
        num_val = round(num_val * 2.20462, 1)
    return text, num_val


def fetch_liftosaur_profile(api_key: str, callsign: str = "Apex Lifter", sex: str = "M") -> dict:
    headers = {"Authorization": f"Bearer {api_key.strip()}"}
    sex = "F" if str(sex).upper() == "F" else "M"

    # 1. Fetch Measurements
    meas_resp = requests.get(f"{LIFTOSAUR_BASE}/measurements", headers=headers, timeout=12)
    if meas_resp.status_code == 401 or meas_resp.status_code == 403:
        raise ValueError("Invalid Liftosaur API Key (`lftsk_...`). Please check your key in Liftosaur -> Me -> API Keys.")
    meas_resp.raise_for_status()
    meas_data = _response_data(meas_resp).get("measurements") or []

    bodyweight = 195.0
    health_metrics = {}
    for m in meas_data:
        if not isinstance(m, dict):
            continue
        key = m.get("key")
        latest = m.get("latest") or {}
        if key == "weight":
            val_str, num_val = _weight_to_lb(latest.get("value"))
            if num_val > 0:
                bodyweight = num_val
        else:
            raw_val = latest.get("value")
            if isinstance(raw_val, dict):
                raw_val = f"{raw_val.get('value', '')}{raw_val.get('unit', '')}"
            val_str = str(raw_val if raw_val is not None else "")
            num_match = re.search(r"\d+(?:\.\d+)?", val_str)
            num_val = float(num_match.group(0)) if num_match else 0.0
        health_metrics[key] = {
            "value": val_str,
            "numeric": num_val,
            "date": latest.get("date"),
            "count": m.get("count", 0)
        }

    # 2. Fetch Workout History (up to 60 records)
    hist_resp = requests.get(f"{LIFTOSAUR_BASE}/history?limit=60", headers=headers, timeout=12)
    hist_resp.raise_for_status()
    raw_records = [r for r in (_response_data(hist_resp).get("records") or []) if isinstance(r, dict)]

    # 3. Fetch Next Scheduled Workout
    next_workout = None
    try:
        next_resp = requests.get(f"{LIFTOSAUR_BASE}/workout/next", headers=headers, timeout=10)
        if next_resp.status_code == 200:
            next_workout = _response_data(next_resp).get("workout")
    except Exception:
        pass

    # 4. Fetch Programs list
    programs = []
    try:
        prog_resp = requests.get(f"{LIFTOSAUR_BASE}/programs", headers=headers, timeout=10)
        if prog_resp.status_code == 200:
            programs = [p for p in (_response_data(prog_resp).get("programs") or []) if isinstance(p, dict)]
    except Exception:
        pass

    # Process History chronologically (oldest first) so we can track PR progressions and LP gains!
    workouts = []
    for r in raw_records:
        parsed = parse_history_record(r, bodyweight=bodyweight)
        if parsed:
            workouts.append(parsed)
    workouts.sort(key=lambda w: w["date"])

    # Track Exercise Records & PR History
    exercise_records = {}  # ex_name -> {best_e1rm, best_weight, best_reps, score, rank, history: [], total_volume, sessions}
    for w in workouts:
        w_lp_gained = 0
        w_prs = []
        for ex in w["exercises"]:
            ename = ex["name"]
            e1rm = ex["best_e1rm"]
            if ename not in exercise_records:
                exercise_records[ename] = {
                    "name": ename,
                    "muscle": ex["muscle"],
                    "icon": ex["icon"],
                    "best_e1rm": 0.0,
                    "best_set_str": "",
                    "total_volume": 0.0,
                    "sessions": 0,
                    "history": []
                }
            rec = exercise_records[ename]
            rec["total_volume"] = round(rec["total_volume"] + ex["volume"], 1)
            rec["sessions"] += 1
            rec["history"].append({"date": w["date"][:10], "e1rm": e1rm, "volume": ex["volume"]})

            if e1rm > rec["best_e1rm"]:
                prev = rec["best_e1rm"]
                rec["best_e1rm"] = e1rm
                # Find the best set string
                best_s = max(ex["sets"], key=lambda s: s["e1rm"])
                rec["best_set_str"] = format_set(best_s["weight"], best_s["reps"], is_bw=classify_exercise(ename).get("is_bw", False))
                if prev > 0:
                    w_prs.append({"exercise": ename, "old_e1rm": prev, "new_e1rm": e1rm})
                    w_lp_gained += 18
                else:
                    w_lp_gained += 10
            else:
                w_lp_gained += 4

        w["prsHit"] = w_prs
        w["lpEarned"] = min(45, max(8, w_lp_gained))

    # Reverse workouts back to newest-first for UI display
    workouts.reverse()

    # Compute Exercise Ranks
    ranked_exercises = []
    for ename, rec in exercise_records.items():
        if rec["best_e1rm"] <= 0:
            continue
        score = calculate_exercise_score(ename, rec["best_e1rm"], bodyweight, sex=sex)
        rank_info = get_rank_info(score)
        # Calculate what weight x reps is needed for the next rank division!
        target_score = score + rank_info["scoreNeededForNext"]
        target_e1rm = round(target_e1rm_for_score(ename, target_score, bodyweight, sex), 1)
        meta = classify_exercise(ename)
        is_bw = meta.get("is_bw", False)
        # Bodyweight movements count bodyweight * bw_mult toward the e1RM, so targets are *added* load
        bw_load = bodyweight * meta.get("bw_mult", 0.65) if is_bw else 0.0
        target_5rm_weight = max(0, int(math.ceil((target_e1rm / (1.0 + 5.0 / 30.0) - bw_load) / 5.0) * 5))
        target_3rm_weight = max(0, int(math.ceil((target_e1rm / (1.0 + 3.0 / 30.0) - bw_load) / 5.0) * 5))

        ranked_exercises.append({
            **rec,
            "score": score,
            "rank": rank_info,
            "nextTarget": {
                "targetE1rm": target_e1rm,
                "plusE1rm": round(max(2.5, target_e1rm - rec["best_e1rm"]), 1),
                "rep5Weight": target_5rm_weight,
                "rep3Weight": target_3rm_weight,
                "nextRankLabel": rank_info["nextRankLabel"],
                "isBw": is_bw
            }
        })

    # Sort exercises by Big 4 first, then by score descending
    big_four_order = {"Squat": 0, "Bench Press": 1, "Deadlift": 2, "Overhead Press": 3}
    ranked_exercises.sort(key=lambda x: (big_four_order.get(x["name"], 99), -x["score"]))

    # Compute 6-Axis Muscle Radar Scores (Chest, Back, Legs, Shoulders, Arms, Core/Consistency)
    muscle_groups = ["Chest", "Back", "Legs", "Shoulders", "Arms"]
    muscle_scores = {}
    for mg in muscle_groups:
        mg_ex = [x["score"] for x in ranked_exercises if x["muscle"] == mg]
        if mg_ex:
            # Top exercise in that muscle group + small bonus for depth
            top_s = max(mg_ex)
            avg_s = sum(mg_ex) / len(mg_ex)
            muscle_scores[mg] = round(min(1000.0, top_s * 0.8 + avg_s * 0.2), 1)
        else:
            muscle_scores[mg] = 150.0

    # Consistency / Discipline Axis based on workouts in last 14 days
    now = utcnow_naive()
    recent_cutoff = now - timedelta(days=14)
    weekly_cutoff = now - timedelta(days=7)
    recent_workouts = 0
    weekly_volume = 0.0
    lp_gained_week = 0
    for w in workouts:
        try:
            dt = datetime.strptime(w["date"][:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if dt >= recent_cutoff:
            recent_workouts += 1
        if dt >= weekly_cutoff:
            weekly_volume += w["totalVolume"]
            lp_gained_week += w["lpEarned"]

    consistency_score = min(980.0, max(250.0, recent_workouts * 115.0))
    muscle_scores["Discipline"] = round(consistency_score, 1)

    # Overall Score = Weighted Big 4 Compound Score (85%) + Consistency/Accessory Bonus (15%)
    big4_scores = [x["score"] for x in ranked_exercises if x["name"] in big_four_order]
    if big4_scores:
        core_avg = sum(big4_scores) / len(big4_scores)
    elif ranked_exercises:
        core_avg = sum(x["score"] for x in ranked_exercises[:4]) / min(4, len(ranked_exercises))
    else:
        core_avg = 100.0

    overall_score = round(core_avg * 0.88 + (consistency_score * 0.12), 1)
    overall_rank = get_rank_info(overall_score)

    # Compute SBD (Squat + Bench + Deadlift) Total & DOTS Score
    squat_1rm = next((x["best_e1rm"] for x in ranked_exercises if x["name"] == "Squat"), 0.0)
    bench_1rm = next((x["best_e1rm"] for x in ranked_exercises if x["name"] == "Bench Press"), 0.0)
    dead_1rm = next((x["best_e1rm"] for x in ranked_exercises if x["name"] == "Deadlift"), 0.0)
    ohp_1rm = next((x["best_e1rm"] for x in ranked_exercises if x["name"] == "Overhead Press"), 0.0)
    sbd_total = round(squat_1rm + bench_1rm + dead_1rm, 1)

    # Official DOTS calculation (convert lb to kg)
    bw_kg = max(40.0, bodyweight / 2.20462)
    sbd_kg = sbd_total / 2.20462
    dots_score = calculate_dots(sbd_kg, bw_kg, sex)

    # Next Workout Preview + Promotion Targets!
    next_workout_summary = None
    if next_workout:
        entries_summary = []
        for entry in next_workout.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            ename = entry.get("name")
            sets_info = []
            top_planned_e1rm = 0.0
            top_weight = 0.0
            has_amrap = False
            amrap_weight = 0.0

            ename = canonical_exercise_name(ename or "")
            meta = classify_exercise(ename)
            is_bw = meta.get("is_bw", False)
            bw_mult = meta.get("bw_mult", 0.65)
            for s in entry.get("sets") or []:
                if not isinstance(s, dict):
                    continue
                w_str, w_val = _weight_to_lb(s.get("weight", "0lb"))
                w_val = max(0.0, w_val)
                try:
                    reps_val = int(s.get("reps") or 0)
                except (TypeError, ValueError):
                    reps_val = 0
                is_amrap = bool(s.get("isAmrap"))
                e1rm_est = calculate_e1rm(w_val, reps_val, is_bw=is_bw, bw_mult=bw_mult, bodyweight=bodyweight)
                if e1rm_est > top_planned_e1rm:
                    top_planned_e1rm = e1rm_est
                    top_weight = w_val
                if is_amrap:
                    has_amrap = True
                    amrap_weight = w_val
                sets_info.append({
                    "reps": reps_val,
                    "weight": w_str,
                    "weightVal": w_val,
                    "isAmrap": is_amrap,
                    "timer": s.get("timer", 120)
                })

            # Check how many reps on the AMRAP or top set are needed to beat their current PR or rank up!
            existing_ex = next((x for x in ranked_exercises if x["name"] == ename), None)
            pr_challenge = None
            ref_w = amrap_weight if amrap_weight > 0 else top_weight
            if existing_ex and (ref_w > 0 or is_bw):
                cur_best = existing_ex["best_e1rm"]
                # Smallest rep count at this load whose e1RM beats the PR (same formula used for the PR itself;
                # e1RM stops growing past the 15-rep cap, so anything beyond is unreachable)
                reps_for_pr = next(
                    (r for r in range(1, 16)
                     if calculate_e1rm(ref_w, r, is_bw=is_bw, bw_mult=bw_mult, bodyweight=bodyweight) > cur_best),
                    None,
                )
                if reps_for_pr is not None:
                    new_e1rm_if_hit = calculate_e1rm(ref_w, reps_for_pr, is_bw=is_bw, bw_mult=bw_mult, bodyweight=bodyweight)
                    new_score_if_hit = calculate_exercise_score(ename, new_e1rm_if_hit, bodyweight, sex=sex)
                    pr_challenge = {
                        "weight": ref_w,
                        "repsNeededForPR": reps_for_pr,
                        "currentBestE1rm": cur_best,
                        "projectedE1rm": new_e1rm_if_hit,
                        "projectedScore": new_score_if_hit,
                        "lpBonus": 25
                    }

            entries_summary.append({
                "name": ename,
                "description": entry.get("description") or "",
                "imageUrl": _absolute_liftosaur_url(entry.get("imageUrl")),
                "setsCount": len(sets_info),
                "sets": sets_info,
                "prChallenge": pr_challenge
            })

        next_workout_summary = {
            "programName": next_workout.get("programName"),
            "dayName": next_workout.get("dayName"),
            "week": (next_workout.get("dayData") or {}).get("week"),
            "dayInWeek": (next_workout.get("dayData") or {}).get("dayInWeek"),
            "entries": entries_summary
        }

    # Next-tier benchmarks: Big 4 e1RMs needed to enter the tier above the current overall rank
    next_tier = RANK_TIERS[min(len(RANK_TIERS) - 1, overall_rank["tierIndex"] + 1)]
    tier_targets = {
        "tierName": next_tier["name"],
        "tierIcon": next_tier["icon"],
        "tierColor": next_tier["color"],
        "tierMin": next_tier["min"],
        "lifts": [
            {
                "name": lift,
                "current": cur,
                "target": round(target_e1rm_for_score(lift, next_tier["min"], bodyweight, sex), 1),
            }
            for lift, cur in (("Squat", squat_1rm), ("Bench Press", bench_1rm), ("Deadlift", dead_1rm), ("Overhead Press", ohp_1rm))
        ],
    }

    # Build Solo Quests & Bounties dynamically from real data
    total_lifetime_volume = round(sum(w["totalVolume"] for w in workouts), 1)
    quests = [
        {
            "id": "q_weekly_vol",
            "title": "Weekly Volume Standard",
            "desc": "Accumulate 25,000 lbs of working volume across logged sessions (7-day rolling).",
            "current": round(weekly_volume),
            "target": 25000,
            "rewardLp": 35,
            "rewardFossils": 150,
            "completed": weekly_volume >= 25000,
            "icon": "01"
        },
        {
            "id": "q_consistency",
            "title": "Training Frequency Cadence",
            "desc": "Log at least 4 completed training sessions within a 14-day window.",
            "current": min(4, recent_workouts),
            "target": 4,
            "rewardLp": 30,
            "rewardFossils": 120,
            "completed": recent_workouts >= 4,
            "icon": "02"
        },
        {
            "id": "q_sbd_club",
            "title": "900 lb SBD Composite Milestone",
            "desc": f"Reach a combined Squat + Bench + Deadlift e1RM total of 900 lbs (Current: {int(sbd_total)} lbs).",
            "current": round(sbd_total),
            "target": 900,
            "rewardLp": 50,
            "rewardFossils": 300,
            "completed": sbd_total >= 900,
            "icon": "03"
        },
        {
            "id": "q_next_session",
            "title": f"Next Prescribed Session: {next_workout_summary['dayName'] if next_workout_summary else 'Scheduled Workout'}",
            "desc": f"Complete {next_workout_summary['entries'][0]['name'] if (next_workout_summary and next_workout_summary['entries']) else 'primary compound'} in Liftosaur and sync.",
            "current": 0,
            "target": 1,
            "rewardLp": 25,
            "rewardFossils": 100,
            "completed": False,
            "icon": "04"
        }
    ]

    return {
        "callsign": callsign,
        "sex": sex,
        "maskedKey": mask_api_key(api_key),
        "syncedAt": utcnow_naive().strftime("%Y-%m-%d %H:%M:%S UTC"),
        "bodyweight": bodyweight,
        "healthMetrics": health_metrics,
        "overallScore": overall_score,
        "overallRank": overall_rank,
        "sbdTotal": sbd_total,
        "bigFour": {
            "Squat": squat_1rm,
            "Bench Press": bench_1rm,
            "Deadlift": dead_1rm,
            "Overhead Press": ohp_1rm
        },
        "dotsScore": dots_score,
        "weeklyVolume": round(weekly_volume),
        "lifetimeVolume": total_lifetime_volume,
        "workoutsCount": len(workouts),
        "recentWorkouts14d": recent_workouts,
        "lpGainedWeek": lp_gained_week,
        "tierTargets": tier_targets,
        "fossilsCurrency": int(len(workouts) * 45 + sum(q["rewardFossils"] for q in quests if q["completed"])),
        "muscleRadar": muscle_scores,
        "exercises": ranked_exercises,
        "workouts": workouts[:25],
        "nextWorkout": next_workout_summary,
        "activeProgram": next(
            (p.get("name") for p in programs if p.get("isCurrent") and p.get("name")),
            (next_workout_summary or {}).get("programName") or "No active program",
        ),
        "programsCount": len(programs),
        "quests": quests,
        "allRankTiers": RANK_TIERS
    }
