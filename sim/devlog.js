// devlog.js — global devlog singleton (non-module, loaded before everything else)
window._devlog = (function(){
  const MAX = 1000, _e = [], _l = [];
  let _c = 0;
  const COLORS = { ERROR:'color:#e74c3c;font-weight:bold', API:'color:#5dade2',
    ROUTE:'color:#f39c12;font-weight:bold', TURN:'color:#a569bd', NPC:'color:#e67e22',
    STAT:'color:#808b96', PATCH:'color:#1abc9c;font-weight:bold', SYSTEM:'color:#717d7e',
    CONSOLE:'color:#e91e8c;font-weight:bold' };
  function log(cat, msg, data){
    const entry = {id:++_c, ts:Date.now(), cat, msg, data:data??null};
    _e.push(entry);
    if(_e.length>MAX)_e.shift();
    _l.forEach(fn=>{try{fn(entry);}catch{}});
    console.log('%c['+cat+']', COLORS[cat]??'', msg, data!==null?data:'');
  }
  return {
    error:(m,d)=>log('ERROR',m,d), api:(m,d)=>log('API',m,d),
    route:(m,d)=>log('ROUTE',m,d), turn:(m,d)=>log('TURN',m,d),
    npc:(m,d)=>log('NPC',m,d),     stat:(m,d)=>log('STAT',m,d),
    patch:(m,d)=>log('PATCH',m,d), system:(m,d)=>log('SYSTEM',m,d),
    console_log:(m,d)=>log('CONSOLE',m,d), log,
    get entries(){ return [..._e]; },
    on(fn){ _l.push(fn); },
    off(fn){ const i=_l.indexOf(fn); if(i>=0)_l.splice(i,1); },
    clear(){ _e.splice(0); },
  };
})();