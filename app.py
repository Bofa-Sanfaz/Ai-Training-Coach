import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests
import textwrap
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# ---------------------------------------------------------
# 1. FUTURISTIC LIGHT THEME & BULLETPROOF MOBILE CSS
# ---------------------------------------------------------
st.set_page_config(page_title="AI Coach", layout="centered", page_icon="⚡")

st.markdown("""
<style>
    /* Smooth Viewport Transition Animation */
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
    }
    .stApp {
        background-color: #f8fafc;
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        animation: fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    /* Clean Header */
    .header-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 8px;
        border-bottom: 2px solid #e2e8f0;
        margin-bottom: 12px;
    }
    .brand-title {
        font-size: 1.4rem;
        font-weight: 800;
        color: #fc5200;
        letter-spacing: -0.5px;
    }
    .status-pill {
        font-size: 0.70rem;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 9999px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
    }
    .status-synced {
        background-color: #dcfce7;
        color: #15803d;
        border: 1px solid #bbf7d0;
    }
    .status-unlinked {
        background-color: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fecaca;
    }

    /* FORCED TAB FIX: Clean Box Pills, Zero Emojis, No Overflow */
    .stTabs [data-baseweb="tab-list"] {
        display: flex !important;
        background-color: #e2e8f0 !important;
        padding: 4px !important;
        border-radius: 10px !important;
        gap: 2px !important;
        border: 1px solid #cbd5e1 !important;
        margin-bottom: 14px !important;
        width: 100% !important;
    }
    .stTabs [data-baseweb="tab"] {
        flex: 1 !important;
        text-align: center !important;
        background-color: transparent !important;
        border: none !important;
        border-radius: 7px !important;
        padding: 6px 2px !important;
        height: 34px !important;
    }
    .stTabs [data-baseweb="tab"] p,
    .stTabs [data-baseweb="tab"] span,
    .stTabs [data-baseweb="tab"] div {
        color: #334155 !important;
        font-weight: 700 !important;
        font-size: 0.78rem !important;
        text-transform: uppercase !important;
        letter-spacing: 0.3px !important;
    }
    .stTabs [data-baseweb="tab"][aria-selected="true"] {
        background-color: #ffffff !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.08) !important;
    }
    .stTabs [data-baseweb="tab"][aria-selected="true"] p,
    .stTabs [data-baseweb="tab"][aria-selected="true"] span,
    .stTabs [data-baseweb="tab"][aria-selected="true"] div {
        color: #fc5200 !important;
        font-weight: 800 !important;
    }

    /* Radio Button Text Fix: High Contrast */
    div[role="radiogroup"] label {
        background-color: #ffffff !important;
        padding: 6px 12px !important;
        border-radius: 8px !important;
        border: 1px solid #e2e8f0 !important;
        margin-right: 8px !important;
    }
    div[role="radiogroup"] label div p,
    div[role="radiogroup"] label span {
        color: #0f172a !important;
        font-weight: 700 !important;
        font-size: 0.85rem !important;
    }

    /* Inputs & Select Boxes */
    .stTextArea textarea, .stTextInput input, div[data-baseweb="select"] > div {
        background-color: #ffffff !important;
        color: #0f172a !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 8px !important;
        font-size: 0.88rem !important;
    }
    div[data-baseweb="select"] span {
        color: #0f172a !important;
        font-weight: 600 !important;
    }

    /* High-Contrast Action Buttons */
    div.stButton > button[kind="primary"] {
        background-color: #fc5200 !important;
        color: #ffffff !important;
        border: none !important;
        font-weight: 700 !important;
        border-radius: 10px !important;
    }
    div.stButton > button[kind="secondary"] {
        background-color: #ffffff !important;
        color: #0f172a !important;
        border: 1px solid #cbd5e1 !important;
        font-weight: 600 !important;
        border-radius: 10px !important;
    }

    /* Feed & Hero Cards */
    .workout-card {
        background-color: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 14px;
        margin-bottom: 6px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
    }
    .card-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 5px;
    }
    .card-title {
        font-size: 0.88rem;
        font-weight: 700;
        color: #1e293b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .metric-strip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background-color: #f8fafc;
        border-radius: 8px;
        padding: 6px 12px;
        margin-top: 4px;
        border: 1px solid #f1f5f9;
    }
    .metric-cell {
        text-align: center;
        flex: 1;
    }
    .metric-num {
        font-size: 0.86rem;
        font-weight: 800;
        color: #0f172a;
    }
    .metric-lbl {
        font-size: 0.58rem;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.3px;
    }

    /* Futuristic In-Session Hero Dashboard */
    .hero-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin: 12px 0;
    }
    .hero-box {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 10px 8px;
        text-align: center;
        box-shadow: 0 1px 3px rgba(0,0,0,0.03);
    }
    .hero-val {
        font-size: 1.15rem;
        font-weight: 800;
        color: #0f172a;
    }
    .hero-sub {
        font-size: 0.62rem;
        color: #64748b;
        text-transform: uppercase;
        font-weight: 700;
        margin-top: 2px;
    }

    /* Biometric Sub-Grid */
    .telemetry-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        margin: 10px 0;
    }
    .telemetry-row {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 8px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .telemetry-name {
        font-size: 0.78rem;
        font-weight: 600;
        color: #64748b;
    }
    .telemetry-val {
        font-size: 0.88rem;
        font-weight: 800;
        color: #0f172a;
    }

    /* AI Debrief Card */
    .ai-card {
        background: #ffffff;
        border: 1px solid #fed7aa;
        border-left: 4px solid #fc5200;
        border-radius: 10px;
        padding: 14px 16px;
        margin: 12px 0;
        box-shadow: 0 2px 6px rgba(252, 82, 0, 0.05);
        font-size: 0.90rem;
        line-height: 1.5;
    }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------
# 2. VECTOR SVG FIGURES (NO RAW EMOJIS)
# ---------------------------------------------------------
SVG_BIKE = """<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>"""
SVG_RUN = """<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="5" r="1.5"/><path d="m14 11 2-2-3-3-4 3 2 4-3 5 2 2 3-4 3 3"/></svg>"""
SVG_HEART = """<svg width="12" height="12" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" style="vertical-align: middle;"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>"""
SVG_MOUNTAIN = """<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>"""

# ---------------------------------------------------------
# 3. DATABASE ENGINE & VAULT UTILITIES
# ---------------------------------------------------------
DB_FILE = "training_vault.db"

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def format_session_code(sport_prefix, seq_num, dt_obj, moving_sec):
    day_str = dt_obj.strftime("%d/%b/%Y").lstrip("0")
    start_time = dt_obj.strftime("%I:%M%p").lstrip("0")
    end_dt = dt_obj + datetime.timedelta(seconds=int(moving_sec or 0))
    end_time = end_dt.strftime("%I:%M%p").lstrip("0")
    return f"{sport_prefix} {seq_num:03d} - {day_str} - {start_time} > {end_time}"

def clean_and_renumber_vault():
    conn = get_db()
    c = conn.cursor()
    c.execute("""
    DELETE FROM workouts 
    WHERE id NOT IN (
        SELECT MIN(id) 
        FROM workouts 
        GROUP BY date, distance_km
    )
    """)
    conn.commit()

    rides = conn.execute("SELECT id, date, moving_time_sec FROM workouts WHERE sport_category='Ride' ORDER BY date ASC").fetchall()
    for idx, r in enumerate(rides, 1):
        try:
            dt = datetime.datetime.strptime(r['date'], "%Y-%m-%d %H:%M")
        except:
            dt = datetime.datetime.now()
        code = format_session_code("Ride", idx, dt, r['moving_time_sec'])
        c.execute("UPDATE workouts SET exercise_code=? WHERE id=?", (code, r['id']))

    runs = conn.execute("SELECT id, date, moving_time_sec FROM workouts WHERE sport_category='Run' ORDER BY date ASC").fetchall()
    for idx, r in enumerate(runs, 1):
        try:
            dt = datetime.datetime.strptime(r['date'], "%Y-%m-%d %H:%M")
        except:
            dt = datetime.datetime.now()
        code = format_session_code("Run", idx, dt, r['moving_time_sec'])
        c.execute("UPDATE workouts SET exercise_code=? WHERE id=?", (code, r['id']))
        
    conn.commit()
    conn.close()

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT)")
    
    c.execute("PRAGMA table_info(workouts)")
    existing_cols = {row[1] for row in c.fetchall()}
    
    required_cols = {
        "strava_id": "INTEGER",
        "exercise_code": "TEXT",
        "date": "TEXT",
        "activity_type": "TEXT",
        "sport_category": "TEXT",
        "title": "TEXT",
        "distance_km": "REAL",
        "moving_time_str": "TEXT",
        "moving_time_sec": "INTEGER",
        "elapsed_time_sec": "INTEGER",
        "avg_speed_kmh": "REAL",
        "max_speed_kmh": "REAL",
        "pace_str": "TEXT",
        "elevation_gain_m": "REAL",
        "elev_high_m": "REAL",
        "elev_low_m": "REAL",
        "avg_hr": "INTEGER",
        "max_hr": "INTEGER",
        "avg_power_w": "REAL",
        "max_power_w": "REAL",
        "norm_power_w": "REAL",
        "kilojoules": "REAL",
        "avg_cadence": "REAL",
        "calories": "INTEGER",
        "suffer_score": "INTEGER",
        "notes": "TEXT"
    }
    
    for col_name, col_type in required_cols.items():
        if col_name not in existing_cols:
            try:
                c.execute(f"ALTER TABLE workouts ADD COLUMN {col_name} {col_type}")
            except Exception:
                pass
                
    c.execute("""
    UPDATE workouts 
    SET sport_category = CASE 
        WHEN activity_type LIKE '%Run%' OR activity_type LIKE '%Walk%' THEN 'Run'
        ELSE 'Ride'
    END
    WHERE sport_category IS NULL OR sport_category = ''
    """)
    
    c.execute("""
    CREATE TABLE IF NOT EXISTS ai_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT,
        reference_info TEXT,
        created_at TEXT,
        analysis_text TEXT
    )
    """)
    conn.commit()
    conn.close()

init_db()

# ---------------------------------------------------------
# 4. CREDENTIALS & RATE LIMIT COUNTERS
# ---------------------------------------------------------
CLIENT_ID = st.secrets.get("STRAVA_CLIENT_ID", "").strip().strip('"')
CLIENT_SECRET = st.secrets.get("STRAVA_CLIENT_SECRET", "").strip().strip('"')
DEFAULT_REFRESH = st.secrets.get("STRAVA_REFRESH_TOKEN", "").strip().strip('"')
GEMINI_KEY = st.secrets.get("GEMINI_API_KEY", "").strip().strip('"')

def get_config(key):
    conn = get_db()
    r = conn.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
    conn.close()
    return r["value"] if r else None

def set_config(key, val):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, str(val)))
    conn.commit()
    conn.close()

def log_api_call(provider):
    today = datetime.date.today().isoformat()
    key = f"{provider}_calls_{today}"
    current = int(get_config(key) or 0)
    set_config(key, current + 1)
    return current + 1

def get_valid_token():
    refresh_token = get_config("strava_refresh_token") or DEFAULT_REFRESH
    if not refresh_token or not CLIENT_ID or not CLIENT_SECRET:
        return None
        
    res = requests.post("https://www.strava.com/oauth/token", data={
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    })
    if res.status_code == 200:
        data = res.json()
        set_config("strava_access_token", data.get("access_token"))
        set_config("strava_refresh_token", data.get("refresh_token"))
        return data.get("access_token")
    return None

def calc_pace(moving_sec, dist_km):
    if dist_km and dist_km > 0.05:
        sec_per_km = int(moving_sec / dist_km)
        pm, ps = divmod(sec_per_km, 60)
        return f"{pm}:{ps:02d} /km"
    return "--"

def sync_strava():
    token = get_valid_token()
    if not token:
        st.error("Strava session not authenticated or expired.")
        return -1
        
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get("https://www.strava.com/api/v3/athlete/activities?per_page=60", headers=headers)
    log_api_call("strava")
    
    if res.status_code != 200:
        st.error(f"Strava Sync Error ({res.status_code}): {res.text}")
        return -1
        
    activities = res.json()
    if not isinstance(activities, list):
        return -1
        
    conn = get_db()
    new_count = 0
    
    for act in reversed(activities):
        s_id = act.get("id")
        exists = conn.execute("SELECT id FROM workouts WHERE strava_id=?", (s_id,)).fetchone()
        if exists:
            continue
            
        raw_type = act.get("type", "Ride")
        is_run = raw_type in ["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]
        sport_cat = "Run" if is_run else "Ride"
        act_type = f"Run ({raw_type})" if is_run else f"Ride ({raw_type})"
        
        dt_raw = act.get("start_date_local", "")
        try:
            dt_obj = datetime.datetime.fromisoformat(dt_raw.replace("Z", ""))
            date_str = dt_obj.strftime("%Y-%m-%d %H:%M")
        except:
            dt_obj = datetime.datetime.now()
            date_str = dt_obj.strftime("%Y-%m-%d %H:%M")
            
        dist_km = round(act.get("distance", 0.0) / 1000.0, 2)
        m_time = act.get("moving_time", 0)
        e_time = act.get("elapsed_time", 0)
        m, s = divmod(m_time, 60)
        time_str = f"{m}:{s:02d}"
        
        avg_spd = round(act.get("average_speed", 0.0) * 3.6, 1)
        max_spd = round(act.get("max_speed", 0.0) * 3.6, 1)
        pace_str = calc_pace(m_time, dist_km) if is_run else ""
        
        elev = round(act.get("total_elevation_gain", 0.0), 0)
        elev_high = round(act.get("elev_high", 0.0), 0)
        elev_low = round(act.get("elev_low", 0.0), 0)
        
        avg_hr = int(act.get("average_heartrate", 0)) if "average_heartrate" in act else 0
        max_hr = int(act.get("max_heartrate", 0)) if "max_heartrate" in act else 0
        watts = round(act.get("average_watts", 0.0), 0)
        max_watts = round(act.get("max_watts", 0.0), 0)
        norm_watts = round(act.get("weighted_average_watts", 0.0), 0)
        kj = round(act.get("kilojoules", 0.0), 1)
        cadence = round(act.get("average_cadence", 0.0), 1)
        suffer = int(act.get("suffer_score", 0)) if act.get("suffer_score") else 0
        
        # Smart Biometric Fallbacks (If Strava returns 0/null without power meter)
        if kj == 0 and watts > 0 and m_time > 0:
            kj = round((watts * m_time) / 1000.0, 1)
        cal = int(act.get("calories", 0)) if act.get("calories") else int(kj * 1.05) if kj > 0 else 0
        if norm_watts == 0 and watts > 0:
            norm_watts = round(watts * 1.05, 0) # Standard XC ride NP approximation
            
        title = act.get("name", "Training Session")
        
        conn.execute("""
        INSERT INTO workouts (
            strava_id, exercise_code, date, activity_type, sport_category, title, distance_km, 
            moving_time_str, moving_time_sec, elapsed_time_sec, avg_speed_kmh, max_speed_kmh, 
            pace_str, elevation_gain_m, elev_high_m, elev_low_m, avg_hr, max_hr, avg_power_w, 
            max_power_w, norm_power_w, kilojoules, avg_cadence, calories, suffer_score, notes
        )
        VALUES (?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
        """, (s_id, date_str, act_type, sport_cat, title, dist_km, time_str, m_time, e_time, avg_spd, max_spd, pace_str, elev, elev_high, elev_low, avg_hr, max_hr, watts, max_watts, norm_watts, kj, cadence, cal, suffer))
        new_count += 1
        
    conn.commit()
    conn.close()
    clean_and_renumber_vault()
    return new_count

# ---------------------------------------------------------
# 5. BULLETPROOF GEMINI ENGINE (3.6-FLASH CHAIN)
# ---------------------------------------------------------
def call_gemini(prompt):
    key = get_config("custom_gemini_key") or GEMINI_KEY
    if not key:
        st.error("No Gemini Key found. Set your key in Settings or Streamlit Secrets.")
        return None
        
    candidate_models = ["gemini-3.6-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
    payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    
    for model_name in candidate_models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={key}"
        try:
            res = requests.post(url, json=payload, headers=headers, timeout=40)
            if res.status_code == 200:
                log_api_call("gemini")
                data = res.json()
                return data["candidates"][0]["content"]["parts"][0]["text"]
            elif res.status_code in [404, 400]:
                continue
            else:
                st.error(f"Gemini API Error ({res.status_code}): {res.text}")
                return None
        except Exception:
            continue
            
    st.error("Could not reach Gemini API. Verify your API key in Settings.")
    return None

# ---------------------------------------------------------
# 6. HEADER & SESSION NAVIGATION
# ---------------------------------------------------------
is_connected = bool(get_config("strava_refresh_token") or DEFAULT_REFRESH)
status_html = '<span class="status-pill status-synced">● STRAVA CONNECTED</span>' if is_connected else '<span class="status-pill status-unlinked">● DISCONNECTED</span>'

st.markdown(f"""
<div class="header-bar">
    <span class="brand-title">AI Coach</span>
    {status_html}
</div>
""", unsafe_allow_html=True)

if "active_session_id" not in st.session_state:
    st.session_state.active_session_id = None

# =========================================================
# DETAIL VIEW: DEEP IN-SESSION DASHBOARD & PLOTLY STUDIO
# =========================================================
if st.session_state.active_session_id is not None:
    conn = get_db()
    w = conn.execute("SELECT * FROM workouts WHERE id=?", (st.session_state.active_session_id,)).fetchone()
    conn.close()

    if st.button("← Back to All Sessions", type="secondary"):
        st.session_state.active_session_id = None
        st.rerun()

    if w:
        is_run = (w['sport_category'] == 'Run')
        st.markdown(f"## {w['exercise_code']}")
        st.caption(f"Sport Category: **{w['sport_category']}** | Logged: **{w['date']}**")
        
        # 1. Primary Hero Telemetry Board
        speed_pace_val = w['pace_str'] if is_run else f"{w['avg_speed_kmh']:.1f} km/h"
        speed_pace_lbl = "Avg Pace" if is_run else "Avg Speed"
        pwr_val = f"{w['avg_power_w']:.0f} W" if w['avg_power_w'] > 0 else "--"
        hr_val = f"{w['avg_hr']} bpm" if w['avg_hr'] > 0 else "--"
        
        hero_html = textwrap.dedent(f"""
        <div class="hero-grid">
            <div class="hero-box"><div class="hero-val">{w['distance_km']:.2f}k</div><div class="hero-sub">Distance</div></div>
            <div class="hero-box"><div class="hero-val">{w['moving_time_str']}</div><div class="hero-sub">Duration</div></div>
            <div class="hero-box"><div class="hero-val">{speed_pace_val}</div><div class="hero-sub">{speed_pace_lbl}</div></div>
            <div class="hero-box"><div class="hero-val">{pwr_val}</div><div class="hero-sub">Power</div></div>
            <div class="hero-box"><div class="hero-val">{hr_val}</div><div class="hero-sub">Avg HR</div></div>
            <div class="hero-box"><div class="hero-val">{w['elevation_gain_m']:.0f}m</div><div class="hero-sub">Ascent</div></div>
        </div>
        """)
        st.markdown(hero_html, unsafe_allow_html=True)

        # 2. Secondary Telemetry Grid
        st.markdown("#### Secondary Telemetry & Biometrics")
        vam = round((w['elevation_gain_m'] / (w['moving_time_sec'] / 3600.0)), 0) if w['moving_time_sec'] > 0 else 0
        sec1 = f"{w['max_speed_kmh']:.1f} km/h" if w['max_speed_kmh'] > 0 else "--"
        sec2 = f"{w['max_hr']} bpm" if w['max_hr'] > 0 else "--"
        sec3 = f"{w['norm_power_w']:.0f} W" if w['norm_power_w'] > 0 else "--"
        sec4 = f"{w['kilojoules']:.0f} kJ" if w['kilojoules'] > 0 else "--"
        sec5 = f"{vam:.0f} m/h" if vam > 0 else "--"
        sec6 = f"{w['calories']} kcal" if w['calories'] > 0 else "--"

        telemetry_html = textwrap.dedent(f"""
        <div class="telemetry-grid">
            <div class="telemetry-row"><span class="telemetry-name">Max Speed</span><span class="telemetry-val">{sec1}</span></div>
            <div class="telemetry-row"><span class="telemetry-name">Peak Heart Rate</span><span class="telemetry-val">{sec2}</span></div>
            <div class="telemetry-row"><span class="telemetry-name">Normalized Power</span><span class="telemetry-val">{sec3}</span></div>
            <div class="telemetry-row"><span class="telemetry-name">Mechanical Work</span><span class="telemetry-val">{sec4}</span></div>
            <div class="telemetry-row"><span class="telemetry-name">Climbing VAM</span><span class="telemetry-val">{sec5}</span></div>
            <div class="telemetry-row"><span class="telemetry-name">Estimated Burn</span><span class="telemetry-val">{sec6}</span></div>
        </div>
        """)
        st.markdown(telemetry_html, unsafe_allow_html=True)

        # 3. Heart Rate Zone Intensity Gauge
        if w['avg_hr'] > 0:
            pct_max = int((w['avg_hr'] / 202.0) * 100)
            zone_desc = (
                "Zone 1 (Active Recovery)" if pct_max < 60 else
                "Zone 2 (Aerobic Endurance Base)" if pct_max < 70 else
                "Zone 3 (Tempo / Aerobic Power)" if pct_max < 80 else
                "Zone 4 (Lactate Threshold)" if pct_max < 90 else
                "Zone 5 (Anaerobic / Neuromuscular Redline)"
            )
            st.write(f"**Cardiac Load:** {w['avg_hr']} bpm average ({pct_max}% of 202 bpm Max) — **{zone_desc}**")
            st.progress(min(1.0, w['avg_hr'] / 202.0))

        st.markdown("---")

        # 4. Futuristic Plotly Telemetry Studio (Dual-Axis Independent Scales)
        st.markdown("#### Interactive Telemetry Studio")
        conn = get_db()
        history_df = pd.read_sql_query(f"""
            SELECT exercise_code, date, distance_km, avg_speed_kmh, avg_hr, avg_power_w, elevation_gain_m, kilojoules 
            FROM workouts 
            WHERE sport_category='{w['sport_category']}' AND date <= '{w['date']}'
            ORDER BY date ASC
        """, conn)
        conn.close()

        if len(history_df) >= 2:
            history_df['Session'] = history_df['exercise_code'].apply(lambda x: x.split('-')[0].strip())
            
            c_mode1, c_mode2 = st.columns(2)
            with c_mode1:
                metric_left = st.selectbox("Left Axis (Orange)", ["avg_power_w", "avg_hr", "kilojoules"], index=0)
            with c_mode2:
                metric_right = st.selectbox("Right Axis (Blue)", ["avg_speed_kmh", "elevation_gain_m", "distance_km"], index=0)
                
            labels_map = {
                "avg_power_w": "Power (Watts)", "avg_hr": "Heart Rate (bpm)", "kilojoules": "Work (kJ)",
                "avg_speed_kmh": "Speed (km/h)", "elevation_gain_m": "Ascent (m)", "distance_km": "Distance (km)"
            }

            fig = make_subplots(specs=[[{"secondary_y": True}]])
            
            # Left Trace (Orange Spline)
            fig.add_trace(
                go.Scatter(
                    x=history_df['Session'], y=history_df[metric_left],
                    name=labels_map[metric_left],
                    line=dict(color="#fc5200", width=3, shape="spline"),
                    mode="lines+markers",
                    marker=dict(size=6, color="#fc5200")
                ),
                secondary_y=False
            )
            
            # Right Trace (Blue Spline)
            fig.add_trace(
                go.Scatter(
                    x=history_df['Session'], y=history_df[metric_right],
                    name=labels_map[metric_right],
                    line=dict(color="#2563eb", width=3, shape="spline"),
                    mode="lines+markers",
                    marker=dict(size=6, color="#2563eb")
                ),
                secondary_y=True
            )

            fig.update_layout(
                template="plotly_white",
                height=320,
                margin=dict(l=10, r=10, t=25, b=10),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                hovermode="x unified"
            )
            fig.update_yaxes(title_text=labels_map[metric_left], title_font=dict(color="#fc5200"), secondary_y=False)
            fig.update_yaxes(title_text=labels_map[metric_right], title_font=dict(color="#2563eb"), secondary_y=True)
            
            st.plotly_chart(fig, use_container_width=True)

            # Benchmark Delta Table (Current Session vs Last 5 Sessions Average)
            last_5 = history_df.tail(6).iloc[:-1]
            if not last_5.empty:
                avg_speed_l5 = last_5['avg_speed_kmh'].mean()
                avg_hr_l5 = last_5['avg_hr'].mean()
                avg_pwr_l5 = last_5['avg_power_w'].mean()
                avg_elev_l5 = last_5['elevation_gain_m'].mean()
                
                comp_data = {
                    "Metric": ["Average Speed", "Average Heart Rate", "Average Power", "Ascent Climbed"],
                    "This Session": [f"{w['avg_speed_kmh']:.1f} km/h", f"{w['avg_hr']} bpm", f"{w['avg_power_w']:.0f} W", f"{w['elevation_gain_m']:.0f} m"],
                    "Last 5 Avg": [f"{avg_speed_l5:.1f} km/h", f"{avg_hr_l5:.0f} bpm", f"{avg_pwr_l5:.0f} W", f"{avg_elev_l5:.0f} m"],
                    "Delta": [
                        f"{w['avg_speed_kmh'] - avg_speed_l5:+.1f} km/h",
                        f"{w['avg_hr'] - avg_hr_l5:+.0f} bpm",
                        f"{w['avg_power_w'] - avg_pwr_l5:+.0f} W",
                        f"{w['elevation_gain_m'] - avg_elev_l5:+.0f} m"
                    ]
                }
                st.markdown("##### Performance Delta vs Last 5 Workouts")
                st.dataframe(pd.DataFrame(comp_data).set_index("Metric"), use_container_width=True)

        st.markdown("---")

        # 5. Automatic In-Session AI Coach Review
        st.markdown("#### AI Coach Telemetry Debrief")
        conn = get_db()
        existing_rev = conn.execute("SELECT analysis_text FROM ai_reports WHERE reference_info=?", (w['exercise_code'],)).fetchone()
        conn.close()

        if existing_rev:
            st.markdown(f'<div class="ai-card">{existing_rev["analysis_text"]}</div>', unsafe_allow_html=True)
            if st.button("Re-Analyze Session with AI", type="secondary"):
                conn = get_db()
                conn.execute("DELETE FROM ai_reports WHERE reference_info=?", (w['exercise_code'],))
                conn.commit()
                conn.close()
                st.rerun()
        else:
            with st.spinner("AI Coach analyzing session telemetry against your last 5 workouts and all-time baseline..."):
                conn = get_db()
                prior_5 = conn.execute("""
                    SELECT exercise_code, date, distance_km, avg_speed_kmh, avg_hr, avg_power_w, elevation_gain_m 
                    FROM workouts 
                    WHERE date < ? AND sport_category=? 
                    ORDER BY date DESC LIMIT 5
                """, (w['date'], w['sport_category'])).fetchall()
                
                all_prior = conn.execute("""
                    SELECT COUNT(*) as count, AVG(avg_speed_kmh) as avg_spd, AVG(avg_power_w) as avg_pwr, AVG(avg_hr) as avg_hr 
                    FROM workouts 
                    WHERE date < ? AND sport_category=?
                """, (w['date'], w['sport_category'])).fetchone()
                conn.close()
                
                prior_str = "LAST 5 SESSIONS CONTEXT:\n"
                for p in prior_5:
                    prior_str += f"- {p['exercise_code']}: {p['distance_km']}km | Speed: {p['avg_speed_kmh']}km/h | HR: {p['avg_hr']}bpm | Watts: {p['avg_power_w']}W\n"
                    
                baseline_str = f"ALL-TIME BENCHMARK ({all_prior['count']} prior sessions): Avg Speed {all_prior['avg_spd'] or 0:.1f} km/h | Avg Watts {all_prior['avg_pwr'] or 0:.0f} W | Avg HR {all_prior['avg_hr'] or 0:.0f} bpm\n"

                prompt = f"""
You are an expert cycling & running sports scientist coaching athlete Mustafa (190 cm, ~115 kg, training on an XC MTB and road running).
DEBRIEF THIS SPECIFIC TRAINING SESSION CHRONOLOGICALLY:

CURRENT SESSION:
- Session: {w['exercise_code']} ({w['activity_type']})
- Distance & Duration: {w['distance_km']} km in {w['moving_time_str']}
- Speed & Pace: Avg {w['avg_speed_kmh']} km/h, Max {w['max_speed_kmh']} km/h
- Heart Rate: Avg {w['avg_hr']} bpm, Peak {w['max_hr']} bpm (Max HR benchmark is 202 bpm)
- Power & Climbing: Avg {w['avg_power_w']} W, Work {w['kilojoules']} kJ, Ascent {w['elevation_gain_m']} m
- Athlete Field Notes: {w['notes']}

{prior_str}
{baseline_str}

Provide a structured, elite coaching analysis:
1. **Delta vs Last 5 Sessions**: Contrast speed, power, and cardiac response against recent block averages.
2. **All-Time Progression Curve**: Assess aerobic efficiency gains vs accumulated fatigue.
3. **Mechanical Load & Efficiency**: Power-to-speed ratio under elevation and body mass.
4. **Prescription for Next Workout**: One specific technical pacing or cadence directive.
"""
                ai_text = call_gemini(prompt)
                if ai_text:
                    conn = get_db()
                    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                    conn.execute("INSERT INTO ai_reports (report_type, reference_info, created_at, analysis_text) VALUES ('Session Review', ?, ?, ?)",
                                 (w['exercise_code'], now_str, ai_text))
                    conn.commit()
                    conn.close()
                    st.markdown(f'<div class="ai-card">{ai_text}</div>', unsafe_allow_html=True)
                    st.rerun()

        # 6. Athlete Notes
        st.markdown("---")
        st.markdown("#### Athlete Field Notes")
        curr_note = st.text_area("Field observations, mechanical feel, nutrition:", value=w['notes'] or "", key=f"notes_{w['id']}")
        if st.button("Save Notes", type="secondary"):
            conn = get_db()
            conn.execute("UPDATE workouts SET notes=? WHERE id=?", (curr_note, w['id']))
            conn.commit()
            conn.close()
            st.success("Notes saved.")
            st.rerun()

    st.stop()

# =========================================================
# MAIN APP NAVIGATION: CLEAN 5-TAB APP BAR (NO EMOJIS)
# =========================================================
tab_feed, tab_analytics, tab_compare, tab_progress, tab_settings = st.tabs(["FEED", "GRAPHS", "COMPARE", "REPORTS", "SETTINGS"])

# ---------------------------------------------------------
# TAB 1: CONSUMER HIGH-DENSITY FEED
# ---------------------------------------------------------
with tab_feed:
    col_btn, col_filter = st.columns([1.8, 1.2])
    with col_btn:
        if st.button("Sync Strava", type="primary", use_container_width=True):
            with st.spinner("Syncing activities..."):
                added = sync_strava()
                if added > 0:
                    st.success(f"+{added} New Sessions!")
                    st.rerun()
                elif added == 0:
                    st.info("Up to date.")
    with col_filter:
        view_filter = st.selectbox("Category", ["All", "Rides Only", "Runs & Walks"], label_visibility="collapsed")

    conn = get_db()
    df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    if not df.empty:
        if view_filter == "Rides Only":
            df = df[df['sport_category'] == 'Ride']
        elif view_filter == "Runs & Walks":
            df = df[df['sport_category'] == 'Run']

    if df.empty:
        st.info("No activities found. Tap 'Sync Strava' above.")
    else:
        for _, r in df.iterrows():
            is_run = (r['sport_category'] == 'Run')
            icon_svg = SVG_RUN if is_run else SVG_BIKE
            
            hr_val = f"{int(r['avg_hr'])}" if pd.notna(r['avg_hr']) and r['avg_hr'] > 0 else "--"
            elev_val = f"{int(r['elevation_gain_m'])}m" if pd.notna(r['elevation_gain_m']) else "--"
            dist_val = f"{r['distance_km']:.1f}k" if pd.notna(r['distance_km']) else "--"
            time_val = str(r['moving_time_str'] or '--')
            
            if is_run:
                primary_lbl = "Pace"
                primary_val = r['pace_str'] if r['pace_str'] and r['pace_str'] != '--' else calc_pace(r['moving_time_sec'], r['distance_km'])
                sec_lbl = "Cadence"
                sec_val = f"{int(r['avg_cadence'] * 2)} spm" if pd.notna(r['avg_cadence']) and r['avg_cadence'] > 0 else "--"
            else:
                primary_lbl = "Speed"
                primary_val = f"{r['avg_speed_kmh']:.1f} <span style='font-size:0.62rem;color:#64748b;'>km/h</span>"
                sec_lbl = "Power"
                sec_val = f"{int(r['avg_power_w'])}W" if pd.notna(r['avg_power_w']) and r['avg_power_w'] > 0 else "--"

            card_html = textwrap.dedent(f"""
            <div class="workout-card">
                <div class="card-top">
                    <div class="card-left">
                        {icon_svg}
                        <span class="card-title">{r['exercise_code']}</span>
                    </div>
                </div>
                <div class="metric-strip">
                    <div class="metric-cell"><div class="metric-num">{dist_val}</div><div class="metric-lbl">Dist</div></div>
                    <div class="metric-cell"><div class="metric-num">{time_val}</div><div class="metric-lbl">Time</div></div>
                    <div class="metric-cell"><div class="metric-num">{primary_val}</div><div class="metric-lbl">{primary_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-num">{sec_val}</div><div class="metric-lbl">{sec_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-num">{SVG_HEART} {hr_val}</div><div class="metric-lbl">HR</div></div>
                    <div class="metric-cell"><div class="metric-num">{SVG_MOUNTAIN} {elev_val}</div><div class="metric-lbl">Asc</div></div>
                </div>
            </div>
            """)
            st.markdown(card_html, unsafe_allow_html=True)
            
            if st.button("Open Telemetry & Debrief →", key=f"btn_open_{r['id']}", use_container_width=True):
                st.session_state.active_session_id = r['id']
                st.rerun()

# ---------------------------------------------------------
# TAB 2: GLOBAL TELEMETRY GRAPHS (DUAL-AXIS PLOTLY)
# ---------------------------------------------------------
with tab_analytics:
    st.subheader("Global Telemetry Studio")
    conn = get_db()
    df_all = pd.read_sql_query("SELECT * FROM workouts ORDER BY date ASC", conn)
    conn.close()
    
    if len(df_all) >= 2:
        df_all['Session'] = df_all['exercise_code'].apply(lambda x: x.split('-')[0].strip())
        sport_mode = st.radio("Sport Filter", ["Cycling Telemetry", "Running & Walking Telemetry"], horizontal=True)
        
        target_df = df_all[df_all['sport_category'] == ('Ride' if "Cycling" in sport_mode else 'Run')]
        
        if len(target_df) >= 2:
            st.markdown("#### Progression Curve (Dual Independent Axes)")
            
            fig = make_subplots(specs=[[{"secondary_y": True}]])
            fig.add_trace(
                go.Scatter(
                    x=target_df['Session'], y=target_df['avg_power_w' if "Cycling" in sport_mode else 'avg_hr'],
                    name="Watts" if "Cycling" in sport_mode else "Avg HR",
                    line=dict(color="#fc5200", width=3, shape="spline"),
                    mode="lines+markers"
                ),
                secondary_y=False
            )
            fig.add_trace(
                go.Scatter(
                    x=target_df['Session'], y=target_df['avg_speed_kmh'],
                    name="Speed (km/h)",
                    line=dict(color="#2563eb", width=3, shape="spline"),
                    mode="lines+markers"
                ),
                secondary_y=True
            )
            fig.update_layout(
                template="plotly_white",
                height=350,
                margin=dict(l=10, r=10, t=30, b=10),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
            )
            fig.update_yaxes(title_text="Watts Output" if "Cycling" in sport_mode else "Avg HR", title_font=dict(color="#fc5200"), secondary_y=False)
            fig.update_yaxes(title_text="Speed (km/h)", title_font=dict(color="#2563eb"), secondary_y=True)
            st.plotly_chart(fig, use_container_width=True)
            
            st.markdown("#### Volume & Climbing Strain (kJ vs Ascent)")
            fig_bar = go.Figure(data=[
                go.Bar(name='Ascent (m)', x=target_df['Session'], y=target_df['elevation_gain_m'], marker_color='#64748b'),
                go.Bar(name='Work (kJ)', x=target_df['Session'], y=target_df['kilojoules'], marker_color='#fc5200')
            ])
            fig_bar.update_layout(barmode='group', template="plotly_white", height=280, margin=dict(l=10, r=10, t=10, b=10))
            st.plotly_chart(fig_bar, use_container_width=True)
        else:
            st.info("Log at least 2 sessions in this category to plot graphs.")
    else:
        st.info("Log or sync at least 2 sessions to unlock graphs.")

# ---------------------------------------------------------
# TAB 3: 1-TO-1 & 1-TO-2 COMPARISON LAB
# ---------------------------------------------------------
with tab_compare:
    st.subheader("Session Comparison Lab")
    conn = get_db()
    c_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    if len(c_df) < 2:
        st.warning("Need at least 2 sessions in your vault to compare.")
    else:
        options = {f"{r['exercise_code']}": r for _, r in c_df.iterrows()}
        keys = list(options.keys())

        w1_choice = st.selectbox("Baseline Session (1)", keys, index=0)
        mode = st.radio("Comparison Mode", ["1 to 1", "1 to 2"], horizontal=True)
        w2_choice = st.selectbox("Comparison Session (2)", keys, index=min(1, len(keys)-1))
        
        w3_choice = None
        if mode == "1 to 2":
            w3_choice = st.selectbox("Comparison Session (3)", keys, index=min(2, len(keys)-1))

        selected = [options[w1_choice], options[w2_choice]]
        if w3_choice:
            selected.append(options[w3_choice])

        comp_cols = ["exercise_code", "date", "activity_type", "distance_km", "moving_time_str", "avg_speed_kmh", "avg_hr", "avg_power_w", "elevation_gain_m", "kilojoules"]
        st.dataframe(pd.DataFrame(selected)[comp_cols].set_index("exercise_code"), use_container_width=True)

        if st.button("Generate Comparative AI Breakdown", type="primary", use_container_width=True):
            with st.spinner("Analyzing comparative physiological deltas..."):
                prompt = f"""
You are an expert sports physiologist analyzing athlete Mustafa (190 cm, ~115 kg).
Compare these specific training sessions side-by-side:

{pd.DataFrame(selected)[comp_cols].to_string()}

Provide a structured, elite coaching assessment:
1. Pacing & Aerobic Decoupling: Speed/pace efficiency relative to heart rate drift.
2. Mechanical Torque vs Cadence Profile under elevation.
3. Concrete Training Takeaway for the next session.
"""
                verdict = call_gemini(prompt)
                if verdict:
                    st.markdown(f'<div class="ai-card">{verdict}</div>', unsafe_allow_html=True)

# ---------------------------------------------------------
# TAB 4: PROGRESS REPORTS
# ---------------------------------------------------------
with tab_progress:
    st.subheader("Periodic Progression Reviews")
    c_cat, c_hor = st.columns(2)
    with c_cat:
        report_cat = st.selectbox("Category Filter", ["Rides Only", "Runs & Walks", "All Activities"])
    with c_hor:
        horizon = st.selectbox("Review Window", ["All Time (Full Progression)", "Last 30 Days", "Last 7 Days"])
    
    conn = get_db()
    p_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date ASC", conn)
    conn.close()
    
    if not p_df.empty:
        if report_cat == "Rides Only":
            p_df = p_df[p_df['sport_category'] == 'Ride']
        elif report_cat == "Runs & Walks":
            p_df = p_df[p_df['sport_category'] == 'Run']
            
        p_df['dt'] = pd.to_datetime(p_df['date'])
        now = datetime.datetime.now()
        
        if horizon == "Last 7 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=7))]
        elif horizon == "Last 30 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=30))]
        else:
            filtered = p_df
            
        st.write(f"Total sessions in window: **{len(filtered)}**")
        if not filtered.empty and st.button(f"Generate {horizon} ({report_cat}) Audit", type="primary", use_container_width=True):
            with st.spinner(f"Compiling {horizon} report..."):
                summary_data = filtered[["exercise_code", "date", "activity_type", "distance_km", "moving_time_str", "avg_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m"]].to_string(index=False)
                prompt = f"""
You are an elite cycling and running coach reviewing athlete Mustafa's ({horizon} - {report_cat}) training progression.
Chronological Training Curve:
{summary_data}

Provide an executive, sports-science evaluation:
1. Long-Term Adaptation: Compare baseline sessions against recent peaks in speed, power, and cardiovascular control.
2. Volume & Mechanical Strain: Evaluate total climbing and watts under body mass.
3. Next Actionable Target: Exact guidance for upcoming training blocks.
"""
                audit = call_gemini(prompt)
                if audit:
                    conn = get_db()
                    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                    conn.execute("INSERT INTO ai_reports (report_type, reference_info, created_at, analysis_text) VALUES (?, ?, ?, ?)",
                                 (f"{horizon} - {report_cat}", f"{len(filtered)} workouts", now_str, audit))
                    conn.commit()
                    conn.close()
                    st.markdown(f'<div class="ai-card">{audit}</div>', unsafe_allow_html=True)

# ---------------------------------------------------------
# TAB 5: SETTINGS, API QUOTA MONITOR & LOCAL BACKUP
# ---------------------------------------------------------
with tab_settings:
    st.subheader("System Credentials & Vault Utilities")
    
    # 1. Live API Quota Monitor
    st.markdown("#### Live API Quota Monitor")
    today_str = datetime.date.today().isoformat()
    strava_calls = get_config(f"strava_calls_{today_str}") or 0
    gemini_calls = get_config(f"gemini_calls_{today_str}") or 0
    
    q1, q2 = st.columns(2)
    q1.metric("Strava Calls (Today)", f"{strava_calls} / 2,000", help="Resets daily at 00:00 UTC. 200/15-min burst limit.")
    q2.metric("Gemini Prompts (Today)", f"{gemini_calls} / 1,500", help="Resets daily at 00:00 PT. 15 requests/min rate limit.")
    
    st.markdown("---")
    
    # 2. Local Database Backup & Restore
    st.markdown("#### Local Database Backup & Data Safety")
    st.caption("Your database is stored locally as training_vault.db. Download it directly to your phone storage to ensure zero data loss:")
    
    with open(DB_FILE, "rb") as fp:
        db_bytes = fp.read()
        
    st.download_button(
        label="Download Vault Database (.db)",
        data=db_bytes,
        file_name=f"training_vault_backup_{today_str}.db",
        mime="application/x-sqlite3",
        use_container_width=True
    )
    
    uploaded_db = st.file_uploader("Restore Database from Phone (.db)", type=["db", "sqlite", "sqlite3"])
    if uploaded_db is not None:
        if st.button("Overwrite & Restore Database", type="secondary"):
            with open(DB_FILE, "wb") as f:
                f.write(uploaded_db.getbuffer())
            st.success("Database restored successfully!")
            st.rerun()

    st.markdown("---")
    
    # 3. Gemini Key & Strava Reconnect
    st.markdown("#### Credentials & Hygiene")
    saved_key = get_config("custom_gemini_key") or ""
    new_gemini = st.text_input("Gemini API Key", value=saved_key, type="password")
    if st.button("Save Gemini Key", type="secondary"):
        set_config("custom_gemini_key", new_gemini.strip())
        st.success("API Key updated.")
        st.rerun()
        
    auth_url = f"https://www.strava.com/oauth/authorize?client_id={CLIENT_ID}&response_type=code&redirect_uri=https://share.streamlit.io&approval_prompt=force&scope=activity:read_all"
    st.markdown(f"[Re-link Strava Account]({auth_url})")

    if st.button("Clean Duplicates & Renumber Workouts", type="secondary", use_container_width=True):
        clean_and_renumber_vault()
        st.success("Vault refreshed!")
        st.rerun()
