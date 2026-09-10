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
  layoutOf,
  type Mode,
  type MutedPresence,
  modes,
  orientations,
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
  savedStateLayouts,
  stateLayouts,
  type Theme,
} from "./protocol.ts";
import { type ResetTarget, resetPreview } from "./resets.ts";
import { equalSounds, type SoundFamily } from "./sounds.ts";
import { visibleSpacingFields } from "./spacing.ts";
import type { SpiritSelection } from "./spirit.ts";
import { type TraceSelection, traceAmountFields } from "./traces.ts";

type Target = { serial: string; label: string };
type Targets = {
  revision: number;
  selected: string | null;
  devices: Target[];
  scanning: boolean;
  error?: string;
};
type Status = {
  captureAvailable: boolean;
  connected: boolean;
  reconnecting: boolean;
  generation: number;
  disconnectReason?: string;
  state: PhoneState | null;
  device: string;
  savePath: string;
  hostSaved: Profile | null;
  targets?: Targets;
  selectionEpoch?: number;
};
type Capture = {
  id: string;
  createdAt: string;
  restored: boolean;
  frames: {
    orientation: "portrait" | "landscape" | "portrait-reverse" | "landscape-reverse";
    width: number;
    height: number;
    url: string;
  }[];
};
type CaptureResponse = Status & { capture: Capture };
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw Error(`Missing element: ${id}`);
  return found as T;
}
const controls = element<HTMLFieldSetElement>("controls");
const targetPicker = element<HTMLElement>("target-picker");
const targetHint = element("target-hint");
const targetList = element("target-list");
const refreshTargets = element<HTMLButtonElement>("refresh-targets");
const linkTarget = element<HTMLButtonElement>("link-target");
const releaseTarget = element<HTMLButtonElement>("release-target");
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
let openingConnection = false;
let capturing = false;
let capture: Capture | null = null;
let changed = false;
let edit = 0;
let resetting = false;
let draftFailure: string | null = null;
let saveFailure: string | null = null;
let transientFailure: string | null = null;
let targetChoice: string | null = null;
let targetRequest = false;

function isPicker(
  current = status,
): current is Status & { targets: Targets; selectionEpoch: number } {
  return current?.targets !== undefined && current.selectionEpoch !== undefined;
}

function selectionBusy(): boolean {
  return (
    inFlight ||
    saving ||
    capturing ||
    openingCredits ||
    openingConnection ||
    changed ||
    targetRequest
  );
}

function acceptsEpoch(epoch: number | undefined): boolean {
  return epoch === undefined || status?.selectionEpoch === epoch;
}

function acceptStatus(next: Status, adoptDraft = false): void {
  const changedEpoch =
    status?.selectionEpoch !== undefined &&
    next.selectionEpoch !== undefined &&
    status.selectionEpoch !== next.selectionEpoch;
  if (changedEpoch) {
    edit++;
    changed = false;
    draft = null;
    capture = null;
    draftFailure = null;
    saveFailure = null;
    transientFailure = null;
    targetChoice = null;
  }
  status = next;
  if (!next.state) {
    draft = null;
    capture = null;
  } else if (changedEpoch || adoptDraft) {
    draft = previewOf(next.state);
  }
}

function orientationLabel(orientation: Preview["orientation"]): string {
  return (
    {
      portrait: "Portrait",
      landscape: "Landscape",
      "portrait-reverse": "Reverse portrait",
      "landscape-reverse": "Reverse landscape",
    } as const
  )[orientation];
}

function isLandscape(orientation: Preview["orientation"]): boolean {
  return orientation === "landscape" || orientation === "landscape-reverse";
}

function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

function renderCapture() {
  const gallery = element("capture-gallery");
  gallery.hidden = !capture;
  const frames = element("capture-frames");
  frames.replaceChildren();
  if (!capture) return;
  for (const frame of capture.frames) {
    const card = document.createElement("figure");
    const image = document.createElement("img");
    image.src = frame.url;
    image.alt = `${orientationLabel(frame.orientation)} capture`;
    const original = document.createElement("a");
    original.href = frame.url;
    original.textContent = "Original PNG";
    original.download = `agentvoice-${frame.orientation}.png`;
    const caption = document.createElement("figcaption");
    caption.textContent = `${orientationLabel(frame.orientation)} · ${frame.width} × ${frame.height}`;
    card.append(image, caption, original);
    frames.append(card);
  }
}

async function downloadComparison() {
  if (!capture) return;
  const frames = await Promise.all(
    capture.frames.map(async (frame) => {
      const image = new Image();
      image.src = frame.url;
      await image.decode();
      return { ...frame, image };
    }),
  );
  const gutter = 32,
    labelHeight = 64;
  const columnWidths = [0, 1].map((column) =>
    Math.max(...frames.filter((_, index) => index % 2 === column).map((frame) => frame.width)),
  );
  const rowHeights = [0, 1].map((row) =>
    Math.max(...frames.slice(row * 2, row * 2 + 2).map((frame) => frame.height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = columnWidths[0]! + columnWidths[1]! + gutter * 3;
  canvas.height = rowHeights[0]! + rowHeights[1]! + labelHeight * 2 + gutter * 3;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Could not compose the capture comparison.");
  context.fillStyle = "#17191d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "28px sans-serif";
  context.fillStyle = "#f0f2f5";
  for (const [index, frame] of frames.entries()) {
    const x = gutter + (index % 2 === 0 ? 0 : columnWidths[0]! + gutter);
    const y = gutter + (index < 2 ? 0 : rowHeights[0]! + labelHeight + gutter);
    context.fillText(
      `${orientationLabel(frame.orientation)} · ${frame.width} × ${frame.height}`,
      x,
      y + 36,
    );
    context.drawImage(frame.image, x, y + labelHeight);
  }
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `agentvoice-layouts-${capture.id}.png`;
  link.click();
}

function requestBody(body: unknown): unknown {
  if (
    body === undefined ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    status?.selectionEpoch === undefined
  )
    return body;
  return { ...(body as Record<string, unknown>), selectionEpoch: status.selectionEpoch };
}

async function api<T = Status>(path: string, body?: unknown, timeout = 6000): Promise<T> {
  const response = await fetch(
    `./${path}`,
    body === undefined
      ? { cache: "no-store", signal: AbortSignal.timeout(5000) }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody(body)),
          signal: AbortSignal.timeout(timeout),
        },
  );
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "The host configurator did not answer.");
  return result as T;
}

function renderTargetPicker() {
  const targets = status?.targets;
  targetPicker.hidden = !targets;
  if (!targets) return;
  if (targetChoice && !targets.devices.some((device) => device.serial === targetChoice))
    targetChoice = null;
  const busy = selectionBusy() || targets.scanning;
  refreshTargets.disabled = busy;
  refreshTargets.textContent = targets.scanning ? "Refreshing…" : "Refresh";
  targetList.replaceChildren();
  for (const target of targets.devices) {
    const label = document.createElement("label");
    label.className = "target-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "studio-target";
    input.value = target.serial;
    input.checked = targetChoice === target.serial;
    input.disabled = busy;
    input.addEventListener("change", () => {
      targetChoice = target.serial;
      transientFailure = null;
      render();
    });
    const name = document.createElement("span");
    name.textContent = target.label;
    const serial = document.createElement("small");
    serial.textContent = target.serial;
    label.append(input, name, serial);
    targetList.append(label);
  }
  const idle = targets.selected === null;
  text(
    targetHint,
    targets.error ??
      (idle
        ? targets.devices.length === 0
          ? "Open Studio, connect an authorized USB device, then select Refresh."
          : "Choose the Studio device, then select Link selected device."
        : `Linked to ${targets.selected}. Choose another device when you are ready.`),
  );
  targetList.hidden = !idle;
  linkTarget.hidden = !idle;
  linkTarget.disabled = busy || !idle || targetChoice === null;
  releaseTarget.disabled = busy || targets.selected === null;
  releaseTarget.hidden = targets.selected === null;
}

function report(failure: unknown, isSave = false) {
  const message =
    failure instanceof Error ? failure.message : "Could not reach the host configurator.";
  if (isSave) saveFailure = message;
  else transientFailure = message;
}

function render() {
  const connected = status?.connected === true && status.state !== null;
  renderTargetPicker();
  controls.hidden = status?.targets !== undefined && status.state === null;
  error.hidden = !(saveFailure || draftFailure || transientFailure);
  text(error, saveFailure || draftFailure || transientFailure || "");
  element("connection").dataset["connected"] = String(connected);
  element("connection-text").textContent = connected ? "Phone linked" : "Waiting for phone";
  controls.disabled = !connected || saving || openingCredits || capturing || targetRequest;
  element<HTMLButtonElement>("icon-credits").disabled =
    !connected || inFlight || changed || saving || openingCredits || capturing || targetRequest;
  text(
    element("icon-credits"),
    openingCredits && !openingConnection ? "Opening credits…" : "Credits on phone",
  );
  save.disabled =
    !connected || inFlight || changed || saving || openingCredits || capturing || targetRequest;
  save.textContent = saving ? (resetting ? "Resetting…" : "Saving…") : "Save complete design";
  element<HTMLButtonElement>("reset-production").disabled = save.disabled;
  renderLauncher(
    draft?.launcher ?? "current",
    !connected || saving || openingCredits || capturing || targetRequest,
  );
  const captureButton = element<HTMLButtonElement>("capture-layouts");
  captureButton.disabled =
    !connected ||
    !status?.captureAvailable ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    capturing ||
    targetRequest;
  captureButton.textContent = capturing ? "Capturing all 4 layouts…" : "Capture all 4 layouts";
  renderCapture();
  if (!status?.state || !draft) {
    element("device").textContent = status?.targets
      ? "No Studio device linked"
      : "Native phone preview";
    text(
      feedback,
      status?.targets
        ? "Open Studio, connect an authorized USB device, then select Refresh."
        : "Waiting for the host configurator…",
    );
    const path = element("save-path");
    path.hidden = true;
    path.textContent = "";
    document.documentElement.style.setProperty("--accent", colors.speaking);
    return;
  }
  element("device").textContent =
    `Previewing on ${status.device} · ${orientationLabel(draft.orientation)}`;
  const currentOrientationLabel = orientationLabel(draft.orientation);
  text(element("local-layout-scope"), `${currentOrientationLabel} only`);
  for (const group of appearanceGroups) {
    const customized = draft.appearanceOverrides.includes(group);
    element<HTMLInputElement>(`override-${group}`).checked = customized;
    text(element(`override-${group}-label`), `Customize ${currentOrientationLabel}`);
    text(element(`scope-${group}`), customized ? `${currentOrientationLabel} only` : "Shared");
  }
  element<HTMLSelectElement>("setup-preview").value = status.state.connectionPreview;
  element<HTMLSelectElement>("setup-preview").disabled =
    !connected || inFlight || changed || saving || openingCredits;
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
  element("portrait-spacing-hint").hidden = isLandscape(draft.orientation);
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
    isLandscape(draft.orientation) ? "Controls width" : "Controls height",
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
    isLandscape(draft.orientation) ? "Of controls width" : "Of controls height",
  );
  text(
    element("push-to-talk-hidden-hint"),
    isLandscape(draft.orientation)
      ? "Push to talk is hidden. The stacked mute column uses its own saved deck width; the width share is kept for when you show it again."
      : "Push to talk is hidden. The mute buttons use their own saved controls height; the height share is kept for when you show it again.",
  );
  holdShare.disabled = !draft.showPushToTalk;
  text(
    element("controls-height-hint"),
    isLandscape(draft.orientation)
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
  const axisValue = isLandscape(draft.orientation)
    ? draft.horizontalOffsetDp
    : draft.verticalOffsetDp;
  text(
    element("position-label"),
    isLandscape(draft.orientation) ? "Horizontal position" : "Vertical position",
  );
  text(element("position-min-label"), isLandscape(draft.orientation) ? "−200 (left)" : "−200 (up)");
  text(
    element("position-max-label"),
    isLandscape(draft.orientation) ? "+200 (right)" : "+200 (down)",
  );
  position.value = String(axisValue);
  const offset = `${axisValue > 0 ? "+" : ""}${axisValue}`;
  position.setAttribute("aria-valuetext", `${offset} dp`);
  element("position-value").replaceChildren(
    document.createTextNode(offset),
    Object.assign(document.createElement("span"), { textContent: "dp" }),
  );
  const phoneState = status.state;
  const savedProfile = status.hostSaved;
  const liveLayouts = { ...stateLayouts(phoneState), [draft.orientation]: layoutOf(draft) };
  const hostMatches =
    savedProfile !== null &&
    savedProfile.version === 21 &&
    equalVisualSettings(profileVisualSettings(savedProfile), draft) &&
    equalSounds(profileSounds(savedProfile), draft.sounds) &&
    orientations.every((orientation) =>
      equalLayout(profileLayout(savedProfile, orientation), liveLayouts[orientation]),
    ) &&
    equalSharedAppearance(profileSharedAppearance(savedProfile), phoneState.sharedAppearance);
  const phoneMatches =
    equalVisualSettings(draft, phoneState.savedAppearance) &&
    equalSounds(draft.sounds, phoneState.savedSounds) &&
    orientations.every((orientation) =>
      equalLayout(liveLayouts[orientation], savedStateLayouts(phoneState)[orientation]),
    ) &&
    equalSharedAppearance(phoneState.sharedAppearance, phoneState.savedSharedAppearance);
  text(
    feedback,
    !connected
      ? status.reconnecting
        ? "Open AgentVoice Studio. It will reconnect automatically."
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
  if (inFlight || saving || !changed || !draft || !status?.connected || !status.state) return;
  const currentStatus = status;
  const currentState = currentStatus.state;
  if (!currentState) return;
  const currentDraft = draft;
  const requestEpoch = currentStatus.selectionEpoch;
  inFlight = true;
  changed = false;
  const requestEdit = edit;
  const requestGeneration = currentStatus.generation;
  let selection = structuredClone(currentDraft);
  const currentAppearance = appearanceOf(currentState);
  for (const group of appearanceGroups) {
    if (
      selection.appearanceOverrides.includes(group) &&
      !currentState.appearanceOverrides.includes(group)
    )
      selection = applyAppearanceGroup(selection, currentAppearance, group);
    else if (
      !selection.appearanceOverrides.includes(group) &&
      currentState.appearanceOverrides.includes(group)
    )
      selection = applyAppearanceGroup(selection, currentState.sharedAppearance, group);
  }
  // Scope changes settle first; retain queued appearance edits for the next request.
  const stagedAppearance = !equalLayout(selection, currentDraft);
  if (stagedAppearance) changed = true;
  render();
  try {
    const next = await api("preview", { ...selection, generation: requestGeneration });
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next);
    if (
      !next.connected ||
      next.generation !== requestGeneration ||
      !next.state ||
      !sameOrientation(selection, next.state)
    )
      changed = false;
    if (((edit === requestEdit && !stagedAppearance) || !changed) && next.state)
      draft = previewOf(next.state);
    transientFailure = null;
    draftFailure = null;
  } catch (failure) {
    if (!acceptsEpoch(requestEpoch)) return;
    draftFailure = "Draft was not confirmed on the phone. Review the values and retry the edit.";
    changed = false;
    if (status?.state) draft = previewOf(status.state);
    report(failure);
  } finally {
    inFlight = false;
    render();
    if (changed) void flush();
  }
}

function update(change: (value: Preview) => Preview) {
  if (!draft || !status?.connected || saving || openingCredits || targetRequest) return;
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
      return checked ? next : applyAppearanceGroup(next, status!.state!.sharedAppearance, group);
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
      resetPreview(current, status!.state!, button.dataset["reset"] as ResetTarget),
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
    isLandscape(current.orientation)
      ? { ...current, horizontalOffsetDp: offsetDp }
      : { ...current, verticalOffsetDp: offsetDp },
  );
});
refreshTargets.addEventListener("click", async () => {
  const current = status;
  if (!isPicker(current) || selectionBusy()) return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  targetRequest = true;
  render();
  try {
    const next = await api("targets/refresh", {}, 30000);
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next);
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    targetRequest = false;
    render();
  }
});

linkTarget.addEventListener("click", async () => {
  const current = status;
  const serial = targetChoice;
  if (!isPicker(current) || !serial || selectionBusy()) return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  targetRequest = true;
  render();
  try {
    const next = await api("targets/select", { revision: current.targets.revision, serial }, 45000);
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next, true);
    targetChoice = next.targets?.selected ?? null;
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    targetRequest = false;
    render();
  }
});

releaseTarget.addEventListener("click", async () => {
  const current = status;
  if (!isPicker(current) || current.targets.selected === null || selectionBusy()) return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  targetRequest = true;
  render();
  try {
    const next = await api(
      "targets/select",
      { revision: current.targets.revision, serial: null },
      45000,
    );
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next);
    targetChoice = null;
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    targetRequest = false;
    render();
  }
});

element("setup-preview").addEventListener("change", async () => {
  const current = status;
  if (
    !current?.connected ||
    !current.state ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    targetRequest
  )
    return;
  const scene = element<HTMLSelectElement>("setup-preview").value;
  const requestEpoch = current.selectionEpoch;
  openingConnection = true;
  edit++;
  openingCredits = true;
  render();
  try {
    const next = await api("connection-preview", {
      scene,
      generation: current.generation,
      orientation: current.state.orientation,
      orientationEpoch: current.state.orientationEpoch,
    });
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next, true);
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    openingCredits = false;
    openingConnection = false;
    render();
  }
});

element("icon-credits").addEventListener("click", async () => {
  const current = status;
  if (
    !current?.connected ||
    !current.state ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    targetRequest
  )
    return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  openingCredits = true;
  render();
  try {
    const next = await api("icon-credits", {
      generation: current.generation,
      orientation: current.state.orientation,
      orientationEpoch: current.state.orientationEpoch,
    });
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next, true);
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    openingCredits = false;
    render();
  }
});

element("capture-layouts").addEventListener("click", async () => {
  const current = status;
  if (
    !current?.connected ||
    !current.state ||
    !current.captureAvailable ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    capturing ||
    targetRequest
  )
    return;
  const requestEpoch = current.selectionEpoch;
  capturing = true;
  render();
  try {
    const result = await api<CaptureResponse>(
      "capture-layouts",
      {
        generation: current.generation,
        revision: current.state.revision,
        orientation: current.state.orientation,
        orientationEpoch: current.state.orientationEpoch,
      },
      120000,
    );
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(result, true);
    capture = result.capture;
    transientFailure = null;
  } catch (failure) {
    if (acceptsEpoch(requestEpoch)) report(failure);
  } finally {
    capturing = false;
    render();
  }
});

element("download-comparison").addEventListener("click", () => {
  void downloadComparison().catch((failure) => {
    report(failure);
    render();
  });
});

element("reset-production").addEventListener("click", async () => {
  const current = status;
  if (
    !current?.connected ||
    !current.state ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    targetRequest
  )
    return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  saving = true;
  resetting = true;
  render();
  try {
    const next = await api("reset-production", {
      revision: current.state.revision,
      generation: current.generation,
      orientation: current.state.orientation,
      orientationEpoch: current.state.orientationEpoch,
    });
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next, true);
    transientFailure = null;
    draftFailure = null;
  } catch (failure) {
    if (!acceptsEpoch(requestEpoch)) return;
    draftFailure = "Reset was not confirmed. Review the phone and retry if needed.";
    report(failure);
  } finally {
    saving = false;
    resetting = false;
    render();
  }
});

save.addEventListener("click", async () => {
  const current = status;
  if (
    !current?.connected ||
    !current.state ||
    inFlight ||
    changed ||
    saving ||
    openingCredits ||
    targetRequest
  )
    return;
  const requestEpoch = current.selectionEpoch;
  edit++;
  saving = true;
  render();
  try {
    const next = await api("save", {
      revision: current.state.revision,
      generation: current.generation,
      orientation: current.state.orientation,
      orientationEpoch: current.state.orientationEpoch,
    });
    if (!acceptsEpoch(requestEpoch)) return;
    acceptStatus(next, true);
    saveFailure = null;
    transientFailure = null;
  } catch (failure) {
    if (!acceptsEpoch(requestEpoch)) return;
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
  if (!inFlight && !saving && !changed && !openingCredits && !capturing && !targetRequest) {
    const pollEdit = edit;
    const pollEpoch = status?.selectionEpoch;
    try {
      const next = await api("state");
      if (pollEdit === edit && acceptsEpoch(pollEpoch) && !inFlight && !saving) {
        const recovered = next.connected && transientFailure !== null;
        if (next.connected) transientFailure = null;
        if (recovered || JSON.stringify(status) !== JSON.stringify(next)) {
          acceptStatus(next, true);
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
