import { type Design, equalDesign } from "./design.ts";
import { equalHalo, haloColorStates, haloMotionFields } from "./halo.ts";
import {
  type Connection,
  equalScales,
  type Mode,
  modes,
  type PhoneState,
  type Preview,
  type Profile,
  previewOf,
  profileDesign,
  profileHalo,
} from "./protocol.ts";
import { type ResetTarget, resetPreview } from "./resets.ts";

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
const controlHeight = element<HTMLInputElement>("controls-height");
const holdShare = element<HTMLInputElement>("hold-share");
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
  element<HTMLSelectElement>("design-mute").value = draft.design.mute;
  element<HTMLSelectElement>("design-hold").value = draft.design.hold;
  element<HTMLSelectElement>("design-composition").value = draft.design.composition;
  text(
    element("composition-hint"),
    {
      open: "Persona and controls float freely.",
      dock: "One quiet surface joins Persona and controls.",
      yoke: "A fine fork connects Persona to both channels.",
    }[draft.design.composition],
  );
  element<HTMLSelectElement>("connection-preview").value = draft.connection;
  controlHeight.value = String(draft.design.controlsHeightDp);
  holdShare.value = String(draft.design.holdSharePercent);
  text(element("controls-height-value"), `${draft.design.controlsHeightDp} dp`);
  text(element("hold-share-value"), `${Number(draft.design.holdSharePercent.toFixed(1))}%`);
  controlHeight.setAttribute("aria-valuetext", `${draft.design.controlsHeightDp} dp`);
  holdShare.setAttribute("aria-valuetext", `${draft.design.holdSharePercent.toFixed(1)} percent`);
  const contained = draft.halo.variant === "contained";
  element<HTMLSelectElement>("halo-variant").value = draft.halo.variant;
  element("contained-controls").hidden = !contained;
  text(
    element("size-hint"),
    contained ? "One size across all states" : "Independent size for each state",
  );
  for (const key of haloMotionFields) {
    element<HTMLInputElement>(key).value = String(draft.halo[key]);
    text(element(`${key}-value`), `${draft.halo[key]}%`);
  }
  for (const mode of haloColorStates) {
    element<HTMLInputElement>(`color-${mode}`).value = draft.halo.colors[mode];
    text(element(`color-${mode}-value`), draft.halo.colors[mode]);
  }
  document.documentElement.style.setProperty(
    "--accent",
    contained ? draft.halo.colors[draft.mode] : colors[draft.mode],
  );
  for (const mode of modes) {
    const button = document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!;
    button.setAttribute("aria-pressed", String(draft.mode === mode));
    element(`${mode}-value`).textContent =
      `${contained ? draft.halo.containedSizePercent : draft.scales[mode]}%`;
  }
  element("size-label").textContent = contained
    ? "Contained size"
    : `${draft.mode[0]!.toUpperCase()}${draft.mode.slice(1)} size`;
  element("reset-size").setAttribute(
    "aria-label",
    contained ? "Reset Contained size" : `Reset ${draft.mode} size`,
  );
  const size = contained ? draft.halo.containedSizePercent : draft.scales[draft.mode];
  slider.value = String(size);
  element("size-value").replaceChildren(
    document.createTextNode(String(size)),
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
    equalDesign(profileDesign(status.hostSaved!), draft.design) &&
    equalHalo(profileHalo(status.hostSaved!), draft.halo) &&
    status.hostSaved?.verticalOffsetDp === draft.verticalOffsetDp &&
    modes.every((mode) => Math.round(host[mode] * 100) === draft!.scales[mode]);
  const phoneMatches =
    equalScales(draft.scales, status.state.savedScales) &&
    draft.verticalOffsetDp === status.state.savedVerticalOffsetDp &&
    equalDesign(draft.design, status.state.savedDesign) &&
    equalHalo(draft.halo, status.state.savedHalo);
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

element<HTMLSelectElement>("design-mute").addEventListener("change", (event) => {
  const mute = (event.currentTarget as HTMLSelectElement).value as Design["mute"];
  update((current) => ({ ...current, design: { ...current.design, mute } }));
});
element<HTMLSelectElement>("design-hold").addEventListener("change", (event) => {
  const hold = (event.currentTarget as HTMLSelectElement).value as Design["hold"];
  update((current) => ({ ...current, design: { ...current.design, hold } }));
});
element<HTMLSelectElement>("design-composition").addEventListener("change", (event) => {
  const composition = (event.currentTarget as HTMLSelectElement).value as Design["composition"];
  update((current) => ({ ...current, design: { ...current.design, composition } }));
});
controlHeight.addEventListener("input", () => {
  const controlsHeightDp = controlHeight.valueAsNumber;
  update((current) => ({ ...current, design: { ...current.design, controlsHeightDp } }));
});
holdShare.addEventListener("input", () => {
  const holdSharePercent = Math.round(holdShare.valueAsNumber * 10) / 10;
  update((current) => ({ ...current, design: { ...current.design, holdSharePercent } }));
});
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-reset]")) {
  button.addEventListener("click", () =>
    update((current) =>
      resetPreview(current, status!.state, button.dataset["reset"] as ResetTarget),
    ),
  );
}

element<HTMLSelectElement>("connection-preview").addEventListener("change", (event) => {
  const connection = (event.currentTarget as HTMLSelectElement).value as Connection;
  update((current) => ({ ...current, connection }));
});

element<HTMLSelectElement>("halo-variant").addEventListener("change", (event) => {
  const variant = (event.currentTarget as HTMLSelectElement).value as "original" | "contained";
  update((current) => ({ ...current, halo: { ...current.halo, variant } }));
});
for (const key of haloMotionFields) {
  element<HTMLInputElement>(key).addEventListener("input", (event) => {
    const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
    update((current) => ({ ...current, halo: { ...current.halo, [key]: value } }));
  });
}
for (const mode of haloColorStates) {
  element<HTMLInputElement>(`color-${mode}`).addEventListener("input", (event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    update((current) => ({
      ...current,
      halo: { ...current.halo, colors: { ...current.halo.colors, [mode]: value } },
    }));
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
  button.addEventListener("click", () =>
    update((current) => ({ ...current, mode: button.dataset["mode"] as Mode })),
  );
}
slider.addEventListener("input", () => {
  const value = slider.valueAsNumber;
  update((current) =>
    current.halo.variant === "contained"
      ? { ...current, halo: { ...current.halo, containedSizePercent: value } }
      : { ...current, scales: { ...current.scales, [current.mode]: value } },
  );
});
position.addEventListener("input", () => {
  const verticalOffsetDp = position.valueAsNumber;
  update((current) => ({ ...current, verticalOffsetDp }));
});
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
