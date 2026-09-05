import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests

# ---------------------------------------------------------
# 1. MOBILE ONE UI CONFIGURATION
# ---------------------------------------------------------
st.set_page_config(page_title="Apex Vault", layout="centered", page_icon="⚡")

st.markdown("""
<style>
    .stApp {
        background-color: #0b0e14;
        color: #f0f3f6;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .metric-card {
        background: #161b22;
        border: 1px solid #30363d;
        border-radius: 16px;
        padding: 16px;
        margin-bottom: 14px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .badge-code {
        background: #238636;
        color: #ffffff;
        padding: 3px 10px;
        border-radius: 12px;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.5px;
    }
    .badge-type {
        background: #1f6feb;
        color: #ffffff;
        padding: 3px 10px;
        border-radius: 12px;
        font-size: 0.8rem;
        font-weight: 600;
        margin-left: 6px;
    }
    .stat-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-top: 10px;
        border-top: 1px solid #21262d;
        padding-top: 10px;
    }
    .stat-item {
        text-align: center;
        background: rgba(255,255,255,0.02);
        border-radius: 8px;
        padding: 6px 2px;
    }
    .stat-val {
        font-size: 1.05rem;
        font-weight: 700;
        color: #58a6ff;
    }
    .stat-lbl {
        font-size: 0.65rem;
        color: #8b949e;
        text-transform: uppercase;
    }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------
# 2. DATABASE INITIALIZATION (ZERO DUMMY EXERCISES)
# ---------------------------------------------------------
DB_FILE = "training_vault.db"

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("""
    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )
    """)
    c.execute("""
    CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strava_id INTEGER UNIQUE,
        exercise_code TEXT UNIQUE,
        date TEXT,
        activity_type TEXT,
        title TEXT,
        distance_km REAL,
        moving_time_str TEXT,
        moving_time_sec INTEGER,
        elapsed_time_sec INTEGER,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        elevation_gain_m REAL,
        elev_high_m REAL,
        elev_low_m REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        avg_power_w REAL,
        max_power_w REAL,
        norm_power_w REAL,
        kilojoules REAL,
        avg_cadence REAL,
        calories INTEGER,
        suffer_score INTEGER,
        notes TEXT
    )
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
# 3. STRAVA DEEP DATA EXTRACTION
# ---------------------------------------------------------
CLIENT_ID = st.secrets.get("STRAVA_CLIENT_ID", "277202")
CLIENT_SECRET = st.secrets.get("STRAVA_CLIENT_SECRET", "")
GEMINI_KEY = st.secrets.get("GEMINI_API_KEY", "")

def get_saved_token(key):
    conn = get_db()
    r = conn.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
    conn.close()
    return r["value"] if r else None

def save_token(key, val):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (key, str(val)))
    conn.commit()
    conn.close()

def refresh_access_token():
    refresh_token = get_saved_token("strava_refresh_token") or "11fa3da33c8edf990b99374efe3c1890cab613a1"
    res = requests.post("https://www.strava.com/oauth/token", data={
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    })
    if res.status_code == 200:
        data = res.json()
        save_token("strava_access_token", data["access_token"])
        save_token("strava_refresh_token", data["refresh_token"])
        return data["access_token"]
    return None

def generate_code(conn, activity_type, date_obj):
    prefix = "Run" if "Run" in activity_type else "Bike"
    month_str = date_obj.strftime("%b/%Y")
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM workouts WHERE exercise_code LIKE ?", (f"{prefix}-%-{month_str}",))
    count = c.fetchone()[0] + 1
    return f"{prefix}-{count:03d}-{month_str}"

def sync_strava_deep():
    token = refresh_access_token()
    if not token:
        st.error("Could not authenticate with Strava. Check Secrets.")
        return 0
    
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get("https://www.strava.com/api/v3/athlete/activities?per_page=60", headers=headers)
    if res.status_code != 200:
        st.error(f"Strava Sync Error ({res.status_code}): {res.text}")
        return 0
    
    activities = res.json()
    conn = get_db()
    new_count = 0
    
    for act in reversed(activities):
        s_id = act["id"]
        exists = conn.execute("SELECT id FROM workouts WHERE strava_id=?", (s_id,)).fetchone()
        if exists:
            continue
        
        act_type = "Ride (MTB)" if act["type"] in ["Ride", "MountainBikeRide", "EBikeRide"] else "Run (Road)"
        dt_raw = act["start_date_local"]
        dt_obj = datetime.datetime.fromisoformat(dt_raw.replace("Z", ""))
        date_str = dt_obj.strftime("%Y-%m-%d %H:%M")
        
        code = generate_code(conn, act_type, dt_obj)
        dist_km = round(act.get("distance", 0.0) / 1000.0, 2)
        m_time = act.get("moving_time", 0)
        e_time = act.get("elapsed_time", 0)
        m, s = divmod(m_time, 60)
        time_str = f"{m}:{s:02d}"
        
        avg_spd = round(act.get("average_speed", 0.0) * 3.6, 1)
        max_spd = round(act.get("max_speed", 0.0) * 3.6, 1)
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
        title = act.get("name", "Strava Session")
        
        conn.execute("""
        INSERT INTO workouts (
            strava_id, exercise_code, date, activity_type, title, distance_km, moving_time_str, 
            moving_time_sec, elapsed_time_sec, avg_speed_kmh, max_speed_kmh, elevation_gain_m, 
            elev_high_m, elev_low_m, avg_hr, max_hr, avg_power_w, max_power_w, norm_power_w, 
            kilojoules, avg_cadence, calories, suffer_score, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Imported via Strava API')
        """, (s_id, code, date_str, act_type, title, dist_km, time_str, m_time, e_time, avg_spd, max_spd, elev, elev_high, elev_low, avg_hr, max_hr, watts, max_watts, norm_watts, kj, cadence, cal, suffer))
        new_count += 1
        
    conn.commit()
    conn.close()
    return new_count

# ---------------------------------------------------------
# 4. GEMINI API ENGINE
# ---------------------------------------------------------
def call_gemini(prompt):
    if not GEMINI_KEY:
        st.error("GEMINI_API_KEY is not set in Secrets.")
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
    payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    res = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
    if res.status_code == 200:
        return res.json()["candidates"][0]["content"]["parts"][0]["text"]
    else:
        st.error(f"Gemini API Error ({res.status_code}): {res.text}")
        return None

# ---------------------------------------------------------
# 5. UI TABS & NAVIGATION
# ---------------------------------------------------------
st.title("⚡ Apex Vault")

tab_feed, tab_analytics, tab_compare, tab_progress = st.tabs(["📋 Feed", "📊 Graphs", "⚖️ Compare", "📈 Reports"])

# --- TAB 1: ACTIVITY FEED ---
with tab_feed:
    col_sync, col_count = st.columns([2, 1])
    with col_sync:
        if st.button("🔄 Sync All from Strava", use_container_width=True, type="primary"):
            with st.spinner("Downloading full Strava metrics..."):
                added = sync_strava_deep()
                if added > 0:
                    st.success(f"Added {added} new activities!")
                    st.rerun()
                else:
                    st.info("Vault is completely up to date.")

    conn = get_db()
    df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    with col_count:
        st.metric("Total Activities", f"{len(df)}")

    st.markdown("---")
    if df.empty:
        st.info("No workouts found yet. Tap 'Sync All from Strava' above to load your training history.")
    else:
        for _, r in df.iterrows():
            st.markdown(f"""
            <div class="metric-card">
                <div>
                    <span class="badge-code">{r['exercise_code']}</span>
                    <span class="badge-type">{r['activity_type']}</span>
                </div>
                <h4 style="margin: 8px 0 2px 0;">{r['title']}</h4>
                <div style="font-size: 0.78rem; color: #8b949e;">📅 {r['date']}</div>
                
                <div class="stat-grid">
                    <div class="stat-item"><div class="stat-val">{r['distance_km']:.1f} km</div><div class="stat-lbl">Distance</div></div>
                    <div class="stat-item"><div class="stat-val">{r['moving_time_str']}</div><div class="stat-lbl">Duration</div></div>
                    <div class="stat-item"><div class="stat-val">{r['avg_speed_kmh']:.1f}</div><div class="stat-lbl">Avg km/h</div></div>
                    <div class="stat-item"><div class="stat-val">{r['max_speed_kmh']:.1f}</div><div class="stat-lbl">Max km/h</div></div>
                    <div class="stat-item"><div class="stat-val">{r['avg_hr'] if r['avg_hr'] > 0 else '--'}</div><div class="stat-lbl">Avg HR</div></div>
                    <div class="stat-item"><div class="stat-val">{r['max_hr'] if r['max_hr'] > 0 else '--'}</div><div class="stat-lbl">Max HR</div></div>
                    <div class="stat-item"><div class="stat-val">{r['avg_power_w'] if r['avg_power_w'] > 0 else '--'} W</div><div class="stat-lbl">Avg Power</div></div>
                    <div class="stat-item"><div class="stat-val">{r['norm_power_w'] if r['norm_power_w'] > 0 else '--'} W</div><div class="stat-lbl">Norm Power</div></div>
                    <div class="stat-item"><div class="stat-val">{r['avg_cadence'] if r['avg_cadence'] > 0 else '--'}</div><div class="stat-lbl">Cadence RPM</div></div>
                    <div class="stat-item"><div class="stat-val">{r['elevation_gain_m']:.0f} m</div><div class="stat-lbl">Ascent</div></div>
                    <div class="stat-item"><div class="stat-val">{r['kilojoules'] if r['kilojoules'] > 0 else '--'}</div><div class="stat-lbl">Work (kJ)</div></div>
                    <div class="stat-item"><div class="stat-val">{r['suffer_score'] if r['suffer_score'] > 0 else '--'}</div><div class="stat-lbl">Suffer Score</div></div>
                </div>
            </div>
            """, unsafe_allow_html=True)

# --- TAB 2: DETAILED GRAPHS & VISUALIZATIONS ---
with tab_analytics:
    st.subheader("📊 Performance Trends")
    conn = get_db()
    chart_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date ASC", conn)
    conn.close()
    
    if len(chart_df) >= 2:
        chart_df['date_short'] = pd.to_datetime(chart_df['date']).dt.strftime('%m/%d')
        
        st.markdown("#### Speed Progression (Avg vs Peak)")
        st.line_chart(chart_df.set_index("date_short")[["avg_speed_kmh", "max_speed_kmh"]])
        
        st.markdown("#### Cardiovascular Demand vs Power Output")
        valid_power = chart_df[chart_df['avg_power_w'] > 0]
        if not valid_power.empty:
            st.line_chart(valid_power.set_index("date_short")[["avg_power_w", "avg_hr"]])
        else:
            st.caption("Power data will plot automatically as power readings are logged.")
            
        st.markdown("#### Volume Breakdown (Distance & Ascent)")
        st.bar_chart(chart_df.set_index("date_short")[["distance_km", "elevation_gain_m"]])
    else:
        st.info("Log at least 2 sessions to generate trend charts.")

# --- TAB 3: 1-TO-1 & 1-TO-2 COMPARISONS ---
with tab_compare:
    st.subheader("⚖️ Side-by-Side Analysis")
    conn = get_db()
    c_workouts = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    if len(c_workouts) < 2:
        st.warning("You need at least 2 workouts to run a comparison.")
    else:
        opts = {f"{r['exercise_code']} - {r['title']} ({r['date']})": r for _, r in c_workouts.iterrows()}
        keys = list(opts.keys())

        w1_key = st.selectbox("Baseline Workout (1)", keys, index=0)
        mode = st.radio("Mode", ["1 to 1", "1 to 2"], horizontal=True)
        w2_key = st.selectbox("Comparison Workout (2)", keys, index=min(1, len(keys)-1))
        
        w3_key = None
        if mode == "1 to 2":
            w3_key = st.selectbox("Second Comparison Workout (3)", keys, index=min(2, len(keys)-1))

        selected = [opts[w1_key], opts[w2_key]]
        if w3_key:
            selected.append(opts[w3_key])

        comp_cols = ["exercise_code", "date", "distance_km", "avg_speed_kmh", "max_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "norm_power_w", "avg_cadence", "elevation_gain_m", "kilojoules"]
        comp_display = pd.DataFrame(selected)[comp_cols].set_index("exercise_code")
        st.dataframe(comp_display, use_container_width=True)

        if st.button("🤖 Run In-Depth AI Comparison", type="primary", use_container_width=True):
            with st.spinner("AI evaluating biomechanical and metabolic differences..."):
                prompt = f"""
You are an expert sports physiologist analyzing athlete Mustafa (190 cm, ~115 kg, transitioning from MTB to aero road bike).
Analyze and contrast these specific workouts:

{comp_display.to_string()}

Provide an elite coaching comparison:
1. **Pacing & Aerobic Efficiency**: Speed relative to HR decoupling and cadence stability.
2. **Torque vs Cadence Profile**: How mechanical power output shifted under gradient/ascent.
3. **Metabolic Load**: Work done (kJ) and cardiac stress.
4. **Concrete Training Takeaway**: Exactly what adjustment to make in the next block.
"""
                verdict = call_gemini(prompt)
                if verdict:
                    st.markdown("### 📋 AI Comparative Verdict")
                    st.markdown(verdict)

# --- TAB 4: PROGRESS AUDITS ---
with tab_progress:
    st.subheader("📈 Periodic Progression Reviews")
    horizon = st.selectbox("Select Timeframe", ["Last 7 Days", "Last 30 Days", "All Time"])
    
    conn = get_db()
    all_acts = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    if not all_acts.empty:
        all_acts['dt'] = pd.to_datetime(all_acts['date'])
        now = datetime.datetime.now()
        
        if horizon == "Last 7 Days":
            filtered = all_acts[all_acts['dt'] >= (now - datetime.timedelta(days=7))]
        elif horizon == "Last 30 Days":
            filtered = all_acts[all_acts['dt'] >= (now - datetime.timedelta(days=30))]
        else:
            filtered = all_acts
            
        st.write(f"Found **{len(filtered)} activities** in this horizon.")
        if not filtered.empty and st.button(f"🤖 Compile {horizon} AI Progression Audit", type="primary", use_container_width=True):
            with st.spinner(f"Synthesizing {horizon} training data..."):
                summary_str = filtered[["exercise_code", "date", "activity_type", "distance_km", "moving_time_str", "avg_speed_kmh", "max_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m", "kilojoules"]].to_string(index=False)
                prompt = f"""
You are an elite cycling coach reviewing athlete Mustafa's ({horizon}) training progression.
Session data:
{summary_str}

Provide a structured, rigorous assessment:
1. **Executive Load Assessment**: Total volume, mechanical work (kJ), and adherence.
2. **Cardiovascular Adaptation**: Aerobic base building vs anaerobic strain (Zone 2 efficiency vs Zone 5 redline).
3. **Peak Benchmarks**: Power spikes, speed ceilings, and climbing capacity.
4. **Prescription**: Exact target cadence, power zones, and caloric strategy for the upcoming block.
"""
                audit = call_gemini(prompt)
                if audit:
                    conn = get_db()
                    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                    conn.execute("INSERT INTO ai_reports (report_type, reference_info, created_at, analysis_text) VALUES (?, ?, ?, ?)",
                                 (horizon, f"{len(filtered)} workouts", now_str, audit))
                    conn.commit()
                    conn.close()
                    st.markdown("### 🏆 AI Progression Report")
                    st.markdown(audit)
                    st.success("Report saved to your permanent vault!")

