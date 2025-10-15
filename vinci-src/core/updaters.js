// =============================================================================
// updaters.js - Per-Frame Update System
// =============================================================================

const updaters = [];

// Register a function to be called each frame
export function registerUpdater(fn){
  if (typeof fn === 'function') updaters.push(fn);
}

// Run all registered updaters with provided context
export function runUpdaters(ctx){
  for (let i=0; i<updaters.length; i++){
    const fn = updaters[i];
    try { fn && fn(ctx); } catch {}
  }
}
