export type PanePreference = "agent" | "voice" | "both";

// Presentation belongs to the browser/window, not a transient call incarnation.
export function panePreferenceKey(instance?: string): string {
  return `agentvoice:presentation:v1:${instance ? `kiosk:${instance}` : "browser"}`;
}

export function readPanePreference(instance?: string): PanePreference {
  try {
    const value = localStorage.getItem(panePreferenceKey(instance));
    return value === "agent" || value === "voice" ? value : "both";
  } catch {
    return "both";
  }
}

export function savePanePreference(value: PanePreference, instance?: string): boolean {
  try {
    // A tiny synchronous write on explicit selection, with no unload/debounce gap.
    localStorage.setItem(panePreferenceKey(instance), value);
    return true;
  } catch {
    return false;
  }
}
