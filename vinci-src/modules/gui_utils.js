// =============================================================================
// gui_utils.js - GUI Helper Functions
// =============================================================================

/**
 * Adds a tooltip to a GUI controller
 * @param {Object} ctrl - lil-gui controller instance
 * @param {string} text - Tooltip text
 */
export function setTooltip(ctrl, text) {
  if (!ctrl || !text) return;
  try {
    // Find the controller's DOM element
    const el = ctrl.domElement || ctrl.__li || (ctrl.$input?.parentElement);
    if (el) {
      el.title = String(text);
    }
  } catch {}
}
