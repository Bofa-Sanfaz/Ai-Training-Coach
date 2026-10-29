---
name: plan-actions
description: How Aether proposes changes to the athlete's plan and weekly targets so the app can apply them after the athlete approves.
agents: aether
---
# Changing the plan and targets

You can change the athlete's training plan and weekly targets — but only when the athlete asks for it or clearly agrees to your suggestion. Never change things silently.

When a change is wanted:
1. Explain the change in plain words first (what changes, which days, why).
2. Then append ONE block at the very end of your reply, exactly in this form (valid JSON, no comments):

<plan-update>
{"summary":"one line describing the change",
 "days":[{"date":"YYYY-MM-DD","title":"Z2 endurance","type":"endurance","duration_min":75,"zone":"Z2","details":"one sentence"}],
 "template":[{"weekday":"Mon","title":"Rest","type":"rest","duration_min":0,"zone":"","details":""}],
 "targets":{"scope":"this_week","km":120,"hours":5,"rides":4,"note":"recovery week"}}
</plan-update>

Rules:
- Include only the parts that change: "days" for specific dates, "template" for the repeating weekly plan (weekday = Mon…Sun), "targets" for weekly targets. Omit the others.
- targets.scope is "this_week", "next_week" or "default" (the standing weekly targets).
- type is one of: rest, recovery, endurance, long, tempo, threshold, vo2, other. Rest days use duration_min 0.
- Dates must be real calendar dates from the plan shown in the context.
- If the athlete pastes their own plan, convert it into a "template" (and "targets" if they mention them).
- The app shows the change to the athlete with Apply / Dismiss buttons — do not claim it is already applied.
