import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests
import textwrap

st.set_page_config(
    page_title="AI Coach",
    layout="centered",
    page_icon="⚡",
    initial_sidebar_state="collapsed"
)

st.markdown("""
<style>
    /* Clean, high-contrast light theme (Samsung Health & Strava aesthetic) */
    .stApp {
        background-color: #f8fafc;
        color: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    
    /* Top Header Banner */
    .app-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 0 16px 0;
        border-bottom: 1px solid #e2e8f0;
        margin-bottom: 16px;
    }
    .app-title {
        font-size: 1.35rem;
        font-weight: 800;
        letter-spacing: -0.5px;
        color: #0f172a;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .status-badge {
        font-size: 0.72rem;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 9999px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .status-connected {
        background: #dcfce7;
        color: #15803d;
        border: 1px solid #86efac;
    }
    .status-disconnected {
        background: #fee2e2;
        color: #b91c1c;
        border: 1px solid #fca5a5;
    }

    /* High-density compact workout card (Height ~80px) */
    .workout-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 10px 14px;
        margin-bottom: 8px;
        box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px -1px rgba(0, 0, 0, 0.03);
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .workout-card:hover {
        border-color: #cbd5e1;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.07);
    }
    .card-header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
    }
    .card-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 70%;
    }
    .card-title {
        font-size: 0.95rem;
        font-weight: 700;
        color: #1e293b;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .card-date {
        font-size: 0.72rem;
        font-weight: 500;
        color: #64748b;
    }

    /* Sport Tag Badges */
    .badge-ride {
        background: #fff7ed;
        color: #ea580c;
        border: 1px solid #ffedd5;
        font-size: 0.70rem;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }
    .badge-run {
        background: #ecfdf5;
        color: #059669;
        border: 1px solid #a7f3d0;
        font-size: 0.70rem;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 6px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }
    .badge-code {
        background: #f1f5f9;
        color: #475569;
        border: 1px solid #e2e8f0;
        font-size: 0.70rem;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 6px;
    }

    /* Data Metric Strip */
    .metric-strip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f8fafc;
        border: 1px solid #f1f5f9;
        border-radius: 8px;
        padding: 6px 10px;
        margin-top: 4px;
    }
    .metric-cell {
        text-align: center;
        flex: 1;
    }
    .metric-val {
        font-size: 0.90rem;
        font-weight: 800;
        color: #0f172a;
        line-height: 1.1;
    }
    .metric-lbl {
        font-size: 0.62rem;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        margin-top: 2px;
    }

    /* Modern action buttons */
    div.stButton > button:first-child {
        border-radius: 10px;
        font-weight: 700;
        font-size: 0.90rem;
        padding: 8px 16px;
        border: 1px solid transparent;
        transition: all 0.2s ease;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
        border-bottom: 1px solid #e2e8f0;
    }
    .stTabs [data-baseweb="tab"] {
        padding: 8px 14px;
        font-size: 0.88rem;
        font-weight: 600;
        color: #64748b;
    }
    .stTabs [aria-selected="true"] {
        color: #ea580c !important;
        border-bottom-color: #ea580c !important;
    }
</style>
""", unsafe_allow_html=True)

SVG_BIKE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h4"/><path d="m12 17.5 3.5-7"/></svg>'
SVG_RUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17.5 8 15l4 2 4-2.5 4 1.5"/><circle cx="14" cy="5" r="2"/><path d="m14 7-3 4 2 3-3 5"/><path d="m9.5 13-3-2"/></svg>'
SVG_HEART = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>'
SVG_BOLT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>'

DB_FILE = "training_vault.db"

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
    
    # Ensure fresh table schema with distinct running and cycling telemetry
    c.execute("""
    CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strava_id INTEGER UNIQUE,
        exercise_code TEXT UNIQUE,
        date TEXT,
        sport_category TEXT,
        title TEXT,
        distance_km REAL,
        moving_time_str TEXT,
        moving_time_sec INTEGER,
        elapsed_time_sec INTEGER,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        pace_str TEXT,
        elevation_gain_m REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        avg_power_w REAL,
        norm_power_w REAL,
        kilojoules REAL,
        avg_cadence REAL,
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

CLIENT_ID = str(st.secrets.get("STRAVA_CLIENT_ID", "277202")).strip().strip('"')
CLIENT_SECRET = str(st.secrets.get("STRAVA_CLIENT_SECRET", "")).strip().strip('"')
GEMINI_KEY = str(st.secrets.get("GEMINI_API_KEY", "")).strip().strip('"')

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

if "code" in st.query_params:
    auth_code = st.query_params["code"]
    try:
        res = requests.post("https://www.strava.com/oauth/token", data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": auth_code,
            "grant_type": "authorization_code"
        }, timeout=10)
        
        if res.status_code == 200:
            token_payload = res.json()
            set_config("strava_access_token", token_payload["access_token"])
            set_config("strava_refresh_token", token_payload["refresh_token"])
            set_config("strava_connected", "true")
            st.query_params.clear()
            st.rerun()
    except Exception as e:
        st.error(f"Authentication handshake error: {e}")

def get_valid_token():
    # Read saved permanent token from DB first; fallback to secrets
    refresh_token = get_config("strava_refresh_token") or str(st.secrets.get("STRAVA_REFRESH_TOKEN", "")).strip().strip('"')
    if not refresh_token:
        return None

    try:
        res = requests.post("https://www.strava.com/oauth/token", data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token
        }, timeout=10)
        
        if res.status_code == 200:
            data = res.json()
            set_config("strava_access_token", data["access_token"])
            set_config("strava_refresh_token", data["refresh_token"])
            set_config("strava_connected", "true")
            return data["access_token"]
    except Exception:
        pass
    return None

def generate_exercise_code(conn, sport, date_obj):
    prefix = "Run" if sport == "Run" else "Bike"
    month_str = date_obj.strftime("%b/%Y")
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM workouts WHERE exercise_code LIKE ?", (f"{prefix}-%-{month_str}",))
    count = c.fetchone()[0] + 1
    return f"{prefix}-{count:03d}-{month_str}"

def calculate_run_pace(distance_km, moving_sec):
    if distance_km <= 0 or moving_sec <= 0:
        return "--"
    sec_per_km = moving_sec / distance_km
    m, s = divmod(int(sec_per_km), 60)
    return f"{m}:{s:02d} /km"

def sync_strava_activities():
    token = get_valid_token()
    if not token:
        return -1
    
    headers = {"Authorization": f"Bearer {token}"}
    try:
        res = requests.get("https://www.strava.com/api/v3/athlete/activities?per_page=60", headers=headers, timeout=12)
        if res.status_code != 200:
            return -1
        activities = res.json()
    except Exception:
        return -1

    if not isinstance(activities, list):
        return -1
        
    conn = get_db()
    new_count = 0
    
    for act in reversed(activities):
        s_id = act.get("id")
        exists = conn.execute("SELECT id FROM workouts WHERE strava_id=?", (s_id,)).fetchone()
        if exists:
            continue
        
        raw_type = str(act.get("type", ""))
        sport = "Run" if raw_type in ["Run", "Walk", "Hike", "VirtualRun"] else "Ride"
        
        dt_raw = act.get("start_date_local", "")
        try:
            dt_obj = datetime.datetime.fromisoformat(dt_raw.replace("Z", ""))
        except Exception:
            dt_obj = datetime.datetime.now()
        date_str = dt_obj.strftime("%Y-%m-%d %H:%M")
        
        code = generate_exercise_code(conn, sport, dt_obj)
        dist_km = round(act.get("distance", 0.0) / 1000.0, 2)
        m_time = act.get("moving_time", 0)
        e_time = act.get("elapsed_time", 0)
        m, s = divmod(m_time, 60)
        time_str = f"{m}:{s:02d}"
        
        avg_spd = round(act.get("average_speed", 0.0) * 3.6, 1)
        max_spd = round(act.get("max_speed", 0.0) * 3.6, 1)
        pace_str = calculate_run_pace(dist_km, m_time) if sport == "Run" else ""
        elev = round(act.get("total_elevation_gain", 0.0), 0)
        
        avg_hr = int(act.get("average_heartrate", 0)) if "average_heartrate" in act else 0
        max_hr = int(act.get("max_heartrate", 0)) if "max_heartrate" in act else 0
        watts = round(act.get("average_watts", 0.0), 0)
        norm_watts = round(act.get("weighted_average_watts", 0.0), 0)
        kj = round(act.get("kilojoules", 0.0), 1)
        cadence = round(act.get("average_cadence", 0.0), 1)
        suffer = int(act.get("suffer_score", 0)) if act.get("suffer_score") else 0
        title = act.get("name", f"Strava {sport}")
        
        conn.execute("""
        INSERT INTO workouts (
            strava_id, exercise_code, date, sport_category, title, distance_km, moving_time_str,
            moving_time_sec, elapsed_time_sec, avg_speed_kmh, max_speed_kmh, pace_str, elevation_gain_m,
            avg_hr, max_hr, avg_power_w, norm_power_w, kilojoules, avg_cadence, suffer_score, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
        """, (s_id, code, date_str, sport, title, dist_km, time_str, m_time, e_time, avg_spd, max_spd, pace_str, elev, avg_hr, max_hr, watts, norm_watts, kj, cadence, suffer))
        new_count += 1
        
    conn.commit()
    conn.close()
    return new_count

def call_gemini(prompt):
    if not GEMINI_KEY:
        st.error("Missing GEMINI_API_KEY in Secrets.")
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
    payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    try:
        res = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=20)
        if res.status_code == 200:
            return res.json()["candidates"][0]["content"]["parts"][0]["text"]
        else:
            st.error(f"Gemini API Error: {res.text}")
    except Exception as e:
        st.error(f"Connection failed: {e}")
    return None

is_connected = get_config("strava_connected") == "true" or get_config("strava_refresh_token") is not None

st.markdown(f"""
<div class="app-header">
    <div class="app-title">
        <span style="color:#ea580c;">AI Coach</span>
    </div>
    <div>
        <span class="status-badge {'status-connected' if is_connected else 'status-disconnected'}">
            {'Strava Synced' if is_connected else 'Not Linked'}
        </span>
    </div>
</div>
""", unsafe_allow_html=True)

if not is_connected:
    st.info("Connect Strava once. You can sign in with your Google Account on Strava, and AI Coach will stay linked permanently.")
    # Detect current app URL or use default
    auth_url = f"https://www.strava.com/oauth/authorize?client_id={CLIENT_ID}&response_type=code&redirect_uri=https://share.streamlit.io&approval_prompt=auto&scope=activity:read_all"
    
    col_a, col_b = st.columns([1.5, 1])
    with col_a:
        st.link_button("🔗 Sign In with Strava (Google Supported)", auth_url, use_container_width=True, type="primary")
    with col_b:
        with st.popover("Manual Code"):
            c_code = st.text_input("Paste redirect code:")
            if st.button("Submit Code"):
                st.query_params["code"] = c_code.strip()
                st.rerun()

tab_feed, tab_charts, tab_compare, tab_ai = st.tabs(["Feed", "Analytics", "Compare", "Progression"])

with tab_feed:
    col_sync, col_filter = st.columns([1.2, 1])
    with col_sync:
        if st.button("Sync Strava", use_container_width=True, type="primary"):
            with st.spinner("Fetching activities..."):
                added = sync_strava_activities()
                if added > 0:
                    st.toast(f"Imported {added} new activities!")
                    st.rerun()
                elif added == 0:
                    st.toast("Vault is already up to date.")
                else:
                    st.warning("Could not sync. Re-authorize above.")
    
    with col_filter:
        sport_filter = st.selectbox("Sport Filter", ["All", "Rides Only", "Runs Only"], label_visibility="collapsed")

    conn = get_db()
    query = "SELECT * FROM workouts "
    if sport_filter == "Rides Only":
        query += "WHERE sport_category = 'Ride' "
    elif sport_filter == "Runs Only":
        query += "WHERE sport_category = 'Run' "
    query += "ORDER BY date DESC"
    
    df = pd.read_sql_query(query, conn)
    conn.close()

    if df.empty:
        st.caption("No workouts found matching this filter.")
    else:
        for _, r in df.iterrows():
            is_run = r['sport_category'] == "Run"
            sport_badge = f'<span class="badge-run">{SVG_RUN} RUN</span>' if is_run else f'<span class="badge-ride">{SVG_BIKE} RIDE</span>'
            
            # Formatted Sport Specific Metrics
            if is_run:
                m1_val, m1_lbl = f"{r['distance_km']:.2f} km", "Distance"
                m2_val, m2_lbl = f"{r['moving_time_str']}", "Time"
                m3_val, m3_lbl = f"{r['pace_str']}", "Pace"
                m4_val, m4_lbl = f"{r['avg_hr'] if r['avg_hr'] > 0 else '--'} bpm", "Heart Rate"
                m5_val, m5_lbl = f"{r['elevation_gain_m']:.0f} m", "Elevation"
            else:
                m1_val, m1_lbl = f"{r['distance_km']:.1f} km", "Distance"
                m2_val, m2_lbl = f"{r['moving_time_str']}", "Duration"
                m3_val, m3_lbl = f"{r['avg_speed_kmh']:.1f} km/h", "Avg Speed"
                m4_val, m4_lbl = f"{r['avg_power_w']:.0f} W" if r['avg_power_w'] > 0 else "--", "Power"
                m5_val, m5_lbl = f"{r['avg_hr'] if r['avg_hr'] > 0 else '--'} bpm", "Heart Rate"

            card_html = textwrap.dedent(f"""
            <div class="workout-card">
                <div class="card-header-row">
                    <div class="card-title-group">
                        <span class="badge-code">{r['exercise_code']}</span>
                        {sport_badge}
                        <span class="card-title">{r['title']}</span>
                    </div>
                    <span class="card-date">{r['date'][:10]}</span>
                </div>
                <div class="metric-strip">
                    <div class="metric-cell"><div class="metric-val">{m1_val}</div><div class="metric-lbl">{m1_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-val">{m2_val}</div><div class="metric-lbl">{m2_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-val">{m3_val}</div><div class="metric-lbl">{m3_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-val">{m4_val}</div><div class="metric-lbl">{m4_lbl}</div></div>
                    <div class="metric-cell"><div class="metric-val">{m5_val}</div><div class="metric-lbl">{m5_lbl}</div></div>
                </div>
            </div>
            """)
            st.markdown(card_html, unsafe_allow_html=True)
            
            # Interactive Drawer for Deep Metrics & Field Notes
            with st.expander(f"Review {r['exercise_code']} Breakdown & Notes"):
                cd1, cd2, cd3 = st.columns(3)
                cd1.metric("Peak Speed", f"{r['max_speed_kmh']:.1f} km/h")
                cd2.metric("Peak HR", f"{r['max_hr'] if r['max_hr'] > 0 else '--'} bpm")
                cd3.metric("Work / Load", f"{r['kilojoules']} kJ" if not is_run else f"Score: {r['suffer_score']}")
                
                curr_note = st.text_input("Session Notes", value=r['notes'], key=f"note_{r['id']}")
                if st.button("Save Note", key=f"btn_{r['id']}"):
                    conn = get_db()
                    conn.execute("UPDATE workouts SET notes=? WHERE id=?", (curr_note, r['id']))
                    conn.commit()
                    conn.close()
                    st.success("Note recorded permanently.")
                    st.rerun()

with tab_charts:
    st.markdown("#### Performance Analytics")
    conn = get_db()
    all_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date ASC", conn)
    conn.close()
    
    if len(all_df) < 2:
        st.info("Log at least two activities to plot trend curves.")
    else:
        sport_mode = st.radio("Sport Analytics Mode", ["All", "Cycling Trends", "Running Trends"], horizontal=True)
        plot_df = all_df.copy()
        if sport_mode == "Cycling Trends":
            plot_df = plot_df[plot_df['sport_category'] == "Ride"]
        elif sport_mode == "Running Trends":
            plot_df = plot_df[plot_df['sport_category'] == "Run"]
            
        if not plot_df.empty:
            plot_df['short_date'] = pd.to_datetime(plot_df['date']).dt.strftime('%m/%d')
            
            st.caption("Speed & Velocity Curve (km/h)")
            st.line_chart(plot_df.set_index("short_date")[["avg_speed_kmh", "max_speed_kmh"]])
            
            if sport_mode == "Cycling Trends":
                st.caption("Power Output vs Cardiovascular Stress")
                pwr_valid = plot_df[plot_df['avg_power_w'] > 0]
                if not pwr_valid.empty:
                    st.line_chart(pwr_valid.set_index("short_date")[["avg_power_w", "avg_hr"]])
            
            st.caption("Volume (Distance in km & Elevation Gain in m)")
            st.bar_chart(plot_df.set_index("short_date")[["distance_km", "elevation_gain_m"]])

with tab_compare:
    st.markdown("#### Session Comparison")
    conn = get_db()
    c_df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    if len(c_df) < 2:
        st.info("At least two workouts are required to compare.")
    else:
        keys = {f"{r['exercise_code']} - {r['title']} ({r['date'][:10]})": r for _, r in c_df.iterrows()}
        opts = list(keys.keys())
        
        w1_sel = st.selectbox("Baseline Workout", opts, index=0)
        mode = st.radio("Comparison Format", ["1 to 1", "1 to 2"], horizontal=True)
        w2_sel = st.selectbox("Compare With", opts, index=min(1, len(opts)-1))
        
        w3_sel = None
        if mode == "1 to 2":
            w3_sel = st.selectbox("Second Comparison", opts, index=min(2, len(opts)-1))
            
        selected_rows = [keys[w1_sel], keys[w2_sel]]
        if w3_sel:
            selected_rows.append(keys[w3_sel])
            
        comp_cols = ["exercise_code", "sport_category", "date", "distance_km", "moving_time_str", "avg_speed_kmh", "pace_str", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m"]
        display_comp = pd.DataFrame(selected_rows)[comp_cols].set_index("exercise_code")
        st.dataframe(display_comp, use_container_width=True)
        
        if st.button("Analyze Differences with AI", type="primary", use_container_width=True):
            with st.spinner("Analyzing comparative delta..."):
                prompt = f"""
Act as an elite sports scientist analyzing athlete Mustafa (190 cm, ~115 kg).
Compare these specific training sessions:

{display_comp.to_string()}

Provide a concise, sports-science evaluation:
1. Aerobic Efficiency & HR Decoupling (Speed/Pace vs Cardiac Strain).
2. Mechanical Torque & Output (Watts/Ascent resistance).
3. Exact Coaching Directive for next workout.
"""
                verdict = call_gemini(prompt)
                if verdict:
                    st.markdown("##### AI Comparative Analysis")
                    st.markdown(verdict)

with tab_ai:
    st.markdown("#### Progression Audits")
    horizon = st.selectbox("Audit Horizon", ["Last 7 Days", "Last 30 Days", "All Time"])
    
    conn = get_db()
    all_recs = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    if not all_recs.empty:
        all_recs['dt'] = pd.to_datetime(all_recs['date'])
        now = datetime.datetime.now()
        
        if horizon == "Last 7 Days":
            scoped = all_recs[all_recs['dt'] >= (now - datetime.timedelta(days=7))]
        elif horizon == "Last 30 Days":
            scoped = all_recs[all_recs['dt'] >= (now - datetime.timedelta(days=30))]
        else:
            scoped = all_recs
            
        st.write(f"Activities in scope: **{len(scoped)}**")
        if not scoped.empty and st.button(f"Generate {horizon} Progression Audit", type="primary", use_container_width=True):
            with st.spinner("Synthesizing longitudinal training data..."):
                summary_data = scoped[["exercise_code", "sport_category", "date", "distance_km", "moving_time_str", "avg_speed_kmh", "pace_str", "avg_hr", "max_hr", "avg_power_w", "elevation_gain_m"]].to_string(index=False)
                prompt = f"""
Act as an elite cycling and multisport coach reviewing athlete Mustafa's ({horizon}) training progression.
Athlete Profile: 190 cm, ~115 kg, training on MTB with focus on dropping weight and building true aerobic capacity.
Data:
{summary_data}

Provide a structured, candid assessment:
1. Total Training Stress & Volume Adherence.
2. Aerobic Efficiency vs Anaerobic Fatigue (Zone 2 vs Zone 5 distribution).
3. Speed & Power Benchmarks.
4. Next Block Strategy (pacing, target cadence, recovery).
"""
                audit = call_gemini(prompt)
                if audit:
                    st.markdown("##### Progression Report")
                    st.markdown(audit)
