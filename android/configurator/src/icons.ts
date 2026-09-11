export const iconStyles = [
  "current",
  "engraved",
  "phosphor-bold",
  "phosphor-fill",
  "noun-boatman",
  "noun-icons",
  "participant-profile",
  "participant-bold",
  "participant-fill",
] as const;
export const pushIconStyles = ["current", "contact", "microphone"] as const;
export type IconStyle = (typeof iconStyles)[number];
export type PushIconStyle = (typeof pushIconStyles)[number];
export type Icons = { channels: IconStyle; push: PushIconStyle };
export type IconCredit = {
  author: string;
  tag: string;
  source?: string;
  sources?: readonly { label: string; url: string }[];
  license?: string;
  changes?: string;
};
export type IconOption = {
  label: string;
  credit: IconCredit;
  microphoneCredit?: IconCredit;
  channels: readonly [string, string, string, string];
};
const phosphorRevision = "2b75f3ad12b420c9504ef05df8d2564a28f8500e";
const original: IconCredit = { author: "AgentVoice", tag: "Original" };
const phosphor: IconCredit = {
  author: "Phosphor Icons",
  tag: "MIT",
  source: `https://github.com/phosphor-icons/core/tree/${phosphorRevision}`,
  license: `https://github.com/phosphor-icons/core/blob/${phosphorRevision}/LICENSE`,
};
const nounLicense = "https://creativecommons.org/licenses/by/3.0/";
const nounTerms = {
  microphone: "https://thenounproject.com/browse/icons/term/microphone/",
  speaker: "https://thenounproject.com/browse/icons/term/speaker/",
  volume: "https://thenounproject.com/browse/icons/term/volume/",
};
const nounSources = {
  boatmanMic: "https://thenounproject.com/icon/microphone-171/",
  boatmanSpeaker: "https://thenounproject.com/icon/speaker-100/",
  iconsMic: "https://thenounproject.com/icon/microphone-856601/",
  iconsSpeaker: "https://thenounproject.com/icon/volume-974802/",
};
function nounCredits(
  author: string,
  microphone: string,
  speaker: string,
  speakerName: string,
  extraChanges = "",
): { credit: IconCredit; microphoneCredit: IconCredit } {
  return {
    credit: {
      author: `Microphone and ${speakerName} by ${author} from Noun Project`,
      tag: "CC BY 3.0",
      sources: [
        { label: "Microphone source", url: microphone },
        { label: `${speakerName} source`, url: speaker },
        { label: "Noun Project · Microphone", url: nounTerms.microphone },
        {
          label: `Noun Project · ${speakerName}`,
          url: speakerName === "Speaker" ? nounTerms.speaker : nounTerms.volume,
        },
      ],
      license: nounLicense,
      changes: `Resized and recolored; mute slashes added. Attribution moved here.${extraChanges ? ` ${extraChanges}` : ""}`,
    },
    microphoneCredit: {
      author: `Microphone by ${author} from Noun Project`,
      tag: "CC BY 3.0",
      sources: [
        { label: "Microphone source", url: microphone },
        { label: "Noun Project · Microphone", url: nounTerms.microphone },
      ],
      license: nounLicense,
      changes: "Resized and recolored. Attribution moved here.",
    },
  };
}
export const iconCatalog: Record<IconStyle, IconOption> = {
  "participant-profile": {
    label: "Human / Agent · Speaking profiles",
    credit: {
      ...original,
      changes: "Matched participant profiles with audio-specific live and muted marks.",
    },
    channels: [
      "participant-profile-mic.svg",
      "participant-profile-mic-muted.svg",
      "participant-profile-speaker.svg",
      "participant-profile-speaker-muted.svg",
    ],
  },
  "participant-bold": {
    label: "Human / Agent · Phosphor Bold",
    credit: {
      ...phosphor,
      changes:
        "User and Robot; robot optically reduced, shared transparent mute slash added. These controls mute audio, not the participant.",
    },
    channels: [
      "participant-bold-mic.svg",
      "participant-bold-mic-muted.svg",
      "participant-bold-speaker.svg",
      "participant-bold-speaker-muted.svg",
    ],
  },
  "participant-fill": {
    label: "Human / Agent · Phosphor Fill",
    credit: {
      ...phosphor,
      changes:
        "User and Robot; robot optically reduced, shared transparent mute slash added. These controls mute audio, not the participant.",
    },
    channels: [
      "participant-fill-mic.svg",
      "participant-fill-mic-muted.svg",
      "participant-fill-speaker.svg",
      "participant-fill-speaker-muted.svg",
    ],
  },
  current: {
    label: "Current",
    credit: original,
    channels: [
      "current-mic.svg",
      "current-mic-muted.svg",
      "current-speaker.svg",
      "current-speaker-muted.svg",
    ],
  },
  engraved: {
    label: "Engraved",
    credit: original,
    channels: [
      "engraved-mic.svg",
      "engraved-mic-muted.svg",
      "engraved-speaker.svg",
      "engraved-speaker-muted.svg",
    ],
  },
  "phosphor-bold": {
    label: "Phosphor Bold",
    credit: phosphor,
    channels: [
      "microphone-bold.svg",
      "microphone-slash-bold.svg",
      "speaker-high-bold.svg",
      "speaker-slash-bold.svg",
    ],
  },
  "phosphor-fill": {
    label: "Phosphor Fill",
    credit: phosphor,
    channels: [
      "microphone-fill.svg",
      "microphone-slash-fill.svg",
      "speaker-high-fill.svg",
      "speaker-slash-fill.svg",
    ],
  },
  "noun-boatman": {
    label: "Boatman",
    ...nounCredits(
      "Edward Boatman",
      nounSources.boatmanMic,
      nounSources.boatmanSpeaker,
      "Speaker",
      "Three isolated lower wave fragments removed from the muted speaker.",
    ),
    channels: [
      "noun-boatman-mic.svg",
      "noun-boatman-mic-muted.svg",
      "noun-boatman-speaker.svg",
      "noun-boatman-speaker-muted.svg",
    ],
  },
  "noun-icons": {
    label: "i cons",
    ...nounCredits("i cons", nounSources.iconsMic, nounSources.iconsSpeaker, "Volume"),
    channels: [
      "noun-icons-mic.svg",
      "noun-icons-mic-muted.svg",
      "noun-icons-speaker.svg",
      "noun-icons-speaker-muted.svg",
    ],
  },
};
export const pushIconCatalog: Record<PushIconStyle, { label: string }> = {
  current: { label: "Current press" },
  contact: { label: "Contact" },
  microphone: { label: "Match human channel" },
};
export function pushIconPreview(icons: Icons): { file: string; credit: IconCredit } {
  if (icons.push === "microphone")
    return {
      file: iconCatalog[icons.channels].channels[0],
      credit: iconCatalog[icons.channels].microphoneCredit ?? iconCatalog[icons.channels].credit,
    };
  return {
    file: icons.push === "contact" ? "ptt-contact-monochrome.svg" : "current-push.svg",
    credit: original,
  };
}
export function defaultIcons(): Icons {
  return { channels: "current", push: "current" };
}
export function parseIcons(value: unknown): Icons {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid icons");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    !("channels" in data) ||
    !("push" in data) ||
    !iconStyles.includes(data["channels"] as IconStyle) ||
    !pushIconStyles.includes(data["push"] as PushIconStyle)
  )
    throw Error("Invalid icon selection");
  return { channels: data["channels"] as IconStyle, push: data["push"] as PushIconStyle };
}
export const launcherStyles = [
  "current",
  "duplex-halo",
  "relay-aperture",
  "voice-carrier",
] as const;
export type LauncherStyle = (typeof launcherStyles)[number];
export function parseLauncher(value: unknown): LauncherStyle {
  if (!launcherStyles.includes(value as LauncherStyle)) throw Error("Invalid launcher choice");
  return value as LauncherStyle;
}
export type LauncherConcept = {
  id: LauncherStyle;
  label: string;
  description: string;
  color: string;
  monochrome: string;
  credit: IconCredit;
};
export const launcherConcepts: readonly LauncherConcept[] = [
  {
    id: "current",
    label: "Current waveform",
    description: "The original mark, shown here in each mask.",
    color: "launcher-current.svg",
    monochrome: "launcher-current-monochrome.svg",
    credit: original,
  },
  {
    id: "duplex-halo",
    label: "Duplex Halo",
    description: "A split ring with two channel feeds.",
    color: "duplex-halo-icon.svg",
    monochrome: "duplex-halo-monochrome.svg",
    credit: original,
  },
  {
    id: "relay-aperture",
    label: "Relay Aperture",
    description: "Two chamfered halves around a shared opening.",
    color: "relay-aperture-icon.svg",
    monochrome: "relay-aperture-monochrome.svg",
    credit: original,
  },
  {
    id: "voice-carrier",
    label: "Voice Carrier",
    description: "One quiet carrier, two channel colors.",
    color: "voice-carrier-icon.svg",
    monochrome: "voice-carrier-monochrome.svg",
    credit: original,
  },
];
export function safeCreditLink(value: string): string {
  const approved = [
    phosphor.source,
    phosphor.license,
    nounLicense,
    ...Object.values(nounSources),
    ...Object.values(nounTerms),
  ];
  if (!approved.includes(value)) throw Error("Unknown icon credit link");
  return value;
}
export function iconPreviewFiles(): string[] {
  return [
    ...new Set([
      ...Object.values(iconCatalog).flatMap((option) => option.channels),
      "current-push.svg",
      "ptt-contact-monochrome.svg",
      ...launcherConcepts.flatMap((option) => [option.color, option.monochrome]),
    ]),
  ];
}
