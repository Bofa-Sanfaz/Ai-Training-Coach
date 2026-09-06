import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests
import textwrap

# ---------------------------------------------------------
# 1. LIGHT-THEME CONSUMER UI (SAMSUNG HEALTH & STRAVA STYLE)
# ---------------------------------------------------------
st.set_page_config(page_title="AI Coach", layout="centered", page_icon="⚡")

st.markdown("""
<style>
    /* Clean Light Theme */
    .stApp {
        background-color: #f8fafc;
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    
    /* Header Bar */
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
        color: #fc5200; /* Strava Orange */
        letter-spacing: -0.5px;
    }
    .status-pill {
        font-size: 0.72rem;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 9999px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
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

    /* High-Density Card (~75px height) */
    .workout-card {
        background-color: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 8px 12px;
        margin-bottom: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
        transition: transform 0.1s ease, box-shadow 0.1s ease;
    }
    .workout-card:active {
        transform: scale(0.99);
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
        font-weight: 700;
        color: #1e293b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 170px;
    }
    .card-date {
        font-size: 0.68rem;
        font-weight: 500;
        color: #64748b;
    }
    .tag-badge {
        font-size: 0.68rem;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 6px;
    }
    .tag-ride {
        background-color: #eff6ff;
        color: #2563eb;
        border: 1px solid #dbeafe;
    }
    .tag-run {
        background-color: #f0fdf4;
        color: #16a34a;
        border: 1px solid #dcfce7;
    }

    /* Stat Strip */
    .metric-strip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background-color: #f8fafc;
        border-radius: 8px;
        padding: 4px 10px;
        margin-top: 4px;
        border: 1px solid #f1f5f9;
    }
    .metric-cell {
        text-align: center;
        flex: 1;
    }
    .metric-num {
        font-size: 0.84rem;
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

    /* Clean Streamlit component styling */
    div.stButton > button {
        border-radius: 10px;
        font-weight: 700;
        font-size: 0.88rem;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
        border-bottom: 1px solid #e2e8f0;
    }
    .stTabs [data-baseweb="tab"] {
        padding-top: 6px;
        padding-bottom: 6px;
        font-weight: 600;
        font-size: 0.86rem;
    }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------
# 2. VECTOR SVG FIGURES (NO EMOJIS)
# ---------------------------------------------------------
SVG_BIKE = """<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>"""
SVG_RUN = """<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><circle cx="12" cy="5" r="1.5"/><path d="m14 11 2-2-3-3-4 3 2 4-3 5 2 2 3-4 3 3"/></svg>"""
SVG_HEART = """<svg width="12" height="12" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="2" style="vertical-align: middle;"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>"""
SVG_BOLT = """<svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" stroke="#ca8a04" stroke-width="1.5" style="vertical-align: middle;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>"""
SVG_MOUNTAIN = """<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="m8 3 4 8 5-5 5 15H2L8 3z"/></svg>"""

# ---------------------------------------------------------
# 3. DATABASE ENGINE & AUTOMATIC MIGRATION
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
    
    # Check existing columns to prevent KeyError
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
                
    # Backfill sport_category and pace_str if they were missing or NULL
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

init_and_migrate_db()

# ---------------------------------------------------------
# 4. CONFIG & AUTH CREDENTIALS
# ---------------------------------------------------------
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

def generate_code(conn, sport_cat, date_obj):
    month_str = date_obj.strftime("%b/%Y")
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM workouts WHERE exercise_code LIKE ?", (f"{sport_cat}-%-{month_str}",))
    count = c.fetchone()[0] + 1
    return f"{sport_cat}-{count:03d}-{month_str}"

def sync_strava():
    token = get_valid_token()
    if not token:
        st.error("Strava session expired or not authenticated. Reconnect below.")
        return -1
        
    headers = {"Authorization": f"Bearer {token}"}
    res = requests.get("https://www.strava.com/api/v3/athlete/activities?per_page=60", headers=headers)
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
            
        code = generate_code(conn, sport_cat, dt_obj)
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
            max_power_w, norm_power_w, kilojoules, avg_cadence, calories, suffer_score, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
        """, (s_id, code, date_str, act_type, sport_cat, title, dist_km, time_str, m_time, e_time, avg_spd, max_spd, pace_str, elev, elev_high, elev_low, avg_hr, max_hr, watts, max_watts, norm_watts, kj, cadence, cal, suffer))
        new_count += 1
        
    conn.commit()
    conn.close()
    return new_count

# ---------------------------------------------------------
# 5. GEMINI REASONING ENGINE
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

# ---------------------------------------------------------
# 6. APPLICATION HEADER & SYNC BAR
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
        view_filter = st.selectbox("Filter", ["All", "Rides Only", "Runs Only"], label_visibility="collapsed")

    conn = get_db()
    df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()

    if not df.empty:
        # Filter based on safe column fallback
        if "sport_category" in df.columns:
            if view_filter == "Rides Only":
                df = df[df['sport_category'] == 'Ride']
            elif view_filter == "Runs Only":
                df = df[df['sport_category'] == 'Run']

    if df.empty:
        st.info("No activities found. Tap 'Sync Strava' to load your history.")
    else:
        for _, r in df.iterrows():
            sport = r.get('sport_category', 'Ride') if pd.notna(r.get('sport_category')) else 'Ride'
            is_run = (sport == 'Run')
            
            icon_svg = SVG_RUN if is_run else SVG_BIKE
            tag_class = "tag-run" if is_run else "tag-ride"
            
            hr_val = f"{int(r['avg_hr'])}" if pd.notna(r.get('avg_hr')) and r['avg_hr'] > 0 else "--"
            elev_val = f"{int(r['elevation_gain_m'])}m" if pd.notna(r.get('elevation_gain_m')) else "--"
            dist_val = f"{r['distance_km']:.1f}k" if pd.notna(r.get('distance_km')) else "--"
            time_val = str(r.get('moving_time_str', '--'))
            
            # Contextual primary metrics
            if is_run:
                # Pace for runners
                pace_display = r.get('pace_str', '')
                if not pace_display or pace_display == '--':
                    pace_display = calc_pace(r.get('moving_time_sec', 0), r.get('distance_km', 0))
                primary_metric_lbl = "Pace"
                primary_metric_val = pace_display
            else:
                # Speed for cyclists
                primary_metric_lbl = "Speed"
                primary_metric_val = f"{r.get('avg_speed_kmh', 0.0):.1f} <span style='font-size:0.62rem;color:#64748b;'>km/h</span>"
                
            # Secondary metric
            if is_run:
                sec_metric_lbl = "Cadence"
                sec_metric_val = f"{int(r['avg_cadence'] * 2)} spm" if pd.notna(r.get('avg_cadence')) and r['avg_cadence'] > 0 else "--"
            else:
                sec_metric_lbl = "Power"
                sec_metric_val = f"{int(r['avg_power_w'])}W" if pd.notna(r.get('avg_power_w')) and r['avg_power_w'] > 0 else "--"

            card_html = textwrap.dedent(f"""
            <div class="workout-card">
                <div class="card-top">
                    <div class="card-left">
                        {icon_svg}
                        <span class="card-title">{r.get('title', 'Workout')}</span>
                        <span class="tag-badge {tag_class}">{r.get('exercise_code', '')}</span>
                    </div>
                    <span class="card-date">{r.get('date', '')}</span>
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
            
            with st.expander(f"View {r.get('exercise_code', '')} telemetry & field notes"):
                c1, c2, c3 = st.columns(3)
                c1.write(f"**Max Speed:** {r.get('max_speed_kmh', 0.0):.1f} km/h")
                c2.write(f"**Peak HR:** {r.get('max_hr', 0)} bpm")
                c3.write(f"**Work Done:** {r.get('kilojoules', 0.0)} kJ")
                note_input = st.text_input("Workout Field Note", value=r.get('notes', ''), key=f"note_{r.get('id')}")
                if st.button("Save Note", key=f"btn_n_{r.get('id')}"):
                    conn = get_db()
                    conn.execute("UPDATE workouts SET notes=? WHERE id=?", (note_input, r.get('id')))
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
        sport_mode = st.radio("Sport Focus", ["Cycling Telemetry", "Running Telemetry"], horizontal=True)
        
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
                st.markdown("#### Running Pace History (Minutes per km)")
                runs['pace_min'] = runs['moving_time_sec'] / 60.0 / runs['distance_km']
                st.line_chart(runs.set_index("date_clean")[["pace_min"]])
                st.markdown("#### Running Heart Rate vs Distance")
                st.line_chart(runs.set_index("date_clean")[["avg_hr", "distance_km"]])
            else:
                st.info("Need at least 2 running sessions logged to plot running charts.")
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
        options = {f"{r['exercise_code']} - {r['title']} ({r['date']})": r for _, r in c_df.iterrows()}
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
                    st.markdown("### Physiological Verdict")
                    st.markdown(verdict)

# ---------------------------------------------------------
# TAB 4: PROGRESS REPORTS
# ---------------------------------------------------------
with tab_progress:
    st.subheader("Periodic Progression Reviews")
    horizon = st.selectbox("Review Window", ["Last 7 Days", "Last 30 Days", "All Time"])
    
    conn = get_db()
    p_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    if not p_df.empty:
        p_df['dt'] = pd.to_datetime(p_df['date'])
        now = datetime.datetime.now()
        
        if horizon == "Last 7 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=7))]
        elif horizon == "Last 30 Days":
            filtered = p_df[p_df['dt'] >= (now - datetime.timedelta(days=30))]
        else:
            filtered = p_df
            
        st.write(f"Total sessions in window: **{len(filtered)}**")
        if not filtered.empty and st.button(f"Generate {horizon} Audit", type="primary", use_container_width=True):
            with st.spinner(f"Compiling {horizon} report..."):
                summary_data = filtered[["exercise_code", "date", "activity_type", "distance_km", "moving_time_str", "avg_speed_kmh", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m"]].to_string(index=False)
                prompt = f"""
You are an elite cycling and running coach reviewing athlete Mustafa's ({horizon}) training progression.
Session Data:
{summary_data}

Provide an executive, sports-science evaluation:
1. Training Load & Volume Adherence.
2. Zone 2 Aerobic Base building vs Zone 5 Redline Fatigue.
3. Actionable adjustments for nutrition, recovery, and upcoming sessions.
"""
                audit = call_gemini(prompt)
                if audit:
                    conn = get_db()
                    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                    conn.execute("INSERT INTO ai_reports (report_type, reference_info, created_at, analysis_text) VALUES (?, ?, ?, ?)",
                                 (horizon, f"{len(filtered)} workouts", now_str, audit))
                    conn.commit()
                    conn.close()
                    st.markdown(audit)
