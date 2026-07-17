// gameState.js — shared mutable state singleton imported by all sim modules
const S = {
  WS:                  null,   // current world state
  _processTurnCounter: 0,      // race condition guard for NPC callbacks
  _undoStack:          [],     // multi-level undo (SIM_PATCH history)
  _UNDO_MAX:           10,
  _sbClient:           null,   // Supabase client instance
  _imageCache:         {},     // { 'player': dataUrl, npc_id: dataUrl }
  _imgUploadTarget:    null,   // 'player' or an NPC id string
};
export default S;