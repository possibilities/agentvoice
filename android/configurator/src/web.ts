import {
  equalScales,
  type Mode,
  modes,
  type PhoneState,
  type Preview,
  type Profile,
} from "./protocol.ts";

type Status = {
  connected: boolean;
  disconnectReason?: string;
  state: PhoneState;
  device: string;
  savePath: string;
  hostSaved: Profile | null;
};
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw Error(`Missing element: ${id}`);
  return found as T;
}
const controls = element<HTMLFieldSetElement>("controls");
const slider = element<HTMLInputElement>("size");
const feedback = element("feedback");
const error = element("error");
const save = element<HTMLButtonElement>("save");
const colors = { speaking: "#bbaaff", listening: "#d4ff72", idle: "#f0f2e9" };
let status: Status | null = null;
let draft: Preview | null = null;
let inFlight = false;
let saving = false;
let changed = false;
let edit = 0;

function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

async function api(path: string, body?: unknown): Promise<Status> {
  const response = await fetch(
    `./${path}`,
    body === undefined
      ? { cache: "no-store", signal: AbortSignal.timeout(5000) }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(6000),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "The host configurator did not answer.");
  return result;
}

function report(failure: unknown) {
  error.hidden = false;
  error.textContent =
    failure instanceof Error ? failure.message : "Could not reach the host configurator.";
}

function render() {
  const connected = status?.connected === true;
  element("connection").dataset["connected"] = String(connected);
  element("connection-text").textContent = connected ? "Phone linked" : "Disconnected";
  controls.disabled = !connected || saving;
  save.disabled = !connected || inFlight || changed || saving;
  save.textContent = saving ? "Saving…" : "Save profile";
  if (!status || !draft) return;
  element("device").textContent = `Previewing on ${status.device}`;
  document.documentElement.style.setProperty("--accent", colors[draft.mode]);
  for (const mode of modes) {
    const button = document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!;
    button.setAttribute("aria-pressed", String(draft.mode === mode));
    element(`${mode}-value`).textContent = `${draft.scales[mode]}%`;
  }
  element("size-label").textContent = `${draft.mode[0]!.toUpperCase()}${draft.mode.slice(1)} size`;
  slider.value = String(draft.scales[draft.mode]);
  element("size-value").replaceChildren(
    document.createTextNode(String(draft.scales[draft.mode])),
    Object.assign(document.createElement("span"), { textContent: "%" }),
  );
  const host = status.hostSaved?.scaleMultipliers;
  const hostMatches =
    host && modes.every((mode) => Math.round(host[mode] * 100) === draft!.scales[mode]);
  const phoneMatches = equalScales(draft.scales, status.state.savedScales);
  text(
    feedback,
    !connected
      ? `${status.disconnectReason ?? "Phone disconnected."} Restart the configurator to reconnect.`
      : saving
        ? "Saving to phone and host…"
        : inFlight || changed
          ? "Updating the phone…"
          : !phoneMatches
            ? "Unsaved changes"
            : hostMatches
              ? "Saved on phone and host"
              : "Loaded from phone. Save keeps a host copy.",
  );
  const path = element("save-path");
  path.hidden = !status.hostSaved;
  path.textContent = status.hostSaved ? status.savePath : "";
}

async function flush() {
  if (inFlight || saving || !changed || !draft) return;
  inFlight = true;
  changed = false;
  const requestEdit = edit;
  const selection = structuredClone(draft);
  render();
  try {
    status = await api("preview", selection);
    if (edit === requestEdit)
      draft = { mode: status.state.mode, scales: { ...status.state.scales } };
    error.hidden = true;
  } catch (failure) {
    changed = false;
    if (status) draft = { mode: status.state.mode, scales: { ...status.state.scales } };
    report(failure);
  } finally {
    inFlight = false;
    render();
    if (changed) void flush();
  }
}

function update(change: (value: Preview) => Preview) {
  if (!draft || !status?.connected || saving) return;
  draft = change(draft);
  edit++;
  changed = true;
  render();
  void flush();
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
  button.addEventListener("click", () =>
    update((current) => ({ ...current, mode: button.dataset["mode"] as Mode })),
  );
}
slider.addEventListener("input", () => {
  const value = slider.valueAsNumber;
  update((current) => ({ ...current, scales: { ...current.scales, [current.mode]: value } }));
});
element("reset").addEventListener("click", () =>
  update((current) => ({ ...current, scales: { ...status!.state.defaults } })),
);
save.addEventListener("click", async () => {
  if (!status?.connected || inFlight || changed || saving) return;
  edit++;
  saving = true;
  render();
  try {
    status = await api("save", { revision: status.state.revision });
    draft = { mode: status.state.mode, scales: { ...status.state.scales } };
    error.hidden = true;
  } catch (failure) {
    report(failure);
  } finally {
    saving = false;
    render();
  }
});

async function poll() {
  if (!inFlight && !saving && !changed) {
    const pollEdit = edit;
    try {
      const next = await api("state");
      if (pollEdit === edit && !inFlight && !saving) {
        if (JSON.stringify(status) !== JSON.stringify(next)) {
          status = next;
          draft = { mode: next.state.mode, scales: { ...next.state.scales } };
          render();
        }
      }
    } catch (failure) {
      if (status) status = { ...status, connected: false };
      report(failure);
      render();
    }
  }
  setTimeout(() => void poll(), 350);
}
void poll();
