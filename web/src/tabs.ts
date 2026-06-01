export type TabId = 'read' | 'edit' | 'clone' | 'identify' | 'console';

const STORAGE_KEY = 'rfid.activeTab';
const TAB_IDS: TabId[] = ['read', 'edit', 'clone', 'identify', 'console'];

export interface TabController {
  show(id: TabId): void;
  active(): TabId;
  onChange(cb: (id: TabId) => void): void;
  setEnabled(id: TabId, enabled: boolean): void;
  isEnabled(id: TabId): boolean;
}

/**
 * Tiny vanilla tab controller. Wires buttons[data-tab=ID] to panels
 * [data-testid=panel-ID] by toggling the `hidden` attribute, sets
 * aria-selected + .active on the buttons, and persists the active tab in
 * sessionStorage.
 */
export function createTabs(): TabController {
  const changeHandlers: Array<(id: TabId) => void> = [];

  function btnFor(id: TabId): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`);
  }
  function panelFor(id: TabId): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="panel-${id}"]`);
  }

  function isEnabled(id: TabId): boolean {
    const b = btnFor(id);
    return !!b && !b.disabled;
  }

  let current: TabId = 'read';

  function show(id: TabId): void {
    if (!isEnabled(id)) return;
    current = id;
    for (const t of TAB_IDS) {
      const b = btnFor(t);
      const p = panelFor(t);
      const isActive = t === id;
      if (b) {
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        b.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      if (p) {
        if (isActive) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      }
    }
    try { sessionStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    changeHandlers.forEach(cb => cb(id));
  }

  function active(): TabId {
    return current;
  }

  function onChange(cb: (id: TabId) => void): void {
    changeHandlers.push(cb);
  }

  function setEnabled(id: TabId, enabled: boolean): void {
    const b = btnFor(id);
    if (!b) return;
    b.disabled = !enabled;
    if (!enabled) {
      b.setAttribute('aria-disabled', 'true');
    } else {
      b.removeAttribute('aria-disabled');
    }
  }

  // Wire button clicks.
  for (const t of TAB_IDS) {
    const b = btnFor(t);
    b?.addEventListener('click', () => show(t));
  }

  // Restore persisted active tab (if enabled); default to 'read'.
  let initial: TabId = 'read';
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY) as TabId | null;
    if (saved && TAB_IDS.includes(saved)) initial = saved;
  } catch { /* ignore */ }
  // If the saved/default tab is disabled at boot, fall back to console.
  if (!isEnabled(initial)) initial = 'console';
  show(initial);

  return { show, active, onChange, setEnabled, isEnabled };
}
