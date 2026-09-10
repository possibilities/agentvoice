import {
  appearanceGroups,
  appearanceOf,
  applyAppearanceGroup,
  equalSharedAppearance,
} from "./appearance.ts";
import { haloColorStates, haloMotionFields } from "./halo.ts";
import { initializeIconControls, renderIcons, renderLauncher } from "./icons-ui.ts";
import { type MutedMotion, mutedTuningAmounts } from "./muted-presence.ts";
import {
  type Activity,
  type Connection,
  equalLayout,
  equalVisualSettings,
  type Mode,
  type MutedPresence,
  modes,
  type PhoneState,
  type PresenceScope,
  type Preview,
  type Profile,
  previewOf,
  profileLayout,
  profileSharedAppearance,
  profileSounds,
  profileVisualSettings,
  sameOrientation,
  type Theme,
} from "./protocol.ts";
import { type ResetTarget, resetPreview } from "./resets.ts";
import { equalSounds, type SoundFamily } from "./sounds.ts";
import { visibleSpacingFields } from "./spacing.ts";
import type { SpiritSelection } from "./spirit.ts";
import { type TraceSelection, traceAmountFields } from "./traces.ts";

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
let openingCredits = false;
let changed = false;
let edit = 0;
let resetting = false;
let draftFailure: string | null = null;
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
  error.hidden = !(saveFailure || draftFailure || transientFailure);
  text(error, saveFailure || draftFailure || transientFailure || "");
  element("connection").dataset["connected"] = String(connected);
  element("connection-text").textContent = connected ? "Phone linked" : "Waiting for phone";
  controls.disabled = !connected || saving || openingCredits;
  element<HTMLButtonElement>("icon-credits").disabled =
    !connected || inFlight || changed || saving || openingCredits;
  text(element("icon-credits"), openingCredits ? "Opening credits…" : "Credits on phone");
  save.disabled = !connected || inFlight || changed || saving || openingCredits;
  save.textContent = saving ? (resetting ? "Resetting…" : "Saving…") : "Save profile";
  element<HTMLButtonElement>("reset-production").disabled = save.disabled;
  renderLauncher(draft?.launcher ?? "current", !connected || saving || openingCredits);
  if (!status || !draft) return;
  element("device").textContent =
    `Previewing on ${status.device} · ${draft.orientation === "portrait" ? "Portrait" : "Landscape"}`;
  const orientationLabel = draft.orientation === "portrait" ? "Portrait" : "Landscape";
  text(element("local-layout-scope"), `${orientationLabel} only`);
  for (const group of appearanceGroups) {
    const customized = draft.appearanceOverrides.includes(group);
    element<HTMLInputElement>(`override-${group}`).checked = customized;
    text(element(`override-${group}-label`), `Customize ${orientationLabel}`);
    text(element(`scope-${group}`), customized ? `${orientationLabel} only` : "Shared");
  }
  renderIcons(draft.icons);
  element<HTMLSelectElement>("sound-family").value = draft.sounds.family;
  element<HTMLInputElement>("sound-volume").value = String(draft.sounds.volumePercent);
  text(element("sound-volume-value"), `${draft.sounds.volumePercent}%`);
  element("sound-volume").setAttribute("aria-valuetext", `${draft.sounds.volumePercent} percent`);
  element<HTMLSelectElement>("preview-theme").value = draft.theme;
  element<HTMLSelectElement>("muted-presence").value = draft.mutedPresence;
  element("presence-scope-row").hidden =
    draft.mutedPresence === "tide" || draft.mutedPresence === "off";
  element<HTMLSelectElement>("presence-scope").value = draft.presenceScope;
  element("presence-contacts-hint").hidden = draft.mutedPresence !== "contacts";
  element<HTMLFieldSetElement>("muted-appearance").disabled = draft.mutedPresence === "off";
  element<HTMLSelectElement>("muted-motion").value = draft.mutedTuning.motion;
  for (const field of mutedTuningAmounts) {
    const amount = draft.mutedTuning[field];
    const unit = field === "textSizeSp" ? " sp" : field === "cycleSeconds" ? " s" : "%";
    element<HTMLInputElement>(`muted-${field}`).value = String(amount);
    text(element(`muted-${field}-value`), `${amount}${unit}`);
    element(`muted-${field}`).setAttribute(
      "aria-valuetext",
      `${amount}${unit === "%" ? " percent" : unit}`,
    );
  }
  element("section-separation-row").hidden = true;
  element("portrait-spacing-hint").hidden = draft.orientation !== "portrait";
  for (const field of visibleSpacingFields) {
    const amount = draft.design.spacing[field];
    const custom = field === "paddingDp" && amount === -1;
    element<HTMLInputElement>(`spacing-${field}`).value = String(custom ? 16 : amount);
    text(element(`spacing-${field}-value`), custom ? "Custom" : `${amount} dp`);
    element(`spacing-${field}`).setAttribute(
      "aria-valuetext",
      custom ? "Custom padding" : `${amount} dp`,
    );
  }
  element<HTMLSelectElement>("trace-pattern").value = draft.design.traces.pattern;
  for (const field of traceAmountFields) {
    const amount = draft.design.traces[field];
    element<HTMLInputElement>(`trace-${field}`).value = String(amount);
    const unit = field.endsWith("Dp") ? " dp" : "%";
    const off = amount === 0 && field === "glowPercent";
    text(element(`trace-${field}-value`), off ? "Off" : `${amount}${unit}`);
    element(`trace-${field}`).setAttribute(
      "aria-valuetext",
      off ? "Off" : `${amount}${unit === "%" ? " percent" : unit}`,
    );
  }
  element<HTMLSelectElement>("connection-preview").value = draft.connection;
  element<HTMLSelectElement>("preview-activity").value = draft.activity;
  element<HTMLSelectElement>("spirit-surface").value = draft.spirit.surface;
  element<HTMLSelectElement>("spirit-persona").value = draft.spirit.persona;
  element<HTMLInputElement>("spirit-strength").value = String(draft.spirit.strengthPercent);
  text(element("spirit-strength-value"), `${draft.spirit.strengthPercent}%`);
  element("spirit-strength").setAttribute(
    "aria-valuetext",
    `${draft.spirit.strengthPercent} percent`,
  );
  text(
    element("controls-extent-label"),
    draft.orientation === "landscape" ? "Controls width" : "Controls height",
  );
  const activeExtent = draft.showPushToTalk
    ? draft.design.controlsHeightDp
    : draft.design.controlsWithoutPttDp;
  controlHeight.value = String(activeExtent);
  text(
    element("controls-extent-scope"),
    draft.showPushToTalk ? "With push to talk" : "Without push to talk",
  );
  holdShare.value = String(draft.design.holdSharePercent);
  text(
    element("hold-share-hint"),
    draft.orientation === "landscape" ? "Of controls width" : "Of controls height",
  );
  text(
    element("push-to-talk-hidden-hint"),
    draft.orientation === "landscape"
      ? "Push to talk is hidden. The stacked mute column uses its own saved deck width; the width share is kept for when you show it again."
      : "Push to talk is hidden. The mute buttons use their own saved controls height; the height share is kept for when you show it again.",
  );
  holdShare.disabled = !draft.showPushToTalk;
  text(
    element("controls-height-hint"),
    draft.orientation === "landscape"
      ? "Deck width is limited only by the viewport and Shared padding. Controls can overlap Persona; height fills the padded viewport."
      : draft.showPushToTalk
        ? "All three buttons"
        : "Both mute buttons",
  );
  element<HTMLInputElement>("show-push-to-talk").checked = draft.showPushToTalk;
  element("push-to-talk-hidden-hint").hidden = draft.showPushToTalk;
  text(element("controls-height-value"), `${activeExtent} dp`);
  text(element("hold-share-value"), `${Number(draft.design.holdSharePercent.toFixed(1))}%`);
  controlHeight.setAttribute("aria-valuetext", `${activeExtent} dp`);
  holdShare.setAttribute("aria-valuetext", `${draft.design.holdSharePercent.toFixed(1)} percent`);
  const contained = draft.halo.variant === "contained";
  element("original-traces-hint").hidden = contained;
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
  const axisValue =
    draft.orientation === "landscape" ? draft.horizontalOffsetDp : draft.verticalOffsetDp;
  text(
    element("position-label"),
    draft.orientation === "landscape" ? "Horizontal position" : "Vertical position",
  );
  text(
    element("position-min-label"),
    draft.orientation === "landscape" ? "−200 (left)" : "−200 (up)",
  );
  text(
    element("position-max-label"),
    draft.orientation === "landscape" ? "+200 (right)" : "+200 (down)",
  );
  position.value = String(axisValue);
  const offset = `${axisValue > 0 ? "+" : ""}${axisValue}`;
  position.setAttribute("aria-valuetext", `${offset} dp`);
  element("position-value").replaceChildren(
    document.createTextNode(offset),
    Object.assign(document.createElement("span"), { textContent: "dp" }),
  );
  const otherOrientation = draft.orientation === "portrait" ? "landscape" : "portrait";
  const hostMatches =
    status.hostSaved &&
    status.hostSaved.version === 20 &&
    equalVisualSettings(profileVisualSettings(status.hostSaved), draft) &&
    equalSounds(profileSounds(status.hostSaved), draft.sounds) &&
    equalLayout(profileLayout(status.hostSaved, draft.orientation), draft) &&
    equalLayout(profileLayout(status.hostSaved, otherOrientation), status.state.otherLayout) &&
    equalSharedAppearance(profileSharedAppearance(status.hostSaved), status.state.sharedAppearance);
  const phoneMatches =
    equalVisualSettings(draft, status.state.savedAppearance) &&
    equalSounds(draft.sounds, status.state.savedSounds) &&
    equalLayout(draft, {
      scales: status.state.savedScales,
      verticalOffsetDp: status.state.savedVerticalOffsetDp,
      horizontalOffsetDp: status.state.savedHorizontalOffsetDp,
      appearanceOverrides: status.state.savedAppearanceOverrides,
      design: status.state.savedDesign,
      halo: status.state.savedHalo,
      spirit: status.state.savedSpirit,
      personaSide: status.state.savedPersonaSide,
    }) &&
    equalLayout(status.state.otherLayout, status.state.savedOtherLayout) &&
    equalSharedAppearance(status.state.sharedAppearance, status.state.savedSharedAppearance);
  text(
    feedback,
    !connected
      ? status.reconnecting
        ? "Return to the Halo preview. It will reconnect automatically."
        : "Waiting for the host configurator…"
      : saving
        ? resetting
          ? "Restoring production design…"
          : "Saving to phone and host…"
        : inFlight || changed
          ? "Updating the phone…"
          : !phoneMatches
            ? "Draft kept on phone · not exported"
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
  let selection = structuredClone(draft);
  const currentAppearance = appearanceOf(status.state);
  for (const group of appearanceGroups) {
    if (
      selection.appearanceOverrides.includes(group) &&
      !status.state.appearanceOverrides.includes(group)
    )
      selection = applyAppearanceGroup(selection, currentAppearance, group);
    else if (
      !selection.appearanceOverrides.includes(group) &&
      status.state.appearanceOverrides.includes(group)
    )
      selection = applyAppearanceGroup(selection, status.state.sharedAppearance, group);
  }
  // Scope changes settle first; retain queued appearance edits for the next request.
  const stagedAppearance = !equalLayout(selection, draft);
  if (stagedAppearance) changed = true;
  render();
  try {
    status = await api("preview", { ...selection, generation: requestGeneration });
    if (
      !status.connected ||
      status.generation !== requestGeneration ||
      !sameOrientation(selection, status.state)
    )
      changed = false;
    if ((edit === requestEdit && !stagedAppearance) || !changed) draft = previewOf(status.state);
    transientFailure = null;
    draftFailure = null;
  } catch (failure) {
    draftFailure = "Draft was not confirmed on the phone. Review the values and retry the edit.";
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
  if (!draft || !status?.connected || saving || openingCredits) return;
  draft = change(draft);
  edit++;
  changed = true;
  render();
  void flush();
}

element<HTMLInputElement>("show-push-to-talk").addEventListener("change", (event) => {
  const showPushToTalk = (event.currentTarget as HTMLInputElement).checked;
  update((current) => ({ ...current, showPushToTalk }));
});

element<HTMLSelectElement>("sound-family").addEventListener("change", (event) => {
  const family = (event.currentTarget as HTMLSelectElement).value as SoundFamily;
  update((current) => ({ ...current, sounds: { ...current.sounds, family } }));
});
element<HTMLInputElement>("sound-volume").addEventListener("input", (event) => {
  const volumePercent = (event.currentTarget as HTMLInputElement).valueAsNumber;
  update((current) => ({ ...current, sounds: { ...current.sounds, volumePercent } }));
});

for (const group of appearanceGroups) {
  element<HTMLInputElement>(`override-${group}`).addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    update((current) => {
      const appearanceOverrides = appearanceGroups.filter((item) =>
        item === group ? checked : current.appearanceOverrides.includes(item),
      );
      const next = { ...current, appearanceOverrides };
      return checked ? next : applyAppearanceGroup(next, status!.state.sharedAppearance, group);
    });
  });
}
element<HTMLSelectElement>("preview-theme").addEventListener("change", (event) => {
  const theme = (event.currentTarget as HTMLSelectElement).value as Theme;
  update((current) => ({ ...current, theme }));
});
element<HTMLSelectElement>("muted-presence").addEventListener("change", (event) => {
  const mutedPresence = (event.currentTarget as HTMLSelectElement).value as MutedPresence;
  update((current) => ({ ...current, mutedPresence }));
});
element<HTMLSelectElement>("presence-scope").addEventListener("change", (event) => {
  const presenceScope = (event.currentTarget as HTMLSelectElement).value as PresenceScope;
  update((current) => ({ ...current, presenceScope }));
});
element<HTMLSelectElement>("muted-motion").addEventListener("change", (event) => {
  const motion = (event.currentTarget as HTMLSelectElement).value as MutedMotion;
  update((current) => ({ ...current, mutedTuning: { ...current.mutedTuning, motion } }));
});
for (const field of mutedTuningAmounts) {
  element<HTMLInputElement>(`muted-${field}`).addEventListener("input", (event) => {
    const amount = (event.currentTarget as HTMLInputElement).valueAsNumber;
    update((current) => ({ ...current, mutedTuning: { ...current.mutedTuning, [field]: amount } }));
  });
}
for (const field of visibleSpacingFields) {
  element<HTMLInputElement>(`spacing-${field}`).addEventListener("input", (event) => {
    const amount = (event.currentTarget as HTMLInputElement).valueAsNumber;
    update((current) => ({
      ...current,
      design: { ...current.design, spacing: { ...current.design.spacing, [field]: amount } },
    }));
  });
}
element<HTMLSelectElement>("trace-pattern").addEventListener("change", (event) => {
  const pattern = (event.currentTarget as HTMLSelectElement).value as TraceSelection["pattern"];
  update((current) => ({
    ...current,
    design: { ...current.design, traces: { ...current.design.traces, pattern } },
  }));
});
for (const field of traceAmountFields) {
  element<HTMLInputElement>(`trace-${field}`).addEventListener("input", (event) => {
    const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
    update((current) => ({
      ...current,
      design: { ...current.design, traces: { ...current.design.traces, [field]: value } },
    }));
  });
}
controlHeight.addEventListener("input", () => {
  const controlsHeightDp = controlHeight.valueAsNumber;
  update((current) => ({
    ...current,
    design: {
      ...current.design,
      [current.showPushToTalk ? "controlsHeightDp" : "controlsWithoutPttDp"]: controlsHeightDp,
    },
  }));
});
holdShare.addEventListener("input", () => {
  const holdSharePercent = Math.round(holdShare.valueAsNumber * 10) / 10;
  update((current) => ({ ...current, design: { ...current.design, holdSharePercent } }));
});
initializeIconControls(
  (change) => update((current) => ({ ...current, icons: change(current.icons) })),
  (launcher) => update((current) => ({ ...current, launcher })),
);

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

element<HTMLSelectElement>("preview-activity").addEventListener("change", (event) => {
  const activity = (event.currentTarget as HTMLSelectElement).value as Activity;
  update((current) => ({ ...current, activity }));
});
for (const field of ["surface", "persona"] as const) {
  element<HTMLSelectElement>(`spirit-${field}`).addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value as SpiritSelection[typeof field];
    update((current) => ({ ...current, spirit: { ...current.spirit, [field]: value } }));
  });
}
element<HTMLInputElement>("spirit-strength").addEventListener("input", (event) => {
  const strengthPercent = (event.currentTarget as HTMLInputElement).valueAsNumber;
  update((current) => ({ ...current, spirit: { ...current.spirit, strengthPercent } }));
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
  const offsetDp = position.valueAsNumber;
  update((current) =>
    current.orientation === "landscape"
      ? { ...current, horizontalOffsetDp: offsetDp }
      : { ...current, verticalOffsetDp: offsetDp },
  );
});
element("icon-credits").addEventListener("click", async () => {
  if (!status?.connected || inFlight || changed || saving || openingCredits) return;
  edit++;
  openingCredits = true;
  render();
  try {
    status = await api("icon-credits", {
      generation: status.generation,
      orientation: status.state.orientation,
      orientationEpoch: status.state.orientationEpoch,
    });
    draft = previewOf(status.state);
    transientFailure = null;
  } catch (failure) {
    report(failure);
  } finally {
    openingCredits = false;
    render();
  }
});

element("reset-production").addEventListener("click", async () => {
  if (!status?.connected || inFlight || changed || saving || openingCredits) return;
  edit++;
  saving = true;
  resetting = true;
  render();
  try {
    status = await api("reset-production", {
      revision: status.state.revision,
      generation: status.generation,
      orientation: status.state.orientation,
      orientationEpoch: status.state.orientationEpoch,
    });
    draft = previewOf(status.state);
    transientFailure = null;
    draftFailure = null;
  } catch (failure) {
    draftFailure = "Reset was not confirmed. Review the phone and retry if needed.";
    report(failure);
  } finally {
    saving = false;
    resetting = false;
    render();
  }
});

save.addEventListener("click", async () => {
  if (!status?.connected || inFlight || changed || saving || openingCredits) return;
  edit++;
  saving = true;
  render();
  try {
    status = await api("save", {
      revision: status.state.revision,
      generation: status.generation,
      orientation: status.state.orientation,
      orientationEpoch: status.state.orientationEpoch,
    });
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
  if (!inFlight && !saving && !changed && !openingCredits) {
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
