# Life Simulation App — Blueprint v2

## What This Is

A text-based life simulation PWA. BitLife in structure, but generative-narrative heavy
and explicitly adult. The simulation is indifferent, consequence-driven, and designed
for playthroughs of hundreds of turns without token bloat or AI censorship conflicts.

The AI handles narration only. Everything else — math, time, risk, routing — lives in code.

---

## The Problem Being Solved

The original architecture had Grok doing six jobs (narration, stat math, NPC logic,
risk rolls, world events, history management), burning 5,000–20,000+ tokens per turn.
The new architecture assigns each job to the right tool, dropping Grok's input to
~900 fixed tokens per significant turn. Conversation history is eliminated entirely
and replaced by a structured world_state object.

---

## Job Assignment

| Job | Handler |
|---|---|
| Stat math (decay, recovery, thresholds) | JavaScript |
| Risk rolls (illness, accident, death) | JavaScript — Math.random() |
| Money deduction, time advancement | JavaScript |
| Input sanitization and routing | JavaScript |
| Explicit action classification | JavaScript — hardcoded activity table |
| Novel non-explicit action classification | Gemini Flash (JSON only) |
| NPC reaction evaluation | Gemini Flash (JSON only) |
| Consequence staging | Gemini Flash (JSON only) |
| NPC activity check during autopilot time-skips | Gemini Flash (flag array only) |
| Mundane autopilot narration | Gemini Flash (sanitized context, short prose) |
| Rolling session context compression (every 10 turns) | Gemini Flash |
| Prose narration for NOTABLE / CRISIS / DEATH turns | Grok |
| Stat bars, turn anchor, all UI display | renderer.js |

---

## Three-Path Input Routing

Every player input is intercepted by a JS sanitizer before any API call is made.

**Path 1 — Explicit input:**
JS detects explicit keywords → bypasses Gemini entirely → JS classifies using a
hardcoded sexual activity table (preset stat deltas per activity type) → turn brief
assembled → Grok narrates. Gemini never sees explicit content.

**Path 2 — Novel non-explicit input:**
No explicit keywords → Gemini classifies action (type, time cost, stat deltas, risk
class — JSON only) → JS applies deltas → turn brief assembled → Grok narrates.

**Path 3 — Routine autopilot (non-explicit):**
Mundane time-skip (sleep, commute, standard work shift) → Gemini narrates directly
using a sanitized world_state (explicit NPC flags and sensitive fields stripped before
the call) → no Grok call. Saves tokens on routine turns.

Gemini never receives raw player input. It only receives mechanical classifications
or sanitized state objects. This is why zero censorship risk exists on the JSON calls,
and why autopilot narration stays clean even in an explicit simulation.

---

## How a Turn Works

1. Player inputs action
2. JS sanitizer checks for explicit keywords, routes to Path 1 / 2 / 3
3. JS engine advances time, applies stat formulas, runs risk rolls, checks thresholds
4. Turn classified: ROUTINE / NOTABLE / CRISIS / DEATH
   — Classification thresholds are explicit constants in engine.js, not vibe-based
   — Example: Health < 20 OR consequence.severity = "critical" OR risk_roll < 5 → CRISIS
5. ROUTINE non-explicit → Path 3 (Gemini narrates, Grok not called)
6. NOTABLE+ or explicit → Gemini evaluates NPC reactions if applicable (JSON) →
   JS assembles ~400-token turn brief → Grok narrates
7. renderer.js displays Grok prose, renders stat bars, appends TURN ANCHOR
8. JS writes updated world_state to IndexedDB

**TURN ANCHOR** is appended by renderer.js using JS-generated values (current time,
date, hours elapsed). Grok does not generate it and does not need to know the format.

---

## What Grok Receives Per Turn

A narration-only system prompt (~400–500 tokens, cached after turn 1) plus a structured
turn brief (~400 tokens) containing:

- Current time and date (JS-generated)
- Location and immediate sensory context
- Current stat values (all JS-calculated, never self-reported by Grok)
- What mechanically happened this turn: roll outcomes, NPC behavior flags
- Active dynamics from world_state (e.g. post-event tensions, ongoing consequences)
- Scene class and narration density instruction (expand / batch / single line)

Grok never sees conversation history. Grok never decides stat outcomes. It narrates
what JS already resolved.

---

## Grok's System Prompt (Narration Doctrine Only)

Stripped to: `<policy>`, `<identity>`, `<narration>`, `<intimacy>` (narration rules),
and the priority hierarchy from `<initialization>`.

Removed from the Grok prompt (now live in engine.js and npc.js):
`<mechanics>`, `<world>`, `<risk>`, `<output>` (stat display format), initialization procedure.

Estimated ~400–500 tokens. Cached after the first Grok call each session.

---

## What Gemini Flash Does

Classification calls — receives and returns JSON only. Never writes prose for significant turns.

- Novel action classification: action_type, time_cost_hours, stat deltas, risk_class
- NPC behavioral response given numeric trait array + relationship meter + action
- Consequence type and severity staging
- NPC activity flag check during autopilot time-skips over 4 in-game hours (flag array, not prose)
- Rolling session context compression: every 10 turns, compresses last 10 event log
  entries into a 3-sentence "session context" stored in world_state and included in
  future turn briefs

Autopilot narration call — receives a sanitized world_state (explicit fields stripped),
returns short mundane prose. This is the only time Gemini writes prose, and it only
does so for boring turns Grok shouldn't be called for.

---

## State Management

A `world_state` object in IndexedDB (via Dexie.js) is the single source of truth.
Everything reads from it. Nothing communicates except through it.

**Player:** stats, cash, location, irreversible states, skills, habits

**NPCs (per significant NPC):**
- name, age, NPC class (intimate / household / professional / institutional)
- numeric trait arrays: jealousy, honesty, patience, warmth, etc. (rigid values,
  Gemini reads these as constraints not suggestions)
- relationship meter, trust meter
- active_flags: e.g. `post_first_sexual_encounter`, `mutual_unspoken_tension`, `avoidance`
- flag_decay rate (slow / medium / fast)
- last 3 significant interactions, one sentence each
- status: active / archived

**active_dynamics:** situational modifiers carried forward across turns (e.g. post-coital
social disruption affecting boardmate behavior). This is how context like morning
awkwardness survives an autopilot skip without sending conversation history.

**Events:**
- Full simulation log in IndexedDB (mechanical history, never sent to AI in full)
- Last 5 significant events (one-sentence each, included in turn brief)
- Rolling 3-sentence session context, updated every 10 turns by Gemini

**Consequences:** active consequences, severity, duration, current stage

Exportable as JSON for save/load/backup.

---

## NPC Significance Threshold

A background NPC exists in world_state but has no UI card.
An NPC is promoted to a card when they cross either threshold:
- 2 meaningful interactions, OR
- any relationship delta ≥ ±10 in a single encounter

Cards are archived (collapsed, still accessible) when an NPC becomes inactive:
relocated, died, or relationship reached an irreversible estranged state.

---

## UI Panels (all renderer.js — no AI output populates these)

**Stat Panel:** visual progress bar format, always numerical. Rendered from world_state.

**NPC Panel (BitLife-style cards):**
Each significant NPC gets a card showing: name, age, NPC class, personality trait
bars, relationship + trust meters, observable behavioral notes (not internal labels),
last 3 significant interactions, current status.

**Job Panel:** employer, position, salary per cycle, schedule, days employed, performance
flags, linked NPC references for boss and coworkers.

**Possessions / Resources Panel:** cash (always visible, always numerical), key items
acquired through multi-step process, irreversible states listed permanently once triggered
(criminal record, chronic illness, public scandal, etc.).

---

## Open Item: DEATH Mechanic

The ruleset specifies: on death → POST-LIFE SUMMARY → POV shifts to an existing NPC.
This is not yet fully designed and must be resolved before building:

- Which NPC becomes new POV (selection criteria, who decides)
- What resets in world_state vs. what carries over under new POV
- Whether the simulation log and session context persist across the POV shift

---

## APIs and Fallbacks

**Primary:**
- Grok API — narration
- Gemini Flash — classification, autopilot narration, session compression

**Fallbacks:**
- OpenRouter.ai — single key routing to multiple models; automatic fallback if Gemini
  hits rate limits; also provides uncensored open-source models usable as Grok
  fallback narrators when needed
- Groq API — additional fallback, free tier, fast inference

All API keys stored locally on device.

---

## File Structure

```
sim/
├── index.html       — UI shell, PWA manifest
├── engine.js        — stat math, time, risk rolls, thresholds, turn classification constants
├── npc.js           — NPC profiles, numeric trait arrays, relationship logic
├── events.js        — event table, selector, condition checker
├── state.js         — world_state manager, Dexie.js / IndexedDB persistence
├── api.js           — Grok call, Gemini call, OpenRouter/Groq fallback, brief assembler
├── sanitizer.js     — input keyword detection, routing logic, Gemini context stripper
├── renderer.js      — stat bars, NPC cards, job panel, possessions, turn anchor, UI
└── prompts.js       — Grok narration-only prompt, Gemini JSON schemas
```

---

## Deployment

Single PWA installable on Android home screen via browser. No build step. No app store.
API keys stored locally. `x-grok-conv-id` header sent on every Grok call for prompt cache hits.

---

## Assessment Summary

Three independent reviews (ChatGPT, Claude, Claude) rated the architecture:
- Architecture: ~9/10
- Token efficiency: 9.8/10
- Simulation realism: 8.5/10

Gaps identified and addressed in this version: NPC trait system (now numeric arrays),
turn classification (now explicit constants), simulation log (now separate from turn brief),
TURN ANCHOR (now renderer.js), autopilot context loss (now solved by active_flags and
active_dynamics in world_state), Gemini censorship exposure (now solved by sanitizer.js
and three-path routing).

Rejected: replacing Gemini with a hand-coded rule engine (too costly, eliminates
Gemini's value on novel inputs). Monolithic world_state retained over modular state
files (refactor only when the pain is real).

Unresolved: DEATH POV-shift mechanic (see Open Item above).
