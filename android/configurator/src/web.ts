import { type Design, directions, equalDesign, originalDesign } from "./design.ts";
import {
  equalScales,
  type Mode,
  modes,
  type PhoneState,
  type Preview,
  type Profile,
  previewOf,
} from "./protocol.ts";

type Status = {
  connected: boolean;
  reconnecting: boolean;
  generation: number;
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
const position = element<HTMLInputElement>("position");
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
let saveFailure: string | null = null;
let transientFailure: string | null = null;

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

function report(failure: unknown, isSave = false) {
  const message =
    failure instanceof Error ? failure.message : "Could not reach the host configurator.";
  if (isSave) saveFailure = message;
  else transientFailure = message;
}

function render() {
  const connected = status?.connected === true;
  error.hidden = !(saveFailure || transientFailure);
  text(error, saveFailure || transientFailure || "");
  element("connection").dataset["connected"] = String(connected);
  element("connection-text").textContent = connected ? "Phone linked" : "Waiting for phone";
  controls.disabled = !connected || saving;
  save.disabled = !connected || inFlight || changed || saving;
  save.textContent = saving ? "Saving…" : "Save profile";
  if (!status || !draft) return;
  element("device").textContent = `Previewing on ${status.device}`;
  for (const direction of directions) {
    element<HTMLButtonElement>(`direction-${direction.id}`).setAttribute(
      "aria-pressed",
      String(equalDesign(direction.design, draft.design)),
    );
  }
  for (const part of ["header", "mute", "hold"] as const)
    element<HTMLSelectElement>(`design-${part}`).value = draft.design[part];
  text(
    element("design-description"),
    draft.design.layout === "original"
      ? "Current app layout. Choose any component below to start a custom mix."
      : (directions.find((direction) => equalDesign(direction.design, draft!.design))
          ?.description ?? "Your mix. Changes appear on the phone."),
  );
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
  position.value = String(draft.verticalOffsetDp);
  const offset = `${draft.verticalOffsetDp > 0 ? "+" : ""}${draft.verticalOffsetDp}`;
  position.setAttribute("aria-valuetext", `${offset} dp`);
  element("position-value").replaceChildren(
    document.createTextNode(offset),
    Object.assign(document.createElement("span"), { textContent: "dp" }),
  );
  const host = status.hostSaved?.scaleMultipliers;
  const hostMatches =
    host &&
    equalDesign(status.hostSaved?.design ?? originalDesign, draft.design) &&
    status.hostSaved?.verticalOffsetDp === draft.verticalOffsetDp &&
    modes.every((mode) => Math.round(host[mode] * 100) === draft!.scales[mode]);
  const phoneMatches =
    equalScales(draft.scales, status.state.savedScales) &&
    draft.verticalOffsetDp === status.state.savedVerticalOffsetDp &&
    equalDesign(draft.design, status.state.savedDesign);
  text(
    feedback,
    !connected
      ? status.reconnecting
        ? "Return to the Halo preview. It will reconnect automatically."
        : "Waiting for the host configurator…"
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
  if (inFlight || saving || !changed || !draft || !status?.connected) return;
  inFlight = true;
  changed = false;
  const requestEdit = edit;
  const requestGeneration = status.generation;
  const selection = structuredClone(draft);
  render();
  try {
    status = await api("preview", { ...selection, generation: requestGeneration });
    if (!status.connected || status.generation !== requestGeneration) changed = false;
    if (edit === requestEdit || !changed) draft = previewOf(status.state);
    transientFailure = null;
  } catch (failure) {
    changed = false;
    if (status) draft = previewOf(status.state);
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

for (const direction of directions) {
  element(`direction-${direction.id}`).addEventListener("click", () =>
    update((current) => ({ ...current, design: { ...direction.design } })),
  );
}
for (const part of ["header", "mute", "hold"] as const) {
  const select = element<HTMLSelectElement>(`design-${part}`);
  select.addEventListener("change", () =>
    update((current) => ({
      ...current,
      design: { ...current.design, layout: "studio", [part]: select.value } as Design,
    })),
  );
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
position.addEventListener("input", () => {
  const verticalOffsetDp = position.valueAsNumber;
  update((current) => ({ ...current, verticalOffsetDp }));
});
element("reset").addEventListener("click", () =>
  update((current) => ({
    ...current,
    scales: { ...status!.state.defaults },
    verticalOffsetDp: status!.state.defaultVerticalOffsetDp,
  })),
);
save.addEventListener("click", async () => {
  if (!status?.connected || inFlight || changed || saving) return;
  edit++;
  saving = true;
  render();
  try {
    status = await api("save", { revision: status.state.revision, generation: status.generation });
    draft = previewOf(status.state);
    saveFailure = null;
    transientFailure = null;
  } catch (failure) {
    report(
      failure instanceof TypeError || failure instanceof DOMException
        ? Error("Save was not confirmed. Review the preview and host copy before saving again.")
        : failure,
      true,
    );
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
        const recovered = next.connected && transientFailure !== null;
        if (next.connected) transientFailure = null;
        if (recovered || JSON.stringify(status) !== JSON.stringify(next)) {
          status = next;
          draft = previewOf(next.state);
          render();
        }
      }
    } catch (failure) {
      if (status) status = { ...status, connected: false, reconnecting: false };
      report(failure);
      render();
    }
  }
  setTimeout(() => void poll(), 350);
}
void poll();
