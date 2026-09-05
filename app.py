import streamlit as st
import sqlite3
import pandas as pd
import datetime
import requests
import json

# ---------------------------------------------------------
# 1. PAGE CONFIG & MODERN CSS STYLING
# ---------------------------------------------------------
st.set_page_config(page_title="Apex Endurance Vault", layout="wide", page_icon="⚡")

st.markdown("""
<style>
    /* Sleek Dark Mode & Glassmorphism */
    .stApp {
        background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
        color: #e6edf3;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .workout-card {
        background: rgba(22, 27, 34, 0.75);
        border: 1px solid rgba(48, 54, 61, 0.8);
        border-radius: 14px;
        padding: 18px;
        margin-bottom: 15px;
        transition: transform 0.2s ease, border-color 0.2s ease;
        backdrop-filter: blur(8px);
    }
    .workout-card:hover {
        transform: translateY(-3px);
        border-color: #58a6ff;
    }
    .badge {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        margin-right: 6px;
    }
    .badge-bike { background: rgba(56, 139, 253, 0.2); color: #58a6ff; border: 1px solid #388bfd; }
    .badge-run { background: rgba(63, 185, 80, 0.2); color: #3fb950; border: 1px solid #2ea043; }
    .badge-code { background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid #d29922; }
    .metric-value {
        font-size: 1.35rem;
        font-weight: 800;
        color: #f0f6fc;
    }
    .metric-label {
        font-size: 0.75rem;
        text-transform: uppercase;
        color: #8b949e;
    }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------
# 2. DATABASE INITIALIZATION & SCHEMA
# ---------------------------------------------------------
DB_FILE = "training_vault.db"

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    
    # Athlete Profile
    c.execute("""
    CREATE TABLE IF NOT EXISTS athlete (
        id INTEGER PRIMARY KEY,
        name TEXT,
        height_cm REAL,
        weight_kg REAL,
        max_hr INTEGER,
        ftp_est INTEGER,
        current_bike TEXT,
        notes TEXT
    )
    """)
    
    # Workouts Ledger with Custom Exercise Codes
    c.execute("""
    CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exercise_code TEXT UNIQUE,
        date TEXT,
        activity_type TEXT,
        title TEXT,
        location_route TEXT,
        distance_km REAL,
        moving_time_str TEXT,
        moving_time_sec INTEGER,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        elevation_gain_m REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        avg_power_w REAL,
        calories INTEGER,
        notes TEXT
    )
    """)
    
    # Permanent AI Review Ledger
    c.execute("""
    CREATE TABLE IF NOT EXISTS ai_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workout_id INTEGER,
        exercise_code TEXT,
        model_name TEXT,
        created_at TEXT,
        analysis_text TEXT,
        FOREIGN KEY(workout_id) REFERENCES workouts(id)
    )
    """)
    
    # Seed profile if empty
    c.execute("SELECT COUNT(*) FROM athlete")
    if c.fetchone()[0] == 0:
        c.execute("""
        INSERT INTO athlete (id, name, height_cm, weight_kg, max_hr, ftp_est, current_bike, notes)
        VALUES (1, 'Mustafa', 190, 114.8, 202, 220, 'Kron XC150 MTB (Alloy, 29", Flat Bars)', 
                'Focusing on high-resistance fat loss to safely transition to an aero road bike in 3-5 months. Needs clipless power pedals.')
        """)

    # Seed baseline shakedown workouts if empty
    c.execute("SELECT COUNT(*) FROM workouts")
    if c.fetchone()[0] == 0:
        c.execute("""
        INSERT INTO workouts (exercise_code, date, activity_type, title, location_route, distance_km, moving_time_str, moving_time_sec, avg_speed_kmh, max_speed_kmh, elevation_gain_m, avg_hr, max_hr, avg_power_w, calories, notes)
        VALUES 
        ('Bike-001-Sep/2026', '2026-09-05 15:37', 'Ride (MTB)', 'Afternoon Shakedown / Speed Record', 'Bahçeşehir', 10.82, '30:24', 1824, 21.4, 44.7, 21, 183, 202, 220, 327, 'All-time top speed 44.7 km/h. Foot bounced off flat pedals at 110+ RPM. Return session after 2 weeks off.'),
        ('Bike-002-Sep/2026', '2026-09-05 16:36', 'Ride (MTB)', 'Post-Ride Commute Wall', 'Bahçeşehir', 1.35, '13:41', 821, 5.9, 14.9, 94, 184, 192, 200, 133, 'Mandatory steep climb home (~7-10% grade). Heavy torque grind in Zone 5.')
        """)

    conn.commit()
    conn.close()

init_db()

# ---------------------------------------------------------
# 3. HELPER FUNCTIONS: EXERCISE CODES & AI CALLS
# ---------------------------------------------------------
def generate_exercise_code(conn, activity_type, date_obj):
    prefix = "Run" if "Run" in activity_type else "Bike"
    month_str = date_obj.strftime("%b/%Y")
    
    # Query how many of this activity prefix exist in this month
    c = conn.cursor()
    c.execute("""
    SELECT COUNT(*) FROM workouts 
    WHERE exercise_code LIKE ?
    """, (f"{prefix}-%-{month_str}",))
    count = c.fetchone()[0] + 1
    return f"{prefix}-{count:03d}-{month_str}"

def call_ai_model(model_choice, api_key, prompt):
    if "gemini" in model_choice.lower():
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_choice}:generateContent?key={api_key}"
        payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
        res = requests.post(url, json=payload, headers={"Content-Type": "application/json"})
        if res.status_code == 200:
            return res.json()["candidates"][0]["content"]["parts"][0]["text"]
        else:
            raise Exception(f"Gemini API Error ({res.status_code}): {res.text}")
            
    elif "openrouter" in model_choice.lower() or "/" in model_choice:
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {
            "model": model_choice,
            "messages": [{"role": "user", "content": prompt}]
        }
        res = requests.post(url, json=payload, headers=headers)
        if res.status_code == 200:
            return res.json()["choices"][0]["message"]["content"]
        else:
            raise Exception(f"OpenRouter Error ({res.status_code}): {res.text}")
    else:
        raise Exception("Unsupported Model Provider.")

# ---------------------------------------------------------
# 4. APP INTERFACE & TABS
# ---------------------------------------------------------
st.title("⚡ Apex Endurance Vault")
st.caption("Permanent SQLite Ledger • Multi-Model AI Coach • Automated Exercise Tagging")

tabs = st.tabs(["📋 Activity Feed", "🔍 Workout Review & AI Lab", "✍️ Log Workout", "📥 Strava Ingest", "⚙️ Profile"])

# ---------------------------------------------------------
# TAB 1: ACTIVITY FEED (CHRONOLOGICAL & ORGANIZED)
# ---------------------------------------------------------
with tabs[0]:
    conn = get_db()
    df = pd.read_sql_query("SELECT * FROM workouts ORDER BY date DESC", conn)
    conn.close()
    
    col1, col2, col3, col4 = st.columns(4)
    if not df.empty:
        col1.metric("Peak Speed", f"{df['max_speed_kmh'].max():.1f} km/h")
        col2.metric("Longest Session", f"{df['distance_km'].max():.1f} km")
        col3.metric("Max Elevation", f"{df['elevation_gain_m'].max():.0f} m")
        col4.metric("Logged Volume", f"{df['distance_km'].sum():.1f} km")
    
    st.markdown("### Historical Timeline")
    if not df.empty:
        df['month_year'] = pd.to_datetime(df['date']).dt.strftime('%B %Y')
        for month, group in df.groupby('month_year', sort=False):
            st.markdown(f"#### 📅 {month}")
            for _, r in group.iterrows():
                badge_class = "badge-bike" if "Bike" in r['activity_type'] or "Ride" in r['activity_type'] else "badge-run"
                st.markdown(f"""
                <div class="workout-card">
                    <span class="badge badge-code">{r['exercise_code']}</span>
                    <span class="badge {badge_class}">{r['activity_type']}</span>
                    <strong style="font-size: 1.1rem; margin-left: 5px;">{r['title']}</strong>
                    <div style="color: #8b949e; font-size: 0.85rem; margin-top: 4px;">📍 {r['location_route']} • 🕒 {r['date']}</div>
                    <hr style="border-color: rgba(48, 54, 61, 0.5); margin: 12px 0;">
                    <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                        <div><div class="metric-label">Distance</div><div class="metric-value">{r['distance_km']:.2f} km</div></div>
                        <div><div class="metric-label">Time</div><div class="metric-value">{r['moving_time_str']}</div></div>
                        <div><div class="metric-label">Avg Speed</div><div class="metric-value">{r['avg_speed_kmh']:.1f} km/h</div></div>
                        <div><div class="metric-label">Max Speed</div><div class="metric-value">{r['max_speed_kmh']:.1f} km/h</div></div>
                        <div><div class="metric-label">Avg HR</div><div class="metric-value">{r['avg_hr']} bpm</div></div>
                        <div><div class="metric-label">Power (Est)</div><div class="metric-value">{r['avg_power_w']:.0f} W</div></div>
                        <div><div class="metric-label">Elev Gain</div><div class="metric-value">{r['elevation_gain_m']:.0f} m</div></div>
                    </div>
                    {f'<div style="margin-top: 10px; font-size: 0.9rem; color: #c9d1d9;"><strong>Notes:</strong> {r["notes"]}</div>' if r['notes'] else ''}
                </div>
                """, unsafe_allow_html=True)
    else:
        st.info("No activities found. Log your first workout to get started!")

# ---------------------------------------------------------
# TAB 2: WORKOUT REVIEW & MULTI-MODEL AI LAB
# ---------------------------------------------------------
with tabs[1]:
    st.subheader("🔬 Session Analysis & AI Model Lab")
    
    conn = get_db()
    workouts = pd.read_sql_query("SELECT id, exercise_code, title, date FROM workouts ORDER BY date DESC", conn)
    
    if workouts.empty:
        st.warning("Please log a workout first.")
        conn.close()
    else:
        # Workout Selector
        workout_options = {f"{r['exercise_code']} - {r['title']} ({r['date']})": r['id'] for _, r in workouts.iterrows()}
        selected_label = st.selectbox("Select Exercise to Inspect & Review", list(workout_options.keys()))
        selected_id = workout_options[selected_label]
        
        # Load Selected Workout Data
        target_w = conn.execute("SELECT * FROM workouts WHERE id=?", (selected_id,)).fetchone()
        athlete = conn.execute("SELECT * FROM athlete WHERE id=1").fetchone()
        
        col_w1, col_w2 = st.columns([1, 1.2])
        
        with col_w1:
            st.markdown(f"### Details: `{target_w['exercise_code']}`")
            st.write(f"**Route / Terrain:** {target_w['location_route']}")
            st.write(f"**Distance & Time:** {target_w['distance_km']} km in {target_w['moving_time_str']}")
            st.write(f"**Speeds:** Avg {target_w['avg_speed_kmh']} km/h | Peak {target_w['max_speed_kmh']} km/h")
            st.write(f"**Cardio:** Avg {target_w['avg_hr']} bpm | Max {target_w['max_hr']} bpm")
            st.write(f"**Mechanical Work:** {target_w['avg_power_w']} W | {target_w['elevation_gain_m']} m Gain")
            st.info(f"**Athlete Field Notes:** {target_w['notes']}")
            
            st.markdown("---")
            st.markdown("#### 🤖 Generate New AI Analysis")
            model_options = [
                "gemini-2.5-flash",
                "gemini-2.5-pro",
                "anthropic/claude-3.5-sonnet (via OpenRouter)",
                "deepseek/deepseek-r1 (via OpenRouter)"
            ]
            selected_model = st.selectbox("Select AI Model Architecture", model_options)
            api_key_input = st.text_input("Enter API Key (Google AI Studio or OpenRouter)", type="password")
            custom_focus = st.text_input("Specific Analysis Angle (Optional)", "Biomechanical torque, pacing, heart rate recovery, aerobic building")
            
            if st.button("Run AI Analysis & Save Review"):
                if not api_key_input:
                    st.error("API Key required.")
                else:
                    with st.spinner(f"Analyzing with {selected_model}..."):
                        # Build Comprehensive Context
                        prompt_text = f"""
You are an elite sports scientist and cycling/running coach analyzing athlete {athlete['name']}.
ATHLETE PROFILE:
- Height: {athlete['height_cm']} cm | Weight: {athlete['weight_kg']} kg
- Max HR: {athlete['max_hr']} bpm | Estimated FTP: {athlete['ftp_est']} W
- Equipment: {athlete['current_bike']}
- Long-term Focus: {athlete['notes']}

SESSION DATA FOR: {target_w['exercise_code']}
- Title: {target_w['title']}
- Date: {target_w['date']}
- Location / Route: {target_w['location_route']}
- Distance: {target_w['distance_km']} km | Time: {target_w['moving_time_str']}
- Speeds: Avg {target_w['avg_speed_kmh']} km/h | Max {target_w['max_speed_kmh']} km/h
- Heart Rate: Avg {target_w['avg_hr']} bpm | Peak {target_w['max_hr']} bpm
- Power: {target_w['avg_power_w']} W | Elevation: {target_w['elevation_gain_m']} m
- Athlete Field Notes: {target_w['notes']}

COACHING REQUEST:
Provide a rigorous, candid assessment focusing on: {custom_focus}.
Do not pad with generic fluff. Break down power-to-weight, aerobic decoupling, cadence spin-out, and actionable guidance for future sessions.
"""
                        try:
                            clean_model = selected_model.split(" ")[0]
                            analysis = call_ai_model(clean_model, api_key_input, prompt_text)
                            
                            # Save review directly to DB
                            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                            conn.execute("""
                            INSERT INTO ai_reviews (workout_id, exercise_code, model_name, created_at, analysis_text)
                            VALUES (?, ?, ?, ?, ?)
                            """, (target_w['id'], target_w['exercise_code'], clean_model, now_str, analysis))
                            conn.commit()
                            st.success("Analysis complete and saved to this exercise!")
                            st.rerun()
                        except Exception as e:
                            st.error(f"Error: {e}")
        
        with col_w2:
            st.markdown("### 📜 Saved AI Reviews for this Session")
            reviews = conn.execute("SELECT * FROM ai_reviews WHERE workout_id=? ORDER BY created_at DESC", (selected_id,)).fetchall()
            
            if not reviews:
                st.write("No AI reviews generated for this exercise yet. Run an analysis on the left!")
            else:
                for rev in reviews:
                    with st.expander(f"🧠 {rev['model_name']} • {rev['created_at']}", expanded=True):
                        st.markdown(rev['analysis_text'])
                        if st.button(f"Delete Review #{rev['id']}", key=f"del_{rev['id']}"):
                            conn.execute("DELETE FROM ai_reviews WHERE id=?", (rev['id'],))
                            conn.commit()
                            st.rerun()
        conn.close()

# ---------------------------------------------------------
# TAB 3: LOG WORKOUT (WITH AUTO-EXERCISE CODE)
# ---------------------------------------------------------
with tabs[2]:
    st.subheader("✍️ Log a New Training Session")
    with st.form("manual_entry_form", clear_on_submit=True):
        c1, c2, c3 = st.columns(3)
        w_date = c1.date_input("Date", datetime.date.today())
        w_time = c2.time_input("Start Time", datetime.datetime.now().time())
        w_type = c3.selectbox("Activity Type", ["Ride (MTB)", "Ride (Road)", "Run (Road)", "Run (Treadmill)", "Walk / Hike"])
        
        c4, c5 = st.columns(2)
        w_title = c4.text_input("Title", "Büyükçekmece Tempo / Bahçeşehir Climb")
        w_loc = c5.text_input("Route / Location", "Büyükçekmece Coast")
        
        c6, c7, c8, c9 = st.columns(4)
        w_dist = c6.number_input("Distance (km)", min_value=0.0, step=0.1, format="%.2f")
        w_dur_min = c7.number_input("Moving Minutes", min_value=0, step=1)
        w_dur_sec = c8.number_input("Moving Seconds", min_value=0, max_value=59, step=1)
        w_elev = c9.number_input("Elevation Gain (m)", min_value=0.0, step=1.0)
        
        c10, c11, c12, c13 = st.columns(4)
        w_avg_spd = c10.number_input("Avg Speed (km/h)", min_value=0.0, step=0.1)
        w_max_spd = c11.number_input("Max Speed (km/h)", min_value=0.0, step=0.1)
        w_avg_hr = c12.number_input("Avg Heart Rate (bpm)", min_value=0, step=1)
        w_max_hr = c13.number_input("Max Heart Rate (bpm)", min_value=0, step=1)
        
        c14, c15 = st.columns(2)
        w_power = c14.number_input("Avg Watts (Est/Real)", min_value=0, step=5)
        w_cal = c15.number_input("Calories Burned", min_value=0, step=10)
        
        w_notes = st.text_area("Observations, Mechanical State & Splits", placeholder="Cadence, fatigue, pedal clearance, gear behavior...")
        
        if st.form_submit_button("Record to Vault"):
            total_sec = (w_dur_min * 60) + w_dur_sec
            time_str = f"{w_dur_min}:{w_dur_sec:02d}"
            dt_str = f"{w_date} {w_time.strftime('%H:%M')}"
            
            conn = get_db()
            code = generate_exercise_code(conn, w_type, w_date)
            conn.execute("""
            INSERT INTO workouts (exercise_code, date, activity_type, title, location_route, distance_km, moving_time_str, moving_time_sec, avg_speed_kmh, max_speed_kmh, elevation_gain_m, avg_hr, max_hr, avg_power_w, calories, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (code, dt_str, w_type, w_title, w_loc, w_dist, time_str, total_sec, w_avg_spd, w_max_spd, w_elev, w_avg_hr, w_max_hr, w_power, w_cal, w_notes))
            conn.commit()
            conn.close()
            st.success(f"Recorded successfully as `{code}`!")
            st.rerun()

# ---------------------------------------------------------
# TAB 4: STRAVA INGESTION
# ---------------------------------------------------------
with tabs[3]:
    st.subheader("📥 Strava CSV Bulk Ingest")
    st.caption("Upload your Strava archive `activities.csv` to auto-populate past sessions into your local vault.")
    csv_file = st.file_uploader("Upload activities.csv", type=["csv"])
    if csv_file is not None:
        try:
            strava_df = pd.read_csv(csv_file)
            st.write(f"Loaded {len(strava_df)} records.")
            if st.button("Parse & Ingest Missing Sessions"):
                conn = get_db()
                count = 0
                for _, row in strava_df.iterrows():
                    date_val = str(row.get("Activity Date", ""))
                    dist_km = float(row.get("Distance", 0.0)) / 1000.0 if row.get("Distance", 0) > 100 else float(row.get("Distance", 0.0))
                    moving_time = int(row.get("Moving Time", 0))
                    m, s = divmod(moving_time, 60)
                    time_str = f"{m}:{s:02d}"
                    elev = float(row.get("Elevation Gain", 0.0))
                    avg_spd = float(row.get("Average Speed", 0.0)) * 3.6
                    max_spd = float(row.get("Max Speed", 0.0)) * 3.6
                    avg_hr = int(row.get("Average Heart Rate", 0)) if pd.notna(row.get("Average Heart Rate")) else 0
                    max_hr = int(row.get("Max Heart Rate", 0)) if pd.notna(row.get("Max Heart Rate")) else 0
                    avg_pwr = float(row.get("Average Watts", 0.0)) if pd.notna(row.get("Average Watts")) else 0.0
                    title_val = str(row.get("Activity Name", "Strava Ride"))
                    act_type = str(row.get("Activity Type", "Ride"))
                    
                    try:
                        d_obj = pd.to_datetime(date_val)
                    except:
                        d_obj = datetime.date.today()
                        
                    code = generate_exercise_code(conn, act_type, d_obj)
                    
                    conn.execute("""
                    INSERT INTO workouts (exercise_code, date, activity_type, title, location_route, distance_km, moving_time_str, moving_time_sec, avg_speed_kmh, max_speed_kmh, elevation_gain_m, avg_hr, max_hr, avg_power_w, calories, notes)
                    VALUES (?, ?, ?, ?, 'Imported Route', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Imported from Strava Archive')
                    """, (code, date_val, act_type, title_val, round(dist_km, 2), time_str, moving_time, round(avg_spd, 1), round(max_spd, 1), round(elev, 0), avg_hr, max_hr, round(avg_pwr, 1)))
                    count += 1
                conn.commit()
                conn.close()
                st.success(f"Ingested {count} workouts with custom tags!")
                st.rerun()
        except Exception as e:
            st.error(f"Error reading CSV: {e}")

# ---------------------------------------------------------
# TAB 5: PROFILE & HARDWARE SETTINGS
# ---------------------------------------------------------
with tabs[4]:
    st.subheader("⚙️ Athlete Ground Truth")
    conn = get_db()
    athlete = conn.execute("SELECT * FROM athlete WHERE id=1").fetchone()
    
    with st.form("profile_form"):
        u_weight = st.number_input("Body Weight (kg)", value=float(athlete['weight_kg']), step=0.1)
        u_max_hr = st.number_input("Max Heart Rate (bpm)", value=int(athlete['max_hr']), step=1)
        u_ftp = st.number_input("Estimated FTP (Watts)", value=int(athlete['ftp_est']), step=5)
        u_bike = st.text_input("Current Bike / Setup", value=athlete['current_bike'])
        u_notes = st.text_area("Coaching Focus & Strategic Objectives", value=athlete['notes'])
        
        if st.form_submit_button("Update Profile"):
            conn.execute("""
            UPDATE athlete SET weight_kg=?, max_hr=?, ftp_est=?, current_bike=?, notes=? WHERE id=1
            """, (u_weight, u_max_hr, u_ftp, u_bike, u_notes))
            conn.commit()
            conn.close()
            st.success("Profile saved! All AI models will use these numbers immediately.")
            st.rerun()
    conn.close()
