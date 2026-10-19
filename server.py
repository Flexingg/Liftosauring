import os
import json
import time
import sqlite3
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import engine

DB_PATH = os.path.join(os.path.dirname(__file__), "liftosauring.db")
DEFAULT_USER_KEY = os.environ.get("LIFTOSAUR_API_KEY", "").strip()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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
        CREATE TABLE IF NOT EXISTS raid_boss (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            subtitle TEXT NOT NULL,
            max_hp INTEGER NOT NULL,
            current_hp INTEGER NOT NULL,
            level INTEGER DEFAULT 1,
            reward_fossils INTEGER DEFAULT 500,
            combat_log_json TEXT
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
    cur.execute("SELECT * FROM users WHERE id = 'user_primary'")
    existing_primary = cur.fetchone()
    if DEFAULT_USER_KEY and not existing_primary:
        try:
            print(f"[Liftosauring] Performing read-only sync with Liftosaur API ({engine.mask_api_key(DEFAULT_USER_KEY)})...")
            profile = engine.fetch_liftosaur_profile(DEFAULT_USER_KEY, callsign="Jonathan", sex="M")
            enc_key = engine.encrypt_api_key(DEFAULT_USER_KEY)
            cur.execute("""
                INSERT OR REPLACE INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
            """, ("user_primary", "Jonathan", "M", enc_key, profile["maskedKey"], profile["overallRank"]["icon"], json.dumps(profile), int(time.time())))
            conn.commit()
            seed_raid_and_feed(conn, profile)
            print(f"[Liftosauring] Sync complete. Rank: {profile['overallRank']['fullTitle']} ({profile['overallScore']})")
        except Exception as e:
            print(f"[Liftosauring] Warning during initial sync: {e}")

    conn.close()


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
        cur.execute("""
            INSERT OR REPLACE INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        """, (f["id"], f["callsign"], f["sex"], "mock_encrypted", f["masked_key"], f["avatar"], json.dumps(f["profile"]), int(time.time())))
    conn.commit()


def seed_raid_and_feed(conn, user_profile: dict):
    cur = conn.cursor()

    # Purely read-only weekly Pack Tonnage Objective derived from Liftosaur history
    user_vol = int(user_profile.get("weeklyVolume", 25000))
    max_hp = 150000
    pack_damage = user_vol + 31450 + 22800 + 24100 + 19500
    remaining_hp = max(12400, max_hp - pack_damage)

    latest_w = user_profile["workouts"][0] if user_profile.get("workouts") else None
    latest_move = f"{latest_w['dayName']} ({int(latest_w['totalVolume']):,} lbs)" if latest_w else "Weekly Synced Sessions"

    combat_log = [
        {"attacker": user_profile["callsign"], "move": latest_move, "damage": user_vol, "crit": True, "time": "Synced via API"},
        {"attacker": "Marcus V.", "move": "SBS Hypertrophy Week 4 Volume", "damage": 31450, "crit": False, "time": "2h ago"},
        {"attacker": "Sarah K.", "move": "GZCL Deadlift Session (PR Multiplier)", "damage": 22800, "crit": True, "time": "3h ago"},
        {"attacker": "Devon R.", "move": "5/3/1 BBB Upper Body Volume", "damage": 24100, "crit": False, "time": "1d ago"},
        {"attacker": "Kai T.", "move": "Full Body Linear Progression", "damage": 19500, "crit": False, "time": "1d ago"},
    ]

    cur.execute("""
        INSERT OR REPLACE INTO raid_boss (id, name, subtitle, max_hp, current_hp, level, reward_fossils, combat_log_json)
        VALUES ('boss_weekly', 'GIGANOTOSAURUS ALPHA', 'Weekly Co-op Pack Objective • Automatically tallies synced Liftosaur volume across all Pack members', ?, ?, 4, 650, ?)
    """, (max_hp, remaining_hp, json.dumps(combat_log)))

    cur.execute("DELETE FROM social_feed")
    if latest_w:
        ex_summary = ", ".join(f"{e['name']} ({int(e['best_e1rm'])} lb e1RM)" for e in latest_w["exercises"][:2])
        cur.execute("""
            INSERT INTO social_feed (user_id, callsign, avatar, rank_title, rank_color, event_type, headline, detail, hype_count, created_at)
            VALUES (?, ?, ?, ?, ?, 'WORKOUT_SYNC', ?, ?, 14, ?)
        """, (
            "user_primary",
            user_profile["callsign"],
            user_profile["overallRank"]["icon"],
            user_profile["overallRank"]["fullTitle"],
            user_profile["overallRank"]["color"],
            f"Completed {latest_w['dayName']} • {latest_w['program']}",
            f"Logged {int(latest_w['totalVolume']):,} lbs across {latest_w['totalSets']} working sets. Primary work: {ex_summary}. (+{latest_w['lpEarned']} LP)",
            latest_w["date"][:16]
        ))

    feed_items = [
        ("friend_2", "Sarah K.", "VI", "Stegosaurus I", "#34d399", "PR_ALERT",
         "New Deadlift e1RM: 275 lb (245 lb × 4)",
         "Allometric DOTS rose to 318.2. Contributed 22,800 lbs toward the weekly Pack objective.", 19, "3 hours ago"),
        ("friend_4", "Kai T.", "IV", "Velociraptor II", "#d4d4d8", "RANK_UP",
         "Promoted to Velociraptor II (+84 LP this week)",
         "Completed 7 sessions in the last 14 days on Recommended Routine.", 11, "Yesterday"),
        ("friend_1", "Marcus V.", "VII", "Allosaurus III", "#38bdf8", "CHALLENGE",
         "Cleared 31,450 lbs weekly volume on SBS Hypertrophy",
         "Top set Squat 365 lb × 4 (405 lb e1RM). Currently leading the Pack weekly tonnage board.", 8, "2 days ago"),
    ]
    for item in feed_items:
        cur.execute("""
            INSERT INTO social_feed (user_id, callsign, avatar, rank_title, rank_color, event_type, headline, detail, hype_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, item)

    cur.execute("DELETE FROM duels")
    user_bench = user_profile["bigFour"].get("Bench Press", 269.5)
    user_squat = user_profile["bigFour"].get("Squat", 341.0)
    duels_seed = [
        (user_profile["callsign"], "Devon R.", "VI", "Stegosaurus III",
         "Bench Press e1RM Benchmark", "Bench Press", user_bench, 295.0, 300.0, "lb e1RM", "ACTIVE", "4d 11h remaining"),
        (user_profile["callsign"], "Sarah K.", "VI", "Stegosaurus I",
         "7-Day Rolling Volume Comparison", "Total Weekly Volume", float(user_vol), 22800.0, 30000.0, "lbs", "ACTIVE", "2d 06h remaining"),
        (user_profile["callsign"], "Marcus V.", "VII", "Allosaurus III",
         "Squat e1RM Progression", "Squat", user_squat, 405.0, 415.0, "lb e1RM", "ACTIVE", "5d 18h remaining")
    ]
    for d in duels_seed:
        cur.execute("""
            INSERT INTO duels (challenger_name, opponent_name, opponent_avatar, opponent_rank, metric_type, exercise_name, user_progress, opponent_progress, target_goal, unit, status, expires_in)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, d)

    conn.commit()


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
        p = json.loads(u["profile_json"])
        is_me = (u["id"] == "user_primary")
        lp_week = sum(w.get("lpEarned", 12) for w in p.get("workouts", [])[:4]) if is_me else p.get("lpGainedWeek", 30)
        pack_members.append({
            "id": u["id"],
            "callsign": u["callsign"],
            "sex": u["sex"],
            "avatar": p.get("overallRank", {}).get("icon", "VI"),
            "maskedKey": u["masked_key"],
            "isMe": is_me,
            "bodyweight": p.get("bodyweight", 195),
            "overallScore": p.get("overallScore", 500),
            "overallRank": p.get("overallRank"),
            "dotsScore": p.get("dotsScore", 250),
            "sbdTotal": p.get("sbdTotal", 800),
            "weeklyVolume": p.get("weeklyVolume", 20000),
            "recentWorkouts14d": p.get("recentWorkouts14d", 5),
            "lpGainedWeek": lp_week,
            "bigFour": p.get("bigFour", {}),
            "activeProgram": p.get("activeProgram", "Custom"),
            "liveStatus": f"Synced from Liftosaur API • {p.get('workoutsCount', 60)} workouts" if is_me else p.get("liveStatus", "Synced")
        })

    cur.execute("SELECT * FROM raid_boss WHERE id = 'boss_weekly'")
    boss_row = cur.fetchone()
    raid_boss = None
    if boss_row:
        raid_boss = {
            "id": boss_row["id"],
            "name": boss_row["name"],
            "subtitle": boss_row["subtitle"],
            "maxHp": boss_row["max_hp"],
            "currentHp": boss_row["current_hp"],
            "level": boss_row["level"],
            "rewardFossils": boss_row["reward_fossils"],
            "combatLog": json.loads(boss_row["combat_log_json"])
        }

    cur.execute("SELECT * FROM social_feed ORDER BY id DESC LIMIT 15")
    feed = [dict(r) for r in cur.fetchall()]

    cur.execute("SELECT * FROM duels ORDER BY id DESC")
    duels = [dict(r) for r in cur.fetchall()]

    conn.close()
    return {
        "user": user_profile,
        "packMembers": pack_members,
        "raidBoss": raid_boss,
        "socialFeed": feed,
        "duels": duels,
        "rankTiers": engine.RANK_TIERS
    }


class LiftosauringHandler(SimpleHTTPRequestHandler):
    def send_json(self, data: dict, status: int = 200):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            try:
                self.send_json({"ok": True, "data": build_state_payload()})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, status=500)
            return

        if parsed.path == "/" or parsed.path == "/index.html":
            self.path = "/static/index.html"
        elif not parsed.path.startswith("/static/"):
            self.path = "/static" + parsed.path

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self.read_json_body()

        # 1. Connect or Re-Sync Liftosaur API Key (Read-Only from Liftosaur)
        if parsed.path == "/api/sync":
            raw_key = body.get("apiKey", "").strip()
            callsign = body.get("callsign", "Jonathan").strip() or "Jonathan"
            sex = body.get("sex", "M").strip() or "M"
            target_user_id = body.get("userId", "user_primary")

            conn = get_db()
            cur = conn.cursor()

            if not raw_key:
                cur.execute("SELECT encrypted_key, callsign, sex FROM users WHERE id = ?", (target_user_id,))
                row = cur.fetchone()
                if not row or not row["encrypted_key"]:
                    conn.close()
                    return self.send_json({"ok": False, "error": "No API key stored. Please provide a valid lftsk_ key."}, 400)
                raw_key = engine.decrypt_api_key(row["encrypted_key"])
                callsign = body.get("callsign") or row["callsign"]
                sex = body.get("sex") or row["sex"]

            if not raw_key.startswith("lftsk_"):
                conn.close()
                return self.send_json({"ok": False, "error": "Liftosaur API keys must begin with 'lftsk_'."}, 400)

            try:
                profile = engine.fetch_liftosaur_profile(raw_key, callsign=callsign, sex=sex)
                enc_key = engine.encrypt_api_key(raw_key)
                cur.execute("""
                    INSERT OR REPLACE INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (target_user_id, callsign, sex, enc_key, profile["maskedKey"], 1 if target_user_id == "user_primary" else 0, profile["overallRank"]["icon"], json.dumps(profile), int(time.time())))
                conn.commit()
                if target_user_id == "user_primary":
                    seed_raid_and_feed(conn, profile)
                conn.close()
                return self.send_json({"ok": True, "message": f"Synced {profile['workoutsCount']} workouts from Liftosaur.", "data": build_state_payload()})
            except Exception as e:
                conn.close()
                return self.send_json({"ok": False, "error": str(e)}, 400)

        # 2. Add a Friend to the Pack via their Liftosaur API Key
        if parsed.path == "/api/pack/add":
            friend_name = body.get("callsign", "").strip()
            friend_sex = body.get("sex", "M")
            friend_key = body.get("apiKey", "").strip()

            if not friend_name:
                return self.send_json({"ok": False, "error": "Callsign is required."}, 400)
            if not friend_key or not friend_key.startswith("lftsk_"):
                return self.send_json({"ok": False, "error": "A valid Liftosaur API key (lftsk_...) is required to sync a peer profile."}, 400)

            conn = get_db()
            cur = conn.cursor()
            friend_id = f"friend_{int(time.time())}"

            try:
                f_profile = engine.fetch_liftosaur_profile(friend_key, callsign=friend_name, sex=friend_sex)
                f_profile["liveStatus"] = f"Synced from Liftosaur API • {f_profile['workoutsCount']} workouts"
                f_profile["lpGainedWeek"] = sum(w.get("lpEarned", 15) for w in f_profile.get("workouts", [])[:4])
                enc = engine.encrypt_api_key(friend_key)
                masked = f_profile["maskedKey"]

                cur.execute("""
                    INSERT INTO users (id, callsign, sex, encrypted_key, masked_key, is_live_user, avatar, profile_json, updated_at)
                    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                """, (friend_id, friend_name, friend_sex, enc, masked, f_profile["overallRank"]["icon"], json.dumps(f_profile), int(time.time())))

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
                conn.close()
                return self.send_json({"ok": True, "data": build_state_payload()})
            except Exception as e:
                conn.close()
                return self.send_json({"ok": False, "error": str(e)}, 400)

        # 3. Acknowledge / Endorse a Feed Item
        if parsed.path == "/api/feed/hype":
            post_id = int(body.get("postId", 0))
            conn = get_db()
            cur = conn.cursor()
            cur.execute("UPDATE social_feed SET hype_count = hype_count + 1 WHERE id = ?", (post_id,))
            conn.commit()
            conn.close()
            return self.send_json({"ok": True, "data": build_state_payload()})

        # 4. Read-Only Projection Calculator Endpoint
        if parsed.path == "/api/calculator":
            ex_name = body.get("exercise", "Bench Press")
            weight = float(body.get("weight", 225))
            reps = int(body.get("reps", 5))
            bw = float(body.get("bodyweight", 197))
            sex = body.get("sex", "M")
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


def run_server(port: int = 8080):
    init_db()
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(("0.0.0.0", port), LiftosauringHandler)
    print(f"\n[Liftosauring] Server listening at http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server(8080)
