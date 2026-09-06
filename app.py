import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests
import textwrap

# ---------------------------------------------------------
# 1. CONSUMER LIGHT-THEME UI (SAMSUNG HEALTH & STRAVA STYLE)
# ---------------------------------------------------------
st.set_page_config(page_title="AI Coach", layout="centered", page_icon="⚡")

st.markdown("""
<style>
    /* Global Clean Light Surface */
    .stApp {
        background-color: #f8fafc;
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    
    /* Prominent Top Navigation Tabs (Fix invisible text & contrast) */
    .stTabs [data-baseweb="tab-list"] {
        gap: 6px;
        background-color: #e2e8f0;
        padding: 4px;
        border-radius: 12px;
        border: 1px solid #cbd5e1;
        margin-bottom: 12px;
    }
    .stTabs [data-baseweb="tab"] {
        padding: 6px 14px;
        font-weight: 700;
        font-size: 0.85rem;
        color: #475569 !important;
        border-radius: 8px;
        background-color: transparent;
        border: none !important;
        transition: all 0.15s ease;
    }
    .stTabs [aria-selected="true"] {
        background-color: #ffffff !important;
        color: #fc5200 !important; /* Strava Signature Orange */
        box-shadow: 0 2px 4px rgba(0,0,0,0.08);
    }
    .stTabs [data-baseweb="tab-highlight"] {
        display: none !important;
    }

    /* Top Brand Header */
    .header-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 8px;
        border-bottom: 2px solid #e2e8f0;
        margin-bottom: 12px;
    }
    .brand-title {
        font-size: 1.45rem;
        font-weight: 900;
        color: #fc5200;
        letter-spacing: -0.5px;
    }
    .status-pill {
        font-size: 0.72rem;
        font-weight: 800;
        padding: 4px 10px;
        border-radius: 9999px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
    }
    .status-synced {
        background-color: #dcfce7;
        color: #15803d;
        border: 1px solid #86efac;
    }
    .status-unlinked {
        background-color: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fca5a5;
    }

    /* High-Density Card (~80px height) */
    .workout-card {
        background-color: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 12px;
        margin-bottom: 6px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    .workout-card:hover {
        border-color: #cbd5e1;
    }
    .card-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
    }
    .card-left {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
    }
    .card-title {
        font-size: 0.88rem;
        font-weight: 800;
        color: #0f172a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .tag-badge {
        font-size: 0.68rem;
        font-weight: 800;
        padding: 2px 7px;
        border-radius: 6px;
        white-space: nowrap;
    }
    .tag-ride {
        background-color: #eff6ff;
        color: #2563eb;
        border: 1px solid #bfdbfe;
    }
    .tag-run {
        background-color: #f0fdf4;
        color: #16a34a;
        border: 1px solid #bbf7d0;
    }

    /* Metric Strip */
    .metric-strip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background-color: #f8fafc;
        border-radius: 8px;
        padding: 5px 8px;
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
        font-weight: 700;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.3px;
    }

    /* Form Controls, Inputs & Button Contrast Fixes */
    div.stButton > button {
        border-radius: 10px;
        font-weight: 800;
        font-size: 0.88rem;
        border: none;
    }
    div.stButton > button[kind="primary"] {
        background-color: #fc5200;
        color: #ffffff;
    }
    div.stButton > button[kind="secondary"] {
        background-color: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
    }
    .stTextInput > div > div > input, .stTextArea textarea {
        background-color: #ffffff !important;
        color: #0f172a !important;
        border: 1px solid #cbd5e1 !important;
        border-radius: 8px !important;
    }
    .streamlit-expanderHeader {
        background-color: #ffffff !important;
        color: #0f172a !important;
        font-weight: 700 !important;
        border-radius: 8px !important;
        border: 1px solid #e2e8f0 !important;
    }
    .streamlit-expanderContent {
        background-color: #ffffff !important;
        border: 1px solid #e2e8f0 !important;
        border-top: none !important;
        border-bottom-left-radius: 8px;
        border-bottom-right-radius: 8px;
    }
    .ai-bubble {
        background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%);
        border: 1px solid #fed7aa;
        border-radius: 10px;
        padding: 10px 12px;
        margin-top: 8px;
        margin-bottom: 8px;
        color: #9a3412;
        font-size: 0.84rem;
        line-height: 1.45;
    }
</style>
""", unsafe_allow_html=True)

SVG_BIKE = """<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>"""
SVG_RUN = """<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="5" r="1.5"/><path d="m14 11 2-2-3-3-4 3 2 4-3 5 2 2 3-4 3 3"/></svg>"""
SVG_HEART = """<svg width="13" height="13" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" style="vertical-align: middle;"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>"""
SVG_BOLT = """<svg width="13" height="13" viewBox="0 0 24 24" fill="#eab308" stroke="#ca8a04" stroke-width="1.5" style="vertical-align: middle;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>"""
SVG_MOUNTAIN = """<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>"""
SVG_AI = """<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>"""

# ---------------------------------------------------------
# 2. DATABASE ENGINE, SCHEMA & DEDUPLICATION MIGRATION
# ---------------------------------------------------------
DB_FILE = "training_vault.db"

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_and_migrate_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS workouts (id INTEGER PRIMARY KEY AUTOINCREMENT)")
    
    # Check existing columns
    c.execute("PRAGMA table_info(workouts)")
    existing_cols = {row[1] for row in c.fetchall()}
    
    required_cols = {
        "strava_id": "INTEGER",
        "exercise_code": "TEXT",
        "date": "TEXT",
        "start_time_str": "TEXT",
        "end_time_str": "TEXT",
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
        "notes": "TEXT",
        "ai_analysis": "TEXT"
    }
    
    for col_name, col_type in required_cols.items():
        if col_name not in existing_cols:
            try:
                c.execute(f"ALTER TABLE workouts ADD COLUMN {col_name} {col_type}")
            except Exception:
                pass
                
    c.execute("""
    CREATE TABLE IF NOT EXISTS ai_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_type TEXT,
        sport_scope TEXT,
        reference_info TEXT,
        created_at TEXT,
        analysis_text TEXT
    )
    """)
    
    # Auto-deduplicate workouts sharing the exact same date & distance or strava_id
    c.execute("""
    DELETE FROM workouts 
    WHERE id NOT IN (
        SELECT MIN(id) 
        FROM workouts 
        GROUP BY COALESCE(strava_id, date || distance_km)
    )
    """)
    
    conn.commit()
    conn.close()

init_and_migrate_db()

CLIENT_ID = st.secrets.get("STRAVA_CLIENT_ID", "277202").strip().strip('"')
CLIENT_SECRET = st.secrets.get("STRAVA_CLIENT_SECRET", "ddcc15be9c096ea443ad20a00ece1d2ac893e73d").strip().strip('"')
DEFAULT_REFRESH = st.secrets.get("STRAVA_REFRESH_TOKEN", "f1fa3da33c8edf990b99374efe3c1890cab613a1").strip().strip('"')
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

# Auto-handle Strava OAuth code redirect
if "code" in st.query_params:
    auth_code = st.query_params["code"]
    res = requests.post("https://www.strava.com/oauth/token", data={
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": auth_code,
        "grant_type": "authorization_code"
    })
    if res.status_code == 200:
        token_data = res.json()
        set_config("strava_access_token", token_data.get("access_token"))
        set_config("strava_refresh_token", token_data.get("refresh_token"))
        st.query_params.clear()
        st.rerun()

def get_valid_token():
    refresh_token = get_config("strava_refresh_token") or DEFAULT_REFRESH
    if not refresh_token:
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

def format_time_range(dt_start, duration_sec):
    dt_end = dt_start + datetime.timedelta(seconds=duration_sec)
    date_part = f"{dt_start.day}/{dt_start.strftime('%b/%Y')}"
    # Format e.g.: 9:15AM > 12:00PM
    start_str = dt_start.strftime("%-I:%M%p")
    end_str = dt_end.strftime("%-I:%M%p")
    return date_part, f"{start_str} > {end_str}"

def renumber_all_workouts(conn):
    """Sorts all workouts chronologically and reassigns clean sequence numbers (Ride 001, Run 001)."""
    c = conn.cursor()
    c.execute("SELECT id, sport_category, date, elapsed_time_sec, moving_time_sec FROM workouts ORDER BY date ASC")
    rows = c.fetchall()
    
    ride_counter = 1
    run_counter = 1
    
    for row in rows:
        w_id = row[0]
        cat = row[1] or "Ride"
        dt_raw = row[2]
        elapsed = row[3] or row[4] or 0
        
        try:
            dt_obj = datetime.datetime.fromisoformat(dt_raw)
        except Exception:
            dt_obj = datetime.datetime.now()
            
        date_part, time_range = format_time_range(dt_obj, elapsed)
        
        if cat == "Ride":
            code = f"Ride {ride_counter:03d} - {date_part} - {time_range}"
            ride_counter += 1
        else:
            code = f"Run {run_counter:03d} - {date_part} - {time_range}"
            run_counter += 1
            
        c.execute("UPDATE workouts SET exercise_code=? WHERE id=?", (code, w_id))
    conn.commit()

def sync_strava():
    token = get_valid_token()
    if not token:
        st.error("Strava session expired or not authenticated. Reconnect below.")
        return -1
        
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get("https://www.strava.com/api/v3/athlete/activities?per_page=80", headers=headers)
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
        # Walks and runs grouped together as requested
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
        cal = int(act.get("calories", 0)) if act.get("calories") else 0
        title = act.get("name", "Training Session")
        
        conn.execute("""
        INSERT INTO workouts (
            strava_id, exercise_code, date, activity_type, sport_category, title, distance_km, 
            moving_time_str, moving_time_sec, elapsed_time_sec, avg_speed_kmh, max_speed_kmh, 
            pace_str, elevation_gain_m, elev_high_m, elev_low_m, avg_hr, max_hr, avg_power_w, 
            max_power_w, norm_power_w, kilojoules, avg_cadence, calories, suffer_score, notes, ai_analysis
        )
        VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')
        """, (s_id, date_str, act_type, sport_cat, title, dist_km, time_str, m_time, e_time, avg_spd, max_spd, pace_str, elev, elev_high, elev_low, avg_hr, max_hr, watts, max_watts, norm_watts, kj, cadence, cal, suffer))
        new_count += 1
        
    # Renumber sequentially without gaps or duplicates
    renumber_all_workouts(conn)
    conn.commit()
    conn.close()
    return new_count

# ---------------------------------------------------------
# 3. GEMINI COACHING ENGINE & PROGRESSIVE REASONING
# ---------------------------------------------------------
def call_gemini(prompt):
    if not GEMINI_KEY:
        st.error("GEMINI_API_KEY missing in Secrets.")
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
    payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    res = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
    if res.status_code == 200:
        return res.json()["candidates"][0]["content"]["parts"][0]["text"]
    else:
        st.error(f"Gemini API Error ({res.status_code}): {res.text}")
        return None

def generate_workout_ai_debrief(workout_id):
    conn = get_db()
    # Fetch target workout
    target = conn.execute("SELECT * FROM workouts WHERE id=?", (workout_id,)).fetchone()
    if not target:
        conn.close()
        return None
        
    # Fetch up to 3 prior workouts of the same sport category for progressive comparison
    priors = conn.execute("""
        SELECT * FROM workouts 
        WHERE sport_category=? AND date < ? 
        ORDER BY date DESC LIMIT 3
    """, (target['sport_category'], target['date'])).fetchall()
    conn.close()
    
    prior_summary = ""
    if priors:
        prior_summary = "PRIOR SESSIONS IN CHRONOLOGICAL SEQUENCE (Oldest to Most Recent):\n"
        for p in reversed(priors):
            prior_summary += f"- {p['exercise_code']} | Dist: {p['distance_km']}k | Time: {p['moving_time_str']} | Avg Spd/Pace: {p['avg_speed_kmh']} km/h ({p['pace_str']}) | HR: {p['avg_hr']} bpm (Peak: {p['max_hr']}) | Power: {p['avg_power_w']}W | Elev: {p['elevation_gain_m']}m\n"
    else:
        prior_summary = "This is the initial baseline session recorded in this category.\n"
        
    prompt = f"""
You are an expert sports scientist and cycling/running coach analyzing athlete Mustafa (190 cm, ~115 kg, training on a Kron XC150 MTB with flat pedals, building an aerobic base to transition to an aero road bike).
Max Heart Rate: 202 bpm. Estimated FTP: 220 W.

CURRENT SESSION TELEMETRY:
- Session: {target['exercise_code']}
- Category: {target['sport_category']} ({target['activity_type']})
- Distance: {target['distance_km']} km | Moving Duration: {target['moving_time_str']}
- Average Speed: {target['avg_speed_kmh']} km/h | Max Speed: {target['max_speed_kmh']} km/h
- Heart Rate Profile: Avg {target['avg_hr']} bpm | Peak {target['max_hr']} bpm ({round((target['avg_hr']/202)*100, 1)}% of max HR)
- Estimated Power: Avg {target['avg_power_w']} W | Norm Power: {target['norm_power_w']} W | Max Power: {target['max_power_w']} W
- Cadence: {target['avg_cadence']} RPM | Mechanical Work: {target['kilojoules']} kJ
- Elevation: Gain {target['elevation_gain_m']} m | High {target['elev_high_m']} m | Low {target['elev_low_m']} m
- Suffer Score: {target['suffer_score']}

{prior_summary}

TASK:
Write an elite, concise, highly structured physiological debrief (3-4 bullet points max):
1. **Cardiovascular & Decoupling Audit**: Relate heart rate drift to speed/pace and duration. Is the aerobic engine holding or did it spike into Zone 5 redline?
2. **Torque vs Cadence & Elevation**: Evaluate mechanical stress, watt output, or running pace relative to the terrain gradient.
3. **Progressive Delta & Actionable Takeaway**: Explicitly compare this session to the prior session(s). What improved, what decayed, and what is the exact tactical cue for next time?
"""
    analysis = call_gemini(prompt)
    if analysis:
        conn = get_db()
        conn.execute("UPDATE workouts SET ai_analysis=? WHERE id=?", (analysis, workout_id))
        conn.commit()
        conn.close()
    return analysis

# ---------------------------------------------------------
# 4. APPLICATION HEADER & CONTRAST NAVIGATION BAR
# ---------------------------------------------------------
is_connected = bool(get_config("strava_refresh_token") or DEFAULT_REFRESH)
status_html = '<span class="status-pill status-synced">● STRAVA CONNECTED</span>' if is_connected else '<span class="status-pill status-unlinked">● DISCONNECTED</span>'

st.markdown(f"""
<div class="header-bar">
    <span class="brand-title">AI Coach</span>
    {status_html}
</div>
""", unsafe_allow_html=True)

tab_feed, tab_analytics, tab_compare, tab_progress = st.tabs(["Feed", "Graphs", "Compare", "Reports"])

# ---------------------------------------------------------
# TAB 1: CONSUMER HIGH-DENSITY FEED
# ---------------------------------------------------------
with tab_feed:
    col_sync, col_renumber = st.columns([1.6, 1.4])
    with col_sync:
        if st.button("Sync Strava", type="primary", use_container_width=True):
            with st.spinner("Syncing latest sessions..."):
                added = sync_strava()
                if added > 0:
                    st.success(f"+{added} New Sessions!")
                    st.rerun()
                elif added == 0:
                    st.info("Vault is up to date.")
    with col_renumber:
        # One-touch renumber and deduplicate utility
        if st.button("Clean & Renumber Codes", type="secondary", use_container_width=True):
            conn = get_db()
            init_and_migrate_db()
            renumber_all_workouts(conn)
            conn.close()
            st.success("Cleaned duplicates and renumbered chronologically!")
            st.rerun()

    filter_col1, filter_col2 = st.columns([1.5, 1.5])
    with filter_col1:
        view_filter = st.selectbox("Category Filter", ["All Activities", "Rides Only", "Runs & Walks"], label_visibility="collapsed")
    with filter_col2:
        batch_ai = st.button("Auto-Analyze All Sessions", type="secondary", use_container_width=True, help="Generates chronological AI notes for all unanalyzed workouts")
        if batch_ai:
            conn = get_db()
            unanalyzed = conn.execute("SELECT id FROM workouts WHERE ai_analysis IS NULL OR ai_analysis = '' ORDER BY date ASC").fetchall()
            conn.close()
            if unanalyzed:
                prog_bar = st.progress(0)
                for i, row in enumerate(unanalyzed):
                    generate_workout_ai_debrief(row[0])
                    prog_bar.progress((i + 1) / len(unanalyzed))
                st.success("All workouts analyzed!")
                st.rerun()
            else:
                st.info("All workouts already have AI analyses.")

    conn = get_db()
    df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    if not df.empty:
        if view_filter == "Rides Only":
            df = df[df['sport_category'] == 'Ride']
        elif view_filter == "Runs & Walks":
            df = df[df['sport_category'] == 'Run']

    if df.empty:
        st.info("No activities found. Tap 'Sync Strava' to load your training history.")
    else:
        for _, r in df.iterrows():
            w_id = r['id']
            sport = r.get('sport_category', 'Ride') or 'Ride'
            is_run = (sport == 'Run')
            
            icon_svg = SVG_RUN if is_run else SVG_BIKE
            tag_class = "tag-run" if is_run else "tag-ride"
            
            hr_val = f"{int(r['avg_hr'])}" if pd.notna(r.get('avg_hr')) and r['avg_hr'] > 0 else "--"
            elev_val = f"{int(r['elevation_gain_m'])}m" if pd.notna(r.get('elevation_gain_m')) else "--"
            dist_val = f"{r['distance_km']:.1f}k" if pd.notna(r.get('distance_km')) else "--"
            time_val = str(r.get('moving_time_str', '--'))
            
            # Primary & secondary metrics
            if is_run:
                primary_metric_lbl = "Pace"
                primary_metric_val = r.get('pace_str') or calc_pace(r.get('moving_time_sec', 0), r.get('distance_km', 0))
                sec_metric_lbl = "Cadence"
                sec_metric_val = f"{int(r['avg_cadence'] * 2)} spm" if pd.notna(r.get('avg_cadence')) and r['avg_cadence'] > 0 else "--"
            else:
                primary_metric_lbl = "Speed"
                primary_metric_val = f"{r.get('avg_speed_kmh', 0.0):.1f} <span style='font-size:0.62rem;color:#64748b;'>km/h</span>"
                sec_metric_lbl = "Power"
                sec_metric_val = f"{int(r['avg_power_w'])}W" if pd.notna(r.get('avg_power_w')) and r['avg_power_w'] > 0 else "--"

            # Clean workout title matching user schema: Ride 001 - 5/Sep/2026 - 4:36PM > 4:50PM
            disp_code = r.get('exercise_code')
            if not disp_code or " - " not in disp_code:
                disp_code = f"{r.get('exercise_code', '')} {r.get('date', '')}"

            card_html = textwrap.dedent(f"""
            <div class="workout-card">
                <div class="card-top">
                    <div class="card-left">
                        {icon_svg}
                        <span class="card-title">{disp_code}</span>
                    </div>
                    <span class="tag-badge {tag_class}">{sport.upper()}</span>
                </div>
                <div class="metric-strip">
                    <div class="metric-cell"><div class="metric-num">{dist_val}</div><div class="metric-lbl">Dist</div></div>
                    <div class="metric-cell"><div class="metric-num">{time_val}</div><div class="metric-lbl">Time</div></div>
                    <div class="metric-cell"><div class="metric-num">{primary_metric_val}</div><div class="metric-lbl">{primary_metric_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-num">{sec_metric_val}</div><div class="metric-lbl">{sec_metric_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-num">{SVG_HEART} {hr_val}</div><div class="metric-lbl">HR</div></div>
                    <div class="metric-cell"><div class="metric-num">{SVG_MOUNTAIN} {elev_val}</div><div class="metric-lbl">Asc</div></div>
                </div>
            </div>
            """)
            st.markdown(card_html, unsafe_allow_html=True)
            
            with st.expander(f"Inspect Telemetry & AI Notes"):
                # Detailed telemetry metrics grid
                t1, t2, t3, t4 = st.columns(4)
                t1.metric("Max Speed", f"{r.get('max_speed_kmh', 0.0):.1f} km/h")
                t2.metric("Peak HR", f"{r.get('max_hr', 0)} bpm")
                t3.metric("Work (kJ)", f"{r.get('kilojoules', 0.0):.0f} kJ")
                t4.metric("Suffer Score", f"{r.get('suffer_score', 0)}")

                # In-Session Telemetry Comparison Chart
                st.markdown("##### Session Effort Profile")
                chart_data = pd.DataFrame({
                    "Metric": ["Avg Speed (km/h)", "Peak Speed (km/h)", "Avg Power / 10", "Avg HR / 10"],
                    "Value": [
                        r.get('avg_speed_kmh', 0.0), 
                        r.get('max_speed_kmh', 0.0), 
                        r.get('avg_power_w', 0.0) / 10.0, 
                        r.get('avg_hr', 0.0) / 10.0
                    ]
                }).set_index("Metric")
                st.bar_chart(chart_data, height=160)

                # AI Coaching Debrief Section
                st.markdown(f"##### {SVG_AI} AI Coach Telemetry Breakdown", unsafe_allow_html=True)
                existing_ai = r.get('ai_analysis')
                if existing_ai:
                    st.markdown(f'<div class="ai-bubble">{existing_ai}</div>', unsafe_allow_html=True)
                else:
                    st.caption("No AI debrief generated for this session yet.")
                
                # Button to generate/refresh AI analysis for this session
                if st.button("Generate / Refresh AI Analysis", key=f"ai_btn_{w_id}", type="primary"):
                    with st.spinner("Analyzing cardiovascular decoupling and mechanical torque..."):
                        new_ai = generate_workout_ai_debrief(w_id)
                        if new_ai:
                            st.success("Analysis complete!")
                            st.rerun()

                # User Field Notes
                note_input = st.text_input("Athlete Field Note", value=r.get('notes', ''), key=f"note_in_{w_id}")
                if st.button("Save Field Note", key=f"save_n_{w_id}", type="secondary"):
                    conn = get_db()
                    conn.execute("UPDATE workouts SET notes=? WHERE id=?", (note_input, w_id))
                    conn.commit()
                    conn.close()
                    st.success("Note saved.")
                    st.rerun()

# ---------------------------------------------------------
# TAB 2: INTERACTIVE & CLEAN METRIC CHARTS
# ---------------------------------------------------------
with tab_analytics:
    st.subheader("Performance Telemetry")
    conn = get_db()
    df_all = pd.read_sql_query("SELECT * FROM workouts ORDER BY date ASC", conn)
    conn.close()
    
    if len(df_all) >= 2:
        df_all['date_clean'] = pd.to_datetime(df_all['date']).dt.strftime('%m/%d')
        sport_mode = st.radio("Sport Focus", ["Cycling Telemetry", "Running & Walking Telemetry"], horizontal=True)
        
        if "Cycling" in sport_mode:
            rides = df_all[df_all['sport_category'] == 'Ride']
            if len(rides) >= 2:
                st.markdown("#### Speed Progression (Avg vs Peak km/h)")
                st.line_chart(rides.set_index("date_clean")[["avg_speed_kmh", "max_speed_kmh"]])
                
                valid_power = rides[rides['avg_power_w'] > 0]
                if not valid_power.empty:
                    st.markdown("#### Watts Output vs Cardiovascular Response")
                    st.line_chart(valid_power.set_index("date_clean")[["avg_power_w", "avg_hr"]])
                st.markdown("#### Cycling Ascent Volume (Meters Climbed)")
                st.bar_chart(rides.set_index("date_clean")[["elevation_gain_m"]])
            else:
                st.info("Need at least 2 cycling sessions logged to plot charts.")
        else:
            runs = df_all[df_all['sport_category'] == 'Run']
            if len(runs) >= 2:
                st.markdown("#### Running Pace Progression (Minutes per km)")
                runs['pace_min'] = runs['moving_time_sec'] / 60.0 / runs['distance_km']
                st.line_chart(runs.set_index("date_clean")[["pace_min"]])
                st.markdown("#### Running Heart Rate vs Distance")
                st.line_chart(runs.set_index("date_clean")[["avg_hr", "distance_km"]])
            else:
                st.info("Need at least 2 running/walking sessions logged to plot running charts.")
    else:
        st.info("Log or sync at least 2 sessions to populate graphs.")

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
        mode = st.radio("Mode", ["1 to 1", "1 to 2"], horizontal=True)
        w2_choice = st.selectbox("Comparison Session (2)", keys, index=min(1, len(keys)-1))
        
        w3_choice = None
        if mode == "1 to 2":
            w3_choice = st.selectbox("Comparison Session (3)", keys, index=min(2, len(keys)-1))

        selected = [options[w1_choice], options[w2_choice]]
        if w3_choice:
            selected.append(options[w3_choice])

        comp_cols = ["exercise_code", "date", "sport_category", "distance_km", "moving_time_str", "avg_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m", "kilojoules"]
        st.dataframe(pd.DataFrame(selected)[comp_cols].set_index("exercise_code"), use_container_width=True)

        if st.button("Generate Comparative AI Breakdown", type="primary", use_container_width=True):
            with st.spinner("Analyzing comparative physiological deltas..."):
                prompt = f"""
You are an expert sports physiologist analyzing athlete Mustafa (190 cm, ~115 kg, Max HR 202 bpm, Est. FTP 220 W).
Compare these specific training sessions side-by-side:

{pd.DataFrame(selected)[comp_cols].to_string()}

Provide a structured, elite coaching assessment:
1. **Pacing & Aerobic Decoupling**: Speed/pace efficiency relative to heart rate drift and cardiovascular drift.
2. **Mechanical Torque vs Cadence Profile**: Watt production or cadence sustainability across elevation gradients.
3. **Metabolic Load & Fatigue**: Compare work done (kJ) and cardiac cost.
4. **Concrete Training Takeaway**: Single most important adjustment for upcoming sessions.
"""
                verdict = call_gemini(prompt)
                if verdict:
                    st.markdown("### Physiological Verdict")
                    st.markdown(verdict)

# ---------------------------------------------------------
# TAB 4: PERIODIC REPORTS WITH SPORT CATEGORY FILTER
# ---------------------------------------------------------
with tab_progress:
    st.subheader("Periodic Progression Reviews")
    
    rep_col1, rep_col2 = st.columns(2)
    with rep_col1:
        horizon = st.selectbox("Review Window", ["Last 7 Days", "Last 30 Days", "All Time"])
    with rep_col2:
        report_category = st.selectbox("Sport Category", ["All Activities", "Rides Only", "Runs & Walks"])
    
    conn = get_db()
    p_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    if not p_df.empty:
        p_df['dt'] = pd.to_datetime(p_df['date'])
        now = datetime.datetime.now()
        
        # Apply time horizon filter
        if horizon == "Last 7 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=7))]
        elif horizon == "Last 30 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=30))]
        else:
            filtered = p_df
            
        # Apply sport category filter
        if report_category == "Rides Only":
            filtered = filtered[filtered['sport_category'] == 'Ride']
        elif report_category == "Runs & Walks":
            filtered = filtered[filtered['sport_category'] == 'Run']
            
        st.write(f"Total sessions in window ({report_category}): **{len(filtered)}**")
        
        if not filtered.empty and st.button(f"Generate {horizon} ({report_category}) Audit", type="primary", use_container_width=True):
            with st.spinner(f"Compiling {horizon} audit..."):
                summary_data = filtered[["exercise_code", "date", "sport_category", "distance_km", "moving_time_str", "avg_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m"]].to_string(index=False)
                prompt = f"""
You are an elite sports scientist evaluating athlete Mustafa's ({horizon}, {report_category}) training block.
Athlete Profile: 190 cm, ~115 kg, Max HR 202 bpm, Est. FTP 220 W.

Session Data:
{summary_data}

Provide an executive, sports-science progression report:
1. **Volume & Consistency Adherence**: Work done, distance accumulated, and mechanical load.
2. **Aerobic Base Building vs Zone 5 Redline Fatigue**: Analyze cardiovascular drift and whether the sessions are consolidating Zone 2 fat-oxidation or burning high-glycolytic matches.
3. **Mechanical Power & Speed Benchmarks**: Performance shifts across climbs and flat endurance segments.
4. **Prescription & Adjustments**: Clear guidance on cadence targets, gearing, and recovery before the next cycle.
"""
                audit = call_gemini(prompt)
                if audit:
                    conn = get_db()
                    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                    conn.execute("INSERT INTO ai_reports (report_type, sport_scope, reference_info, created_at, analysis_text) VALUES (?, ?, ?, ?, ?)",
                                 (horizon, report_category, f"{len(filtered)} workouts", now_str, audit))
                    conn.commit()
                    conn.close()
                    st.markdown(audit)
                    
    # Display saved periodic audits
    conn = get_db()
    saved_reports = conn.execute("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 5").fetchall()
    conn.close()
    if saved_reports:
        st.markdown("---")
        st.markdown("#### Historical Progression Audits")
        for s_rep in saved_reports:
            scope_tag = s_rep['sport_scope'] if 'sport_scope' in s_rep.keys() else 'All'
            with st.expander(f"{s_rep['report_type']} ({scope_tag}) - {s_rep['created_at']}"):
                st.markdown(s_rep['analysis_text'])
