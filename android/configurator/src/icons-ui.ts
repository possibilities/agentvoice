import {
  type IconCredit,
  type Icons,
  iconCatalog,
  iconStyles,
  type LauncherStyle,
  launcherConcepts,
  pushIconCatalog,
  pushIconPreview,
  pushIconStyles,
  safeCreditLink,
} from "./icons.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw Error(`Missing element: ${id}`);
  return found as T;
}
function previewImage(file: string, label: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = `./icon-previews/${file}`;
  image.alt = label;
  image.width = 44;
  image.height = 44;
  return image;
}
function creditNodes(credit: IconCredit): HTMLElement[] {
  const label = document.createElement("span");
  label.textContent = `${credit.author} · ${credit.tag}`;
  const links = [
    ...(credit.source ? [{ label: "Source", url: credit.source }] : []),
    ...(credit.sources ?? []),
    ...(credit.license ? [{ label: "License", url: credit.license }] : []),
  ].map(({ label, url }) => {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = safeCreditLink(url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
  if (!credit.changes) return [label, ...links];
  const changes = document.createElement("span");
  changes.className = "icon-changes";
  changes.textContent = credit.changes;
  return [label, ...links, changes];
}
let lastIcons = "";
export function renderIcons(icons: Icons) {
  const identity = `${icons.channels}/${icons.push}`;
  if (identity === lastIcons) return;
  lastIcons = identity;
  element<HTMLSelectElement>("channel-icons").value = icons.channels;
  element<HTMLSelectElement>("push-icon").value = icons.push;
  const channel = iconCatalog[icons.channels];
  const labels = ["Human live", "Human muted", "Agent live", "Agent muted"];
  element("channel-icon-preview").replaceChildren(
    ...channel.channels.map((file, index) => {
      const sample = document.createElement("div");
      sample.className = index % 2 ? "icon-sample is-muted" : "icon-sample";
      sample.append(previewImage(file, labels[index]!));
      const caption = document.createElement("span");
      caption.textContent = labels[index]!;
      sample.append(caption);
      return sample;
    }),
  );
  element("channel-icon-credit").replaceChildren(...creditNodes(channel.credit));
  const push = pushIconPreview(icons);
  element("push-icon-preview").replaceChildren(
    previewImage(push.file, pushIconCatalog[icons.push].label),
  );
  element("push-icon-credit").replaceChildren(...creditNodes(push.credit));
}
export function initializeIconControls(
  change: (change: (icons: Icons) => Icons) => void,
  changeLauncher: (launcher: LauncherStyle) => void,
) {
  for (const [id, values, catalog, field] of [
    ["channel-icons", iconStyles, iconCatalog, "channels"],
    ["push-icon", pushIconStyles, pushIconCatalog, "push"],
  ] as const) {
    const select = element<HTMLSelectElement>(id);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = (catalog as Record<string, { label: string }>)[value]!.label;
      select.append(option);
    }
    select.addEventListener("change", () =>
      change((icons) => ({ ...icons, [field]: select.value })),
    );
  }
  const gallery = element("launcher-gallery");
  for (const concept of launcherConcepts) {
    const card = document.createElement("article");
    card.className = "launcher-card";
    const choice = document.createElement("button");
    choice.type = "button";
    choice.disabled = true;
    choice.className = "launcher-choice";
    choice.dataset["launcher"] = concept.id;
    choice.setAttribute("aria-pressed", String(concept.id === "current"));
    const title = document.createElement("span");
    title.className = "launcher-title";
    title.textContent = concept.label;
    const samples = document.createElement("span");
    samples.className = "launcher-samples";
    for (const shape of ["circle", "squircle", "monochrome"] as const) {
      const sample = document.createElement("span");
      const mask = document.createElement("span");
      mask.className = `launcher-mask ${shape}`;
      mask.append(
        previewImage(
          shape === "monochrome" ? concept.monochrome : concept.color,
          `${concept.label}, ${shape}`,
        ),
      );
      const caption = document.createElement("span");
      caption.className = "launcher-caption";
      caption.textContent =
        shape === "monochrome" ? "Themed" : shape === "circle" ? "Circle" : "Squircle";
      sample.append(mask, caption);
      samples.append(sample);
    }
    const description = document.createElement("span");
    description.className = "launcher-description";
    description.textContent = concept.description;
    choice.append(title, samples, description);
    choice.addEventListener("click", () => changeLauncher(concept.id));
    const credit = document.createElement("p");
    credit.className = "icon-credit";
    credit.append(...creditNodes(concept.credit));
    card.append(choice, credit);
    gallery.append(card);
  }
}

export function renderLauncher(launcher: LauncherStyle, disabled: boolean) {
  const selected = launcherConcepts.find((concept) => concept.id === launcher)!;
  for (const button of element("launcher-gallery").querySelectorAll<HTMLButtonElement>(
    "button[data-launcher]",
  )) {
    button.disabled = disabled;
    button.setAttribute("aria-pressed", String(button.dataset["launcher"] === launcher));
  }
  element<HTMLButtonElement>("reset-launcher").disabled = disabled;
  element("launcher-selection").textContent =
    `${selected.label} selected. Save complete design keeps this choice.`;
}
