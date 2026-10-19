import os
import json
import math
import time
import uuid
import sqlite3
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import engine

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "liftosauring.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DEFAULT_USER_KEY = os.environ.get("LIFTOSAUR_API_KEY", "").strip()
DEFAULT_CALLSIGN = os.environ.get("LIFTOSAUR_CALLSIGN", "Jonathan").strip() or "Jonathan"

PACK_OBJECTIVE_LBS = 150000
MAX_BODY_BYTES = 64 * 1024
MAX_CALLSIGN_LEN = 32


class BadRequest(Exception):
    pass


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def clean_callsign(raw, fallback: str = "") -> str:
    name = " ".join(str(raw or "").split())[:MAX_CALLSIGN_LEN]
    return name or fallback


def clean_sex(raw, fallback: str = "M") -> str:
    val = str(raw or "").strip().upper()
    return val if val in ("M", "F") else fallback


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            callsign TEXT NOT NULL,
            sex TEXT DEFAULT 'M',
            encrypted_key TEXT,
            masked_key TEXT,
            is_live_user INTEGER DEFAULT 0,
            avatar TEXT DEFAULT 'VI',
            profile_json TEXT,
            updated_at INTEGER
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS social_feed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            callsign TEXT,
            avatar TEXT,
            rank_title TEXT,
            rank_color TEXT,
            event_type TEXT,
            headline TEXT,
            detail TEXT,
            hype_count INTEGER DEFAULT 0,
            created_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS duels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            challenger_name TEXT,
            opponent_name TEXT,
            opponent_avatar TEXT,
            opponent_rank TEXT,
            metric_type TEXT,
            exercise_name TEXT,
            user_progress REAL,
            opponent_progress REAL,
            target_goal REAL,
            unit TEXT,
            status TEXT,
            expires_in TEXT
        )
    """)

    conn.commit()

    # Seed or refresh pack friends
    seed_pack_friends(conn)

    # Sync primary user from Liftosaur API if LIFTOSAUR_API_KEY env var is provided and not yet synced
    cur.execute("SELECT 1 FROM users WHERE id = 'user_primary'")
    existing_primary = cur.fetchone()
    if DEFAULT_USER_KEY and not existing_primary:
        try:
            print(f"[Liftosauring] Performing read-only sync with Liftosaur API ({engine.mask_api_key(DEFAULT_USER_KEY)})...")
            profile = engine.fetch_liftosaur_profile(DEFAULT_USER_KEY, callsign=DEFAULT_CALLSIGN, sex="M")
            save_primary_user(conn, DEFAULT_USER_KEY, DEFAULT_CALLSIGN, "M", profile)
            print(f"[Liftosauring] Sync complete. Rank: {profile['overallRank']['fullTitle']} ({profile['overallScore']})")
        except Exception as e:
            print(f"[Liftosauring] Warning during initial sync: {e}")

    conn.close()


def save_primary_user(conn, raw_key: str, callsign: str, sex: str, profile: dict):
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
        VALUES ('user_primary', ?, ?, ?, ?, 1, ?, ?, ?)
    """, (callsign, sex, engine.encrypt_api_key(raw_key), profile["maskedKey"], profile["overallRank"]["icon"], json.dumps(profile), int(time.time())))
    conn.commit()
    seed_feed_and_duels(conn, profile)


def seed_pack_friends(conn):
    cur = conn.cursor()
    friends = [
        {
            "id": "friend_1",
            "callsign": "Marcus V.",
            "sex": "M",
            "avatar": "VII",
            "masked_key": "lftsk_9Km••••••8xPq",
            "profile": {
                "callsign": "Marcus V.",
                "bodyweight": 212.0,
                "overallScore": 742.5,
                "overallRank": engine.get_rank_info(742.5),
                "sbdTotal": 1065.0,
                "dotsScore": 298.4,
                "weeklyVolume": 31450,
                "recentWorkouts14d": 8,
                "lpGainedWeek": 42,
                "bigFour": {"Squat": 405.0, "Bench Press": 285.0, "Deadlift": 375.0, "Overhead Press": 185.0},
                "activeProgram": "SBS Hypertrophy 4x",
                "liveStatus": "Last synced 2h ago • Week 4 Day 1"
            }
        },
        {
            "id": "friend_2",
            "callsign": "Sarah K.",
            "sex": "F",
            "avatar": "VI",
            "masked_key": "lftsk_3Tx••••••2vLm",
            "profile": {
                "callsign": "Sarah K.",
                "bodyweight": 138.0,
                "overallScore": 694.0,
                "overallRank": engine.get_rank_info(694.0),
                "sbdTotal": 655.0,
                "dotsScore": 318.2,
                "weeklyVolume": 22800,
                "recentWorkouts14d": 9,
                "lpGainedWeek": 68,
                "bigFour": {"Squat": 235.0, "Bench Press": 145.0, "Deadlift": 275.0, "Overhead Press": 105.0},
                "activeProgram": "GZCL: Jacked & Tan 2.0",
                "liveStatus": "Last synced 3h ago • Deadlift e1RM +10 lb"
            }
        },
        {
            "id": "friend_3",
            "callsign": "Devon R.",
            "sex": "M",
            "avatar": "VI",
            "masked_key": "lftsk_7Bp••••••4nQw",
            "profile": {
                "callsign": "Devon R.",
                "bodyweight": 185.0,
                "overallScore": 612.0,
                "overallRank": engine.get_rank_info(612.0),
                "sbdTotal": 860.0,
                "dotsScore": 266.8,
                "weeklyVolume": 24100,
                "recentWorkouts14d": 6,
                "lpGainedWeek": 35,
                "bigFour": {"Squat": 275.0, "Bench Press": 295.0, "Deadlift": 290.0, "Overhead Press": 170.0},
                "activeProgram": "5/3/1: Boring But Big",
                "liveStatus": "Last synced 1d ago • Week 2 Day 2"
            }
        },
        {
            "id": "friend_4",
            "callsign": "Kai T.",
            "sex": "M",
            "avatar": "IV",
            "masked_key": "lftsk_1Zc••••••9rTy",
            "profile": {
                "callsign": "Kai T.",
                "bodyweight": 168.0,
                "overallScore": 448.0,
                "overallRank": engine.get_rank_info(448.0),
                "sbdTotal": 645.0,
                "dotsScore": 212.5,
                "weeklyVolume": 19500,
                "recentWorkouts14d": 7,
                "lpGainedWeek": 84,
                "bigFour": {"Squat": 215.0, "Bench Press": 165.0, "Deadlift": 265.0, "Overhead Press": 115.0},
                "activeProgram": "Recommended Routine",
                "liveStatus": "Last synced 1d ago • 7 sessions in 14d"
            }
        }
    ]

    for f in friends:
        # Demo peers have no real key; encrypted_key stays NULL so they can never be "re-synced"
        cur.execute("""
            INSERT OR REPLACE INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
            VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?)
        """, (f["id"], f["callsign"], f["sex"], f["masked_key"], f["avatar"], json.dumps(f["profile"]), int(time.time())))
    conn.commit()


def seed_feed_and_duels(conn, user_profile: dict):
    cur = conn.cursor()
    latest_w = user_profile["workouts"][0] if user_profile.get("workouts") else None

    cur.execute("DELETE FROM social_feed")
    # Oldest first: the ledger is read newest-first (ORDER BY id DESC)
    feed_items = [
        ("friend_1", "Marcus V.", "VII", "Allosaurus III", "#38bdf8", "CHALLENGE",
         "Cleared 31,450 lbs weekly volume on SBS Hypertrophy",
         "Top set Squat 365 lb × 4 (405 lb e1RM). Currently leading the Pack weekly tonnage board.", 8, "2 days ago"),
        ("friend_4", "Kai T.", "IV", "Velociraptor II", "#d4d4d8", "RANK_UP",
         "Promoted to Velociraptor II (+84 LP this week)",
         "Completed 7 sessions in the last 14 days on Recommended Routine.", 11, "Yesterday"),
        ("friend_2", "Sarah K.", "VI", "Stegosaurus I", "#34d399", "PR_ALERT",
         "New Deadlift e1RM: 275 lb (245 lb × 4)",
         "Allometric DOTS rose to 318.2. Contributed 22,800 lbs toward the weekly Pack objective.", 19, "3 hours ago"),
    ]
    if latest_w:
        ex_summary = ", ".join(f"{e['name']} ({int(e['best_e1rm'])} lb e1RM)" for e in latest_w["exercises"][:2])
        feed_items.append((
            "user_primary",
            user_profile["callsign"],
            user_profile["overallRank"]["icon"],
            user_profile["overallRank"]["fullTitle"],
            user_profile["overallRank"]["color"],
            "WORKOUT_SYNC",
            f"Completed {latest_w['dayName']} • {latest_w['program']}",
            f"Logged {int(latest_w['totalVolume']):,} lbs across {latest_w['totalSets']} working sets. Primary work: {ex_summary}. (+{latest_w['lpEarned']} LP)",
            14,
            latest_w["date"][:16],
        ))
    for item in feed_items:
        cur.execute("""
            INSERT INTO social_feed (user_id, callsign, avatar, rank_title, rank_color, event_type, headline, detail, hype_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, item)

    cur.execute("DELETE FROM duels")
    big_four = user_profile.get("bigFour") or {}
    duels_seed = [
        (user_profile["callsign"], "Devon R.", "VI", "Stegosaurus III",
         "Bench Press e1RM Benchmark", "Bench Press", float(big_four.get("Bench Press") or 0), 295.0, 300.0, "lb e1RM", "ACTIVE", "4d 11h remaining"),
        (user_profile["callsign"], "Sarah K.", "VI", "Stegosaurus I",
         "7-Day Rolling Volume Comparison", "Total Weekly Volume", float(user_profile.get("weeklyVolume") or 0), 22800.0, 30000.0, "lbs", "ACTIVE", "2d 06h remaining"),
        (user_profile["callsign"], "Marcus V.", "VII", "Allosaurus III",
         "Squat e1RM Progression", "Squat", float(big_four.get("Squat") or 0), 405.0, 415.0, "lb e1RM", "ACTIVE", "5d 18h remaining")
    ]
    for d in duels_seed:
        cur.execute("""
            INSERT INTO duels (challenger_name, opponent_name, opponent_avatar, opponent_rank, metric_type, exercise_name, user_progress, opponent_progress, target_goal, unit, status, expires_in)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, d)

    conn.commit()


def build_pack_objective(pack_members: list, user_profile: dict) -> dict:
    """Weekly co-op tonnage objective, tallied live from every Pack member's 7-day volume."""
    contributions = []
    for m in pack_members:
        vol = int(m.get("weeklyVolume") or 0)
        if m["isMe"]:
            latest_w = (user_profile.get("workouts") or [None])[0]
            move = f"{latest_w['dayName']} ({int(latest_w['totalVolume']):,} lbs)" if latest_w else "Weekly synced sessions"
        else:
            move = m.get("activeProgram") or "Synced sessions"
        contributions.append({"attacker": m["callsign"], "move": move, "damage": vol, "isMe": m["isMe"]})
    contributions.sort(key=lambda c: c["damage"], reverse=True)

    total = sum(c["damage"] for c in contributions)
    return {
        "id": "pack_weekly",
        "name": "GIGANOTOSAURUS ALPHA",
        "subtitle": "Weekly co-op Pack objective • tallies synced Liftosaur volume across all Pack members",
        "maxHp": PACK_OBJECTIVE_LBS,
        "currentHp": max(0, PACK_OBJECTIVE_LBS - total),
        "totalVolume": total,
        "combatLog": contributions,
    }


def build_state_payload():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT * FROM users WHERE id = 'user_primary'")
    primary_row = cur.fetchone()
    user_profile = json.loads(primary_row["profile_json"]) if primary_row else {}

    cur.execute("SELECT * FROM users")
    all_users = cur.fetchall()
    pack_members = []
    for u in all_users:
        try:
            p = json.loads(u["profile_json"] or "{}")
        except ValueError:
            continue
        is_me = (u["id"] == "user_primary")
        if "lpGainedWeek" in p:
            lp_week = p["lpGainedWeek"]
        else:  # profiles synced before lpGainedWeek existed
            lp_week = sum(w.get("lpEarned", 12) for w in p.get("workouts", [])[:4])
        pack_members.append({
            "id": u["id"],
            "callsign": u["callsign"],
            "sex": u["sex"],
            "avatar": (p.get("overallRank") or {}).get("icon", "VI"),
            "maskedKey": u["masked_key"],
            "isMe": is_me,
            "bodyweight": p.get("bodyweight", 195),
            "overallScore": p.get("overallScore", 0),
            "overallRank": p.get("overallRank") or engine.get_rank_info(p.get("overallScore", 0)),
            "dotsScore": p.get("dotsScore", 0),
            "sbdTotal": p.get("sbdTotal", 0),
            "weeklyVolume": p.get("weeklyVolume", 0),
            "recentWorkouts14d": p.get("recentWorkouts14d", 0),
            "lpGainedWeek": lp_week,
            "bigFour": p.get("bigFour", {}),
            "activeProgram": p.get("activeProgram", "Custom"),
            "liveStatus": f"Synced from Liftosaur API • {p.get('workoutsCount', 0)} workouts" if is_me else p.get("liveStatus", "Synced")
        })

    cur.execute("SELECT * FROM social_feed ORDER BY id DESC LIMIT 15")
    feed = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT * FROM duels ORDER BY id ASC")
    duels = [dict(r) for r in cur.fetchall()]

    conn.close()
    return {
        "user": user_profile,
        "packMembers": pack_members,
        "raidBoss": build_pack_objective(pack_members, user_profile),
        "socialFeed": feed,
        "duels": duels,
        "rankTiers": engine.RANK_TIERS
    }


def parse_number(raw, default: float, lo: float, hi: float) -> float:
    try:
        val = float(raw if raw is not None else default)
    except (TypeError, ValueError):
        raise BadRequest(f"Expected a number, got {raw!r}.")
    if not math.isfinite(val):
        raise BadRequest("Numbers must be finite.")
    return min(hi, max(lo, val))


class LiftosauringHandler(SimpleHTTPRequestHandler):
    def send_json(self, data: dict, status: int = 200):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            raise BadRequest("Invalid Content-Length.")
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise BadRequest("Request body too large.")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BadRequest("Request body must be valid JSON.")
        if not isinstance(body, dict):
            raise BadRequest("Request body must be a JSON object.")
        return body

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            try:
                self.send_json({"ok": True, "data": build_state_payload()})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, status=500)
            return

        # Static files are served strictly from STATIC_DIR (see run_server); "/static/x" and "/x" both map to it
        path = parsed.path
        if path in ("/", "/index.html", "/static", "/static/"):
            path = "/index.html"
        elif path.startswith("/static/"):
            path = path[len("/static"):]
        self.path = path + (f"?{parsed.query}" if parsed.query else "")
        return super().do_GET()

    def do_POST(self):
        try:
            self.route_post()
        except BadRequest as e:
            self.send_json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            self.send_json({"ok": False, "error": f"Internal error: {e}"}, 500)

    def route_post(self):
        parsed = urlparse(self.path)
        body = self.read_json_body()

        # 1. Connect or Re-Sync the primary Liftosaur API Key (Read-Only from Liftosaur)
        if parsed.path == "/api/sync":
            raw_key = str(body.get("apiKey") or "").strip()
            conn = get_db()
            try:
                cur = conn.cursor()
                cur.execute("SELECT encrypted_key, callsign, sex FROM users WHERE id = 'user_primary'")
                row = cur.fetchone()
                callsign = clean_callsign(body.get("callsign"), row["callsign"] if row else DEFAULT_CALLSIGN)
                sex = clean_sex(body.get("sex"), row["sex"] if row else "M")

                if not raw_key:
                    if not row or not row["encrypted_key"]:
                        return self.send_json({"ok": False, "error": "No API key stored yet. Paste your lftsk_ key to connect."}, 400)
                    try:
                        raw_key = engine.decrypt_api_key(row["encrypted_key"])
                    except ValueError as e:
                        return self.send_json({"ok": False, "error": str(e)}, 400)

                if not raw_key.startswith("lftsk_"):
                    return self.send_json({"ok": False, "error": "Liftosaur API keys must begin with 'lftsk_'."}, 400)

                try:
                    profile = engine.fetch_liftosaur_profile(raw_key, callsign=callsign, sex=sex)
                except Exception as e:
                    return self.send_json({"ok": False, "error": f"Liftosaur sync failed: {e}"}, 400)
                save_primary_user(conn, raw_key, callsign, sex, profile)
            finally:
                conn.close()
            return self.send_json({"ok": True, "message": f"Synced {profile['workoutsCount']} workouts from Liftosaur.", "data": build_state_payload()})

        # 2. Add a Friend to the Pack via their Liftosaur API Key
        if parsed.path == "/api/pack/add":
            friend_name = clean_callsign(body.get("callsign"))
            friend_sex = clean_sex(body.get("sex"))
            friend_key = str(body.get("apiKey") or "").strip()

            if not friend_name:
                return self.send_json({"ok": False, "error": "Callsign is required."}, 400)
            if not friend_key.startswith("lftsk_"):
                return self.send_json({"ok": False, "error": "A valid Liftosaur API key (lftsk_...) is required to sync a peer profile."}, 400)

            try:
                f_profile = engine.fetch_liftosaur_profile(friend_key, callsign=friend_name, sex=friend_sex)
            except Exception as e:
                return self.send_json({"ok": False, "error": f"Liftosaur sync failed: {e}"}, 400)
            f_profile["liveStatus"] = f"Synced from Liftosaur API • {f_profile['workoutsCount']} workouts"
            friend_id = f"friend_{uuid.uuid4().hex[:12]}"

            conn = get_db()
            try:
                cur = conn.cursor()
                cur.execute("""
                    INSERT INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
                    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                """, (friend_id, friend_name, friend_sex, engine.encrypt_api_key(friend_key), f_profile["maskedKey"],
                      f_profile["overallRank"]["icon"], json.dumps(f_profile), int(time.time())))
                cur.execute("""
                    INSERT INTO social_feed (user_id, callsign, avatar, rank_title, rank_color, event_type, headline, detail, hype_count, created_at)
                    VALUES (?, ?, ?, ?, ?, 'NEW_MEMBER', ?, ?, 1, 'Just now')
                """, (
                    friend_id, friend_name, f_profile["overallRank"]["icon"],
                    f_profile["overallRank"]["fullTitle"], f_profile["overallRank"]["color"],
                    f"{friend_name} connected their Liftosaur API key",
                    f"Placed at {f_profile['overallRank']['fullTitle']} ({int(f_profile['sbdTotal'])} lb SBD • {f_profile['dotsScore']} DOTS)."
                ))
                conn.commit()
            finally:
                conn.close()
            return self.send_json({"ok": True, "data": build_state_payload()})

        # 3. Acknowledge / Endorse a Feed Item
        if parsed.path == "/api/feed/hype":
            try:
                post_id = int(body.get("postId"))
            except (TypeError, ValueError):
                raise BadRequest("postId must be an integer.")
            conn = get_db()
            try:
                cur = conn.cursor()
                cur.execute("UPDATE social_feed SET hype_count = hype_count + 1 WHERE id = ?", (post_id,))
                conn.commit()
                found = cur.rowcount > 0
            finally:
                conn.close()
            if not found:
                return self.send_json({"ok": False, "error": "Post not found."}, 404)
            return self.send_json({"ok": True, "data": build_state_payload()})

        # 4. Read-Only Projection Calculator Endpoint
        if parsed.path == "/api/calculator":
            ex_name = str(body.get("exercise") or "Bench Press")[:80]
            weight = parse_number(body.get("weight"), 225, 0, 2000)
            reps = int(parse_number(body.get("reps"), 5, 1, 30))
            bw = parse_number(body.get("bodyweight"), 197, 60, 600)
            sex = clean_sex(body.get("sex"))
            meta = engine.classify_exercise(ex_name)
            e1rm = engine.calculate_e1rm(weight, reps, is_bw=meta.get("is_bw", False), bw_mult=meta.get("bw_mult", 0.65), bodyweight=bw)
            score = engine.calculate_exercise_score(ex_name, e1rm, bw, sex=sex)
            rank = engine.get_rank_info(score)
            return self.send_json({
                "ok": True,
                "result": {
                    "exercise": ex_name,
                    "weight": weight,
                    "reps": reps,
                    "bodyweight": bw,
                    "e1rm": e1rm,
                    "score": score,
                    "rank": rank
                }
            })

        self.send_json({"ok": False, "error": "Unknown endpoint"}, 404)


def run_server(port: int = 8080, host: str = "0.0.0.0"):
    init_db()
    handler = partial(LiftosauringHandler, directory=STATIC_DIR)
    server = ThreadingHTTPServer((host, port), handler)
    print(f"\n[Liftosauring] Server listening at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server(int(os.environ.get("PORT", "8080")), os.environ.get("HOST", "0.0.0.0"))
