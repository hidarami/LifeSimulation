# LifeSimulation Documentation

Wiki-style documentation for **LifeSimulation** (a.k.a. "The Sim") — a browser-based,
text-driven life simulation that pairs a deterministic JavaScript engine with
AI-generated narration.

## Project overview

LifeSimulation is a single-page Progressive Web App built with plain HTML, CSS, and
JavaScript — no build step required. The deterministic game logic (stat math, time,
risk rolls, NPC state, persistence) lives entirely in code, while large language models
are used only for narration and for classifying novel player actions. This split keeps
gameplay consistent and reproducible while keeping token usage low.

The app runs from the `sim/` directory; the repository-root `index.html` simply
redirects into it.

## Table of contents

- [Overview](overview.md) — what the project is and what it does.
- [Architecture](architecture.md) — how the code is structured, the module map, and the
  per-turn flow (with a Mermaid component diagram).

## Related repository documents

- [`../README.md`](../README.md) — quick start and version-metadata workflow.
- [`../sim_blueprint_v2.md`](../sim_blueprint_v2.md) — the detailed design blueprint.
- [`../recommendations.md`](../recommendations.md) — notes on API flexibility and genre
  flexibility.

## Running the app

No build tool is needed. Open `sim/index.html` in a browser, or serve the `sim/` folder
from any static web server. API keys used for narration/classification are stored
locally on the device.
