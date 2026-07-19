// sanitizer.js — input sanitization, routing, Gemini context stripping
// Fix #2: pattern-based explicit detection replaces static keyword table
'use strict';

// ─── EXPLICIT PATTERNS ────────────────────────────────────────────────────────
// Semantic category regexes. Any match = explicit. Expandable without a word list.

// ── English explicit patterns ─────────────────────────────────────────────────
const _EP_EN = [
  /\b(fuck|screw|bang|rail|nail|shag|bone|plow|pound)\b/i,
  /\b(blowjob|blow\s*job|fellatio|cunnilingus|go\s*down\s*on|(suck|sucking)\s*(him|her|them|off|his|her|their)?\s*(cock|dick|pussy|clit)?|eat\s*(him|her|out|pussy|ass))\b/i,
  /\b(ride\s*(him|her|them|it)|mount\s*(him|her|them)|straddle\s*(him|her|them)|grind\s*(on|against|him|her|them)|thrust\b|penetrat(e|ing|ion))\b/i,
  /\b(hump\b|get\s*(fucked|railed|pounded|banged)|be\s*(on\s*top|inside))\b/i,
  /\b(finger\s*(him|her|them|bang)|jerk\s*(him|me|her)?\s*off|handjob|hand\s*job|stroke\s*(his|her|their|my)\s*(cock|dick|pussy|clit))\b/i,
  /\b(cock|dick|pussy|clit|clitoris|erect(ion)?|boner|cum\b|cumming|orgasm|ejaculat|aroused|hard\s*on)\b/i,
  /\b(pin\s*(him|her|them)\s*down|tie\s*(him|her|them)\s*up|bondage|spanking|spank\s*(him|her|me)|dom(inat(e|ion))?|submission|sub\s*to)\b/i,
  /\b(makeout|make\s*out|making\s*out|french\s*kiss|kiss\s*(him|her|them)\s*(deeply|hungrily|hard))\b/i,
  /\b(edge\s*(him|her|them)|tease\s*(his|her|their|my)\s*(cock|dick|pussy|clit)|masturbat)\b/i,
  /\b(doggy(\s*style)?|missionary|cowgirl|reverse\s*cowgirl|69\b|sixty.?nine)\b/i,
];

// ── Tagalog (Filipino) explicit patterns ──────────────────────────────────────
// Add more language groups below: _EP_ES, _EP_ID, etc.
const _EP_TL = [
  /\b(kantot|kantutin|magkantot|kantutan|kinantot|pakantot)\b/i,   // intercourse
  /\b(jakol|jakolihin|magjakol|nagjajakol|jakolin)\b/i,             // masturbation (male)
  /\b(chupa|chupahin|magchupa|nagchuchupa|ichupa)\b/i,              // oral sex
  /\b(tite|oten|burat)\b/i,                                          // penis
  /\b(puke|pek-pek|pekpek)\b/i,                                     // vagina
  /\b(tamod)\b/i,                                                     // ejaculate
  /\b(malibog|kalibugan|nalibugan)\b/i,                              // horny/lust
  /\b(halayin|halayan)\b/i,                                           // grope/molest
];

export const EXPLICIT_PATTERNS = [..._EP_EN, ..._EP_TL];

export function isExplicit(input) {
  const n = input.toLowerCase().trim();
  return EXPLICIT_PATTERNS.some(p => p.test(n));
}

// Detects VIEWING/RECEIVING explicit content (not performing an act).
// When true, routes to PATH_2_NOVEL instead of PATH_1_EXPLICIT.
export function isPassiveExplicit(input) {
  const n = input.toLowerCase();
  // If active explicit acts are present, it is NOT purely passive
  const _activeActs = [
    /\b(fuck|screw|bang|rail|nail|shag|bone|plow|pound|penetrat)\b/i,
    /\b(blowjob|blow\s*job|fellatio|cunnilingus|go\s*down\s*on)\b/i,
    /\bjerk(s|ed)?\s*(off|it)\b/i,
    /\bstroke\s+(his|her|their|my)\s*(cock|dick|pussy|clit)\b/i,
    /\b(finger\s*bang|handjob|masturbat|makeout|french\s*kiss)\b/i,
  ];
  if (_activeActs.some(p => p.test(n))) return false;
  // Detect passive viewing/receiving patterns
  const _viewPatterns = [
    /\b(receive[sd]?|got|someone|friend|he|she|they)\s+(sent?|sends?|messaged?|shared?|forward)\b/i,
    /\b(dick|cock|nude|naked|explicit|lewd)\s*(pic|pick|photo|picture|image|video|snap|selfie)\b/i,
    /\bphone\s+(notif|notified|rang|buzz|beeped?|alert)\b/i,
    /\b(check(ed)?|look(ed)?|open(ed)?|saw|see|view(ed)?|watch(ed)?)\s+.{0,60}(notification|notif|message|pic|photo|image|video|phone|screen|nude|naked)\b/i,
    /\b(message[sd]?|sent|text(ed)?)\s+.{0,50}(pic|photo|image|dick|nude|naked)\b/i,
  ];
  return _viewPatterns.some(p => p.test(n));
}

// ─── EXPLICIT ACTIVITY CLASSIFICATION ────────────────────────────────────────
// Pattern-based — not keyword lists. Returns an activity key for EXPLICIT_ACTIVITY_TABLE.

export function classifyExplicitActivity(input) {
  const n = input.toLowerCase();
  if (/\b(fuck|intercourse|rail|pound|bang|screw|shag|bone|plow|ride|mount|straddle|cowgirl|missionary|doggy|thrust|penetrat|inside\s*her|inside\s*him)\b/.test(n)) return 'intercourse';
  if (/\b(blow|suck(ing)?\s*(his|him|cock|dick)|fellatio|go\s*down\s*on\s*him|give\s*(him|a)\s*(head|blowjob))\b/.test(n)) return 'oral_giving';
  if (/\b(eat\s*(her|out|pussy)|cunnilingus|go\s*down\s*on\s*her|lick\s*(her|pussy)|give\s*(her)\s*head)\b/.test(n)) return 'oral_giving';
  if (/\b(get\s*(sucked|a\s*blowjob)|(he|she|they)\s*(sucks?|blows?|licks?|eats?))\b/i.test(n)) return 'oral_receiving';
  if (/\b(he|she|they)\b.{0,40}\b(go(es)?\s*down|eat(s|ing)?(\s*out)?|lick(s|ing)?)\b/i.test(n)) return 'oral_receiving';
  if (/\b(suck|lick|blow|eat)\b.{0,40}\b(your|my)\b.{0,20}\b(cock|dick|pussy|clit|ass)\b/i.test(n)) return 'oral_receiving';
  if (/\b(finger|jerk\s*(him|her)\s*off|handjob|stroke\s*(his|her)\s*(cock|dick|pussy|clit))\b/.test(n)) return 'manual_giving';
  if (/\b(gets?\s*fingered|(he|she|they)\s*(fingers|strokes?|jerks?|rubs?|squeez))\b/i.test(n)) return 'manual_receiving';
  if (/\b(he|she|they)\b.{0,60}\b(jerk|stroke|rub|squeeze|wrap|grab)\b.{0,40}\b(your|my)\b.{0,20}\b(cock|dick|pussy|clit)\b/i.test(n)) return 'manual_receiving';
  if (/\bwrap\b.{0,30}\b(his|her|their)\b.{0,20}\bhand\b.{0,50}\b(cock|dick|pussy|clit|it)\b/i.test(n)) return 'manual_receiving';
  if (/\bjerk\b.{0,30}\b(it|you|him|her)\b.{0,10}\boff\b/i.test(n)) return 'manual_receiving';
  if (/\b(makeout|make\s*out|making\s*out|french\s*kiss)\b/.test(n)) return 'makeout';
  if (/\b(masturbat|touch\s*myself|jerk\s*off\s*alone|solo|rub\s*(one|myself))\b/.test(n)) return 'solo_masturbation';
  if (/\b(69|sixty.?nine|mutual|each\s*other)\b/.test(n)) return 'mutual_masturbation';
  if (/\b(doggy(\s*style)?|missionary|cowgirl|reverse\s*cowgirl|69\b|sixty.?nine)\b/.test(n)) return 'mutual_masturbation';
  // Catch loose patterns missed above
  if (/\bsuck(ing)?\s+(it|him|them|that|his)\b/i.test(n)) return 'oral_giving';
  if (/\bblow(ing)?\s+(it|him|them)\b/i.test(n)) return 'oral_giving';
  if (/\bjerk\s+it\s+off\b/i.test(n)) return 'manual_giving';
  if (/\bstroke\s+(it|him|them)\b/i.test(n)) return 'manual_giving';
  if (/\bsuck(ing)?\b.{0,60}\bcum\b/i.test(n)) return 'oral_giving';
  // Tagalog classification
  if (/\b(kantot|kantutin|magkantot|kantutan|kinantot)\b/i.test(n)) return 'intercourse';
  if (/\b(jakol|jakolihin|magjakol|nagjajakol|jakolin)\b/i.test(n)) return 'solo_masturbation';
  if (/\b(chupa|chupahin|magchupa|nagchuchupa|ichupa)\b/i.test(n)) return 'oral_giving';
  if (/\b(puke|pek-pek|pekpek|tite|oten|burat)\b/i.test(n)) return 'intercourse';
  return 'solo_masturbation'; // safe fallback when no partner act can be identified — prevents inventing a partner
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
  refused_explicit:    { mood: -5, social: -8 },
  refused_light:       { mood: -3, social: -5 },
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
  /\b(wait|idle|do\s*nothing|pass\s*(the\s*)?time|kill\s*time|autopilot|time\s*jump)\b/i,
  /\b(attend\s*class|attend\s*school|finish\s*class|finish\s*school|end\s*of\s*class|end\s*of\s*school|go\s*to\s*school)\b/i,
];

export function routeInput(input) {
  if (isExplicit(input)) {
    // Player is WITNESSING explicit acts (parents having sex, etc.) - route as novel
    if (isWitnessingExplicit(input)) return ROUTE.PATH_2_NOVEL;
    // Viewing/receiving explicit content ≠ performing an act — classify via Gemini instead
    // Player is a WITNESS to explicit content, not a participant
    if (isPassiveExplicit(input)) return ROUTE.PATH_2_NOVEL;
    // Player is PERFORMING explicit content
    if (!hasThirdPartyPresence(input)) return ROUTE.PATH_1_EXPLICIT;
    // Player is PARTICIPATING in explicit content with others
    return ROUTE.PATH_1_EXPLICIT;
  }
  // Check for autopilot patterns, but exclude "going to sleep" when it's about others
  const isAutopilot = AUTOPILOT_PATTERNS.some(p => p.test(input));
  // Don't route as autopilot if the input is about someone else going to sleep
  if (isAutopilot && /\b(they|he|she|father|mother|parents?)\b.{0,30}\b(going to|go to|wants to|will)\b.{0,20}\b(sleep|bed)\b/i.test(input)) {
    return ROUTE.PATH_2_NOVEL;
  }
  if (isAutopilot) return ROUTE.PATH_3_AUTOPILOT;
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

// ─── THIRD-PARTY PRESENCE DETECTION ──────────────────────────────────────────
// Called only after isExplicit() confirms the input is explicit content.
// Detects whether another person is physically described in the scene.
export function hasThirdPartyPresence(input) {
  const n = input.toLowerCase();
  return (
    // He/she/they performs a sexual or approach action
    /\b(he|she|they)\b.{0,80}\b(suck|blow|jerk|stroke|grab|fuck|ride|finger|lick|eat|wrap|ask(s|ed)?|want(s|ed)?|offer(s|ed)?|come|sit|enter|approach|touch|kiss)\b/i.test(n)
    // Their body part in contact
    || /\b(his|her|their)\b.{0,30}\b(hand|mouth|lips|tongue|finger)\b.{0,60}\b(your|my|cock|dick|pussy|clit|it)\b/i.test(n)
    // Named relationship doing something explicitly sexual or approaching
    || /\b(brother|sister|friend|cousin|neighbor|roommate|classmate|coworker|boyfriend|girlfriend|guy|girl|man|woman)\b.{0,150}\b(suck|blow|jerk|stroke|fuck|finger|kiss|ask|want|offer|come|sit|enter|approach|touch)\b/i.test(n)
    // Someone asking/offering sexual activity
    || /\b(ask(s|ed)?|want(s|ed)?|offer(s|ed)?)\b.{0,80}\b(to\s+)?(suck|blow|jerk|stroke|fuck|have\s+sex)\b/i.test(n)
  );
}

// ─── WITNESS DETECTION ───────────────────────────────────────────────────────────
// Detects when player is WITNESSING explicit acts (not participating)
// Used to prevent applying explicit stat deltas to witnesses
export function isWitnessingExplicit(input) {
  const n = input.toLowerCase();
  // Patterns for witnessing explicit acts
  const _witnessPatterns = [
    /\b(your|the)\s+(parents?|mother|father|brother|sister)\s+(fuck|screw|have\s*sex|make\s*love|are\s*doing\s*it)\b/i,
    /\b(parents?\s+fuck|parents?\s+are\s+doing\s*it|parents?\s+make\s*love)\b/i,
    /\b(witness|watch|see|saw|spying|peek(ing|ed)?|eavesdrop)\b.{0,80}\b(fuck|sex|intercourse|naked|nude)\b/i,
    /\b(caught|walk\s*in|walked\s*in|interrupt)\b.{0,60}\b(on\s*)?(them|them having sex|them fucking|them making love)\b/i,
  ];
  return _witnessPatterns.some(p => p.test(n));
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
