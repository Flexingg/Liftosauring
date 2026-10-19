# Liftosauring

**Read-Only Strength Telemetry & Competitive Ranking Platform — Powered by the Liftosaur API**

Liftosauring is a competitive strength-ranking and social fitness web application inspired by LiftoffRank. It connects directly to the [Liftosaur REST API](https://www.liftosaur.com/api/v1) in read-only mode to parse workout histories, biometric measurements, and scheduled training sessions into a standardized 0–1,000 allometric strength index across 9 prehistoric classification tiers.

---

## Features

- **AES-256-GCM Encrypted Key Vault:** Users connect their personal `lftsk_...` Liftosaur API key, which is validated against `GET /api/v1/measurements` and encrypted at rest in SQLite.
- **9 Prehistoric Classification Tiers (`I` – `IX`):** Standardized 0–1,000 allometric index (*Hatchling*, *Compy*, *Gallimimus*, *Velociraptor*, *Triceratops*, *Stegosaurus*, *Allosaurus*, *Tyrannosaurus*, and *Apex Extinction*), subdivided into `III → II → I` (100 LP per division).
- **6-Axis Muscular & Cadence Radar:** Visualizes pound-for-pound balance across *Chest*, *Back*, *Legs*, *Shoulders*, *Arms*, and 14-day training *Cadence*.
- **Ranked Exercise Index:** Parses Liftosaur's workout DSL (`/api/v1/history`) to compute Epley 1RMs, working tonnage, and exact 5RM/3RM load thresholds needed for the next division promotion.
- **Read-Only Scheduled Session Preview (`/api/v1/workout/next`):** Displays your next prescribed workout in Liftosaur alongside the exact AMRAP rep threshold required to break your historical PR.
- **Theoretical e1RM & Rank Projection Calculator:** Interactive read-only model to preview how hypothetical bar weights and repetitions translate to Epley 1RM and division placement.
- **Multi-Mode Pack Standings & Co-op Volume Objective:** Compete with friends by *Allometric Index*, *Relative DOTS*, *Weekly Velocity (+LP)*, or *7-Day Rolling Volume*, and automatically aggregate synced Pack tonnage toward a weekly 150,000 lb objective.

---

## Quick Start

### 1. Install Dependencies
```bash
pip3 install -r requirements.txt
```

### 2. Run the Server
```bash
# Optionally pass your Liftosaur API key via environment variable for initial sync,
# or paste it directly into the API Key Configuration section in the web UI:
LIFTOSAUR_API_KEY="lftsk_your_key_here" python3 server.py
```

Open **[http://localhost:8080](http://localhost:8080)** in your browser.

---

## Project Structure

- `engine.py` — Liftosaur REST API client, Liftoscript workout history parser, Epley 1RM & DOTS allometric scoring math, and AES-256-GCM key encryption.
- `server.py` — Zero-boilerplate Python HTTP API server and SQLite persistence layer (`liftosauring.db`).
- `static/index.html` — Sleek dark-matte telemetry interface with scroll-reveal animations.
- `static/app.js` — Frontend state controller, custom SVG 6-axis radar renderer, and projection calculator.
