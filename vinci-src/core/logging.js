// =============================================================================
// logging.js - Event Logging Panel
// =============================================================================
import GUI from 'lil-gui';

let logGui = null;
let logDiv = null;
let buffer = [];

export function ensureLogGui() {
  if (logGui) return logGui;
  logGui = new GUI({ width: 310 });
  logGui.domElement.style.position = 'absolute';
  logGui.domElement.style.right = '20px';
  logGui.domElement.style.zIndex = '260';
  try { const t = logGui.domElement.querySelector('.title'); if (t) t.textContent = 'Events Log'; } catch {}

  const dummy = { logs: '' };
  const ctrl = logGui.add(dummy, 'logs');
  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '140px';
  container.style.overflow = 'auto';
  container.style.fontSize = '11px';
  container.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  container.style.lineHeight = '1.35';
  container.style.whiteSpace = 'pre-wrap';
  container.style.padding = '6px 4px';
  container.style.background = 'rgba(0,0,0,0.2)';
  setTimeout(() => {
    try {
      const widget = ctrl.domElement.querySelector('.widget');
      if (widget) {
        while (widget.firstChild) widget.removeChild(widget.firstChild);
        widget.appendChild(container);
      }
      const nameEl = ctrl.domElement.querySelector('.name');
      if (nameEl) nameEl.style.display = 'none';
    } catch {}
  }, 0);
  logDiv = container;
  return logGui;
}

export function logEvent(msg) {
  ensureLogGui();
  const line = (msg?.startsWith('• ') ? msg : `• ${msg}`);
  buffer.push(line);
  if (buffer.length > 200) buffer.shift();
  if (logDiv) {
    logDiv.textContent = buffer.join('\n');
    logDiv.scrollTop = logDiv.scrollHeight;
  }
}

export function getLogGui() { return ensureLogGui(); }
