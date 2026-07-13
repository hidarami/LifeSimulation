// sanitizer.js — input sanitization, routing, Gemini context stripping
// Fix #2: pattern-based explicit detection replaces static keyword table
'use strict';

// ─── EXPLICIT PATTERNS ────────────────────────────────────────────────────────
// Semantic category regexes. Any match = explicit. Expandable without a word list.

const EXPLICIT_PATTERNS = [
  // Direct sex acts
  /\b(fuck|screw|bang|rail|nail|shag|bone|plow|pound)\b/i,
  // Oral
  /\b(blowjob|blow\s*job|fellatio|cunnilingus|go\s*down\s*on|(suck|sucking)\s*(him|her|them|off|his|her|their)?\s*(cock|dick|pussy|clit)?|eat\s*(him|her|out|pussy|ass))\b/i,
  // Body-motion intercourse cues
  /\b(ride\s*(him|her|them|it)|mount\s*(him|her|them)|straddle\s*(him|her|them)|grind\s*(on|against|him|her|them)|thrust\b|penetrat(e|ing|ion))\b/i,
  // Passive intercourse cues
  /\b(hump\b|get\s*(fucked|railed|pounded|banged)|be\s*(on\s*top|inside))\b/i,
  // Manual
  /\b(finger\s*(him|her|them|bang)|jerk\s*(him|me|her)?\s*off|handjob|hand\s*job|stroke\s*(his|her|their|my)\s*(cock|dick|pussy|clit))\b/i,
  // Sexual body parts in active context
  /\b(cock|dick|pussy|clit|clitoris|erect(ion)?|boner|cum\b|cumming|orgasm|ejaculat|aroused|hard\s*on)\b/i,
  // Restraint / kink
  /\b(pin\s*(him|her|them)\s*down|tie\s*(him|her|them)\s*up|bondage|spanking|spank\s*(him|her|me)|dom(inat(e|ion))?|submission|sub\s*to)\b/i,
  // Makeout
  /\b(makeout|make\s*out|making\s*out|french\s*kiss|kiss\s*(him|her|them)\s*(deeply|hungrily|hard))\b/i,
  // Edging / teasing sexual
  /\b(edge\s*(him|her|them)|tease\s*(his|her|their|my)\s*(cock|dick|pussy|clit)|masturbat)\b/i,
  // Positions
  /\b(doggy(\s*style)?|missionary|cowgirl|reverse\s*cowgirl|69\b|sixty.?nine)\b/i,
];

export function isExplicit(input) {
  const n = input.toLowerCase().trim();
  return EXPLICIT_PATTERNS.some(p => p.test(n));
}

// ─── EXPLICIT ACTIVITY CLASSIFICATION ────────────────────────────────────────
// Pattern-based — not keyword lists. Returns an activity key for EXPLICIT_ACTIVITY_TABLE.

export function classifyExplicitActivity(input) {
  const n = input.toLowerCase();
  if (/\b(fuck|intercourse|rail|pound|bang|screw|shag|bone|plow|ride|mount|straddle|cowgirl|missionary|doggy|thrust|penetrat|inside\s*her|inside\s*him)\b/.test(n)) return 'intercourse';
  if (/\b(blow|suck(ing)?\s*(his|him|cock|dick)|fellatio|go\s*down\s*on\s*him|give\s*(him|a)\s*(head|blowjob))\b/.test(n)) return 'oral_giving';
  if (/\b(eat\s*(her|out|pussy)|cunnilingus|go\s*down\s*on\s*her|lick\s*(her|pussy)|give\s*(her)\s*head)\b/.test(n)) return 'oral_giving';
  if (/\b(get\s*(sucked|a\s*blowjob)|she\s*sucks|she\s*goes\s*down)\b/.test(n)) return 'oral_receiving';
  if (/\b(he\s*goes\s*down|he\s*eats|get\s*eaten\s*out)\b/.test(n)) return 'oral_receiving';
  if (/\b(finger|jerk\s*(him|her)\s*off|handjob|stroke\s*(his|her)\s*(cock|dick|pussy|clit))\b/.test(n)) return 'manual_giving';
  if (/\b(gets?\s*fingered|jerk\s*me\s*off|she\s*(fingers|strokes\s*my))\b/.test(n)) return 'manual_receiving';
  if (/\b(makeout|make\s*out|making\s*out|french\s*kiss)\b/.test(n)) return 'makeout';
  if (/\b(masturbat|touch\s*myself|jerk\s*off\s*alone|solo|rub\s*(one|myself))\b/.test(n)) return 'solo_masturbation';
  if (/\b(69|sixty.?nine|mutual|each\s*other)\b/.test(n)) return 'mutual_masturbation';
  return 'intercourse'; // ambiguous explicit default
}

// ─── EXPLICIT ACTIVITY TABLE ─────────────────────────────────────────────────
export const EXPLICIT_ACTIVITY_TABLE = {
  intercourse:         { arousal: -60, mood: +25, energy: -20, social: +15, hygiene: -10 },
  oral_giving:         { arousal: -20, mood: +15, energy: -10, social: +10 },
  oral_receiving:      { arousal: -40, mood: +20, energy: -5,  social: +10 },
  manual_giving:       { arousal: -10, mood: +10, energy: -5,  social: +8  },
  manual_receiving:    { arousal: -25, mood: +15, energy: -5,  social: +8  },
  mutual_masturbation: { arousal: -30, mood: +15, energy: -10, social: +12 },
  makeout:             { arousal: +20, mood: +15, energy: -5,  social: +10 },
  solo_masturbation:   { arousal: -60, mood: +10, energy: -10              },
};

// ─── ROUTING ─────────────────────────────────────────────────────────────────
export const ROUTE = {
  PATH_1_EXPLICIT:  'PATH_1_EXPLICIT',
  PATH_2_NOVEL:     'PATH_2_NOVEL',
  PATH_3_AUTOPILOT: 'PATH_3_AUTOPILOT',
};

const AUTOPILOT_PATTERNS = [
  /\b(sleep|go\s*to\s*sleep|take\s*a\s*nap|nap|rest\s*for)\b/i,
  /\b(commute|take\s*the\s*(bus|train|jeep)|drive\s*to\s*work|walk\s*to\s*(work|school))\b/i,
  /\b(work\s*(shift|day)|standard\s*shift|regular\s*shift|clock\s*(in|out)|go\s*to\s*work)\b/i,
  /\b(wait|idle|do\s*nothing|pass\s*(the\s*)?time|kill\s*time)\b/i,
];

export function routeInput(input) {
  if (isExplicit(input))                             return ROUTE.PATH_1_EXPLICIT;
  if (AUTOPILOT_PATTERNS.some(p => p.test(input)))  return ROUTE.PATH_3_AUTOPILOT;
  return ROUTE.PATH_2_NOVEL;
}

// ─── COMPOUND ACTION EXTRACTION ───────────────────────────────────────────────
const EAT_PATTERNS = [
  /\b(eat|ate|eating|eats|have\s+(a\s+)?(meal|food|lunch|dinner|breakfast|snack|bite)|cook(ed|ing)?|grab(bed)?\s+(food|a\s+bite)|drink(s|ed|ing)?|consume[ds]?)\b/i,
];
const LOCATION_HINTS = [
  { pattern: /\b(outside|outdoors?|front\s*yard|backyard|yard|alley|street|road|sidewalk|driveway)\b/i, location: 'outside' },
  { pattern: /\b(bedroom|in\s+(the\s+)?room|in\s+(my\s+)?bed)\b/i, location: 'bedroom' },
  { pattern: /\b(bathroom|toilet|comfort\s*room|\bcr\b|shower)\b/i, location: 'bathroom' },
  { pattern: /\b(kitchen)\b/i, location: 'kitchen' },
  { pattern: /\b(living\s*room|sala|couch|sofa)\b/i, location: 'living room' },
];
export function extractCompoundContext(input) {
  const n = input.toLowerCase();
  const ate = EAT_PATTERNS.some(p => p.test(n));
  let location_hint = null;
  for (const { pattern, location } of LOCATION_HINTS) {
    if (pattern.test(n)) { location_hint = location; break; }
  }
  return { ate, location_hint };
}

// ─── GEMINI CONTEXT STRIPPING ─────────────────────────────────────────────────
export function sanitizeStateForGemini(worldState) {
  const safe = JSON.parse(JSON.stringify(worldState));
  delete safe.player?.arousal;
  delete safe.player?.explicit_history;
  delete safe.player?.current_autopilot_activity;
  if (safe.npcs) {
    for (const npc of Object.values(safe.npcs)) {
      npc.active_flags = (npc.active_flags ?? []).filter(
        f => !f.includes('sexual') && !f.includes('explicit') && !f.includes('intimate')
      );
      delete npc.explicit_interactions;
    }
  }
  return safe;
}