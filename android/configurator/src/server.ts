import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { equalSharedAppearance } from "./appearance.ts";
import type { LayoutCapture } from "./capture.ts";
import { iconPreviewFiles } from "./icons.ts";
import { saveProfile } from "./profile.ts";
import {
  type ConnectionPreview,
  connectionPreviews,
  equalLayout,
  equalVisualSettings,
  exact,
  integer,
  orientations,
  type Phone,
  type Profile,
  parseOrientationFence,
  parsePreview,
  parseProfile,
  profileLayout,
  profileSharedAppearance,
  profileSounds,
  profileVisualSettings,
  record,
  sameOrientation,
  stateLayouts,
  visualSettingsOf,
} from "./protocol.ts";
import { equalSounds } from "./sounds.ts";

export async function serveConfigurator(
  phone: Phone,
  options: {
    port: number;
    device: string;
    saveTo: string;
    capture?: (signal: AbortSignal) => Promise<LayoutCapture>;
  },
) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./web.ts", import.meta.url))],
    target: "browser",
    minify: true,
  });
  if (!bundle.success || !bundle.outputs[0]) throw Error("Could not build the configurator page.");
  const script = await bundle.outputs[0].text();
  let saved: Profile | null = null;
  let mutating = false;
  let latestCapture: LayoutCapture | undefined;
  let captureTask: Promise<LayoutCapture> | undefined;
  const captureAbort = new AbortController();
  const previewFiles = new Set(iconPreviewFiles());
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
  const status = () => ({
    captureAvailable: options.capture !== undefined,
    connected: phone.connected,
    reconnecting: phone.reconnecting ?? false,
    generation: phone.generation ?? 1,
    disconnectReason: phone.disconnectReason,
    state: phone.state,
    device: options.device,
    savePath: options.saveTo,
    hostSaved: saved,
  });
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    maxRequestBodySize: 8192,
    idleTimeout: 120,
    async fetch(request) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      if (
        request.headers.get("host") !== `127.0.0.1:${server.port}` ||
        !url.pathname.startsWith(prefix)
      )
        return json({ error: "Not found" }, 404);
      const path = url.pathname.slice(prefix.length);
      if (request.method === "GET") {
        if (path === "")
          return new Response(Bun.file(new URL("../public/index.html", import.meta.url)), {
            headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
          });
        if (path === "app.js")
          return new Response(script, {
            headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
          });
        if (path === "style.css")
          return new Response(Bun.file(new URL("../public/style.css", import.meta.url)), {
            headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
          });
        if (path === "type.ttf")
          return new Response(
            Bun.file(
              new URL("../../app/src/main/res/font/ibm_plex_mono_regular.ttf", import.meta.url),
            ),
            { headers: { ...headers, "Content-Type": "font/ttf" } },
          );
        if (path.startsWith("icon-previews/")) {
          const filename = path.slice("icon-previews/".length);
          if (!previewFiles.has(filename) && filename !== "PHOSPHOR-LICENSE.txt")
            return json({ error: "Not found" }, 404);
          return new Response(
            Bun.file(new URL(`../public/icon-previews/${filename}`, import.meta.url)),
            {
              headers: {
                ...headers,
                "Content-Type": filename.endsWith(".svg")
                  ? "image/svg+xml"
                  : "text/plain; charset=utf-8",
              },
            },
          );
        }
        if (path === "state") return json(status());
        const framePath =
          /^capture\/([a-f0-9]{24})\/(portrait|landscape|portrait-reverse|landscape-reverse)\.png$/.exec(
            path,
          );
        if (framePath && latestCapture && latestCapture.id === framePath[1]) {
          const frame = latestCapture.frames.find((item) => item.orientation === framePath[2]);
          if (frame)
            return new Response(new Uint8Array(frame.png), {
              headers: { ...headers, "Content-Type": "image/png" },
            });
        }
        return json({ error: "Not found" }, 404);
      }
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type") !== "application/json"
      )
        return json({ error: "Invalid request origin or content type" }, 403);
      if (
        path !== "preview" &&
        path !== "save" &&
        path !== "icon-credits" &&
        path !== "connection-preview" &&
        path !== "reset-production" &&
        path !== "capture-layouts"
      )
        return json({ error: "Not found" }, 404);
      if (!phone.connected) return json({ error: "Waiting for the phone preview to return." }, 503);
      if (mutating) return json({ error: "A change is still reaching the phone. Try again." }, 409);
      let input: Record<string, unknown>;
      try {
        input = record(await request.json());
        integer(input["generation"], 1);
        parseOrientationFence(input);
        if (path === "preview") {
          exact(input, [
            "generation",
            "orientation",
            "orientationEpoch",
            "personaSide",
            "icons",
            "launcher",
            "showPushToTalk",
            "sounds",
            "theme",
            "mutedPresence",
            "presenceScope",
            "mutedTuning",
            "connection",
            "activity",
            "mode",
            "scales",
            "verticalOffsetDp",
            "horizontalOffsetDp",
            "appearanceOverrides",
            "design",
            "halo",
            "spirit",
          ]);
          parsePreview({
            orientation: input["orientation"],
            orientationEpoch: input["orientationEpoch"],
            personaSide: input["personaSide"],
            icons: input["icons"],
            launcher: input["launcher"],
            showPushToTalk: input["showPushToTalk"],
            sounds: input["sounds"],
            theme: input["theme"],
            mutedPresence: input["mutedPresence"],
            presenceScope: input["presenceScope"],
            mutedTuning: input["mutedTuning"],
            connection: input["connection"],
            activity: input["activity"],
            mode: input["mode"],
            scales: input["scales"],
            verticalOffsetDp: input["verticalOffsetDp"],
            horizontalOffsetDp: input["horizontalOffsetDp"],
            appearanceOverrides: input["appearanceOverrides"],
            design: input["design"],
            halo: input["halo"],
            spirit: input["spirit"],
          });
        } else if (path === "connection-preview") {
          exact(input, ["generation", "orientation", "orientationEpoch", "scene"]);
          if (!connectionPreviews.includes(input["scene"] as ConnectionPreview))
            throw Error("Invalid connection scene");
        } else if (path === "icon-credits") {
          exact(input, ["generation", "orientation", "orientationEpoch"]);
        } else {
          exact(input, ["generation", "revision", "orientation", "orientationEpoch"]);
          integer(input["revision"]);
        }
      } catch {
        return json({ error: "Invalid preview settings" }, 400);
      }
      if (mutating) return json({ error: "A change is still reaching the phone. Try again." }, 409);
      // Reading a request body can span a disconnect. Never dispatch an old browser edit on a new peer.
      if (input["generation"] !== (phone.generation ?? 1))
        return json(
          { error: "Phone reconnected. Review its preview before making another change." },
          409,
        );
      if (!phone.connected) return json({ error: "Waiting for the phone preview to return." }, 503);
      if (!sameOrientation(parseOrientationFence(input), phone.state))
        return json(
          { error: "Phone rotated. Review its current layout before making another change." },
          409,
        );
      mutating = true;
      try {
        if (path === "capture-layouts") {
          if (!options.capture)
            return json({ error: "Capture is unavailable for this target." }, 409);
          if (input["revision"] !== phone.state.revision)
            return json({ error: "Preview changed. Review it before capturing." }, 409);
          captureTask = options.capture(captureAbort.signal);
          latestCapture = await captureTask;
          return json({
            ...status(),
            capture: {
              id: latestCapture.id,
              createdAt: latestCapture.createdAt,
              restored: latestCapture.restored,
              frames: latestCapture.frames.map(({ orientation, width, height }) => ({
                orientation,
                width,
                height,
                url: `${prefix}capture/${latestCapture!.id}/${orientation}.png`,
              })),
            },
          });
        }
        if (path === "preview")
          await phone.request({
            method: "preview",
            ...parsePreview({
              orientation: input["orientation"],
              orientationEpoch: input["orientationEpoch"],
              personaSide: input["personaSide"],
              icons: input["icons"],
              launcher: input["launcher"],
              showPushToTalk: input["showPushToTalk"],
              sounds: input["sounds"],
              theme: input["theme"],
              mutedPresence: input["mutedPresence"],
              presenceScope: input["presenceScope"],
              mutedTuning: input["mutedTuning"],
              connection: input["connection"],
              activity: input["activity"],
              mode: input["mode"],
              scales: input["scales"],
              verticalOffsetDp: input["verticalOffsetDp"],
              horizontalOffsetDp: input["horizontalOffsetDp"],
              appearanceOverrides: input["appearanceOverrides"],
              design: input["design"],
              halo: input["halo"],
              spirit: input["spirit"],
            }),
          });
        else if (path === "reset-production") {
          if (input["revision"] !== phone.state.revision)
            return json({ error: "Preview changed. Review it before resetting." }, 409);
          await phone.request({
            method: "resetProduction",
            revision: input["revision"],
            ...parseOrientationFence(input),
          });
        } else if (path === "connection-preview")
          await phone.request({
            method: "connectionPreview",
            scene: input["scene"],
            ...parseOrientationFence(input),
          });
        else if (path === "icon-credits") await phone.request({ method: "iconCredits" });
        else {
          if (input["revision"] !== phone.state.revision)
            return json({ error: "Preview changed. Review it before saving." }, 409);
          const expectedLayouts = stateLayouts(phone.state);
          const expectedSounds = { ...phone.state.sounds };
          const expectedAppearance = visualSettingsOf(phone.state);
          const expectedShared = structuredClone(phone.state.sharedAppearance);
          const reply = await phone
            .request({
              method: "save",
              revision: input["revision"],
              ...parseOrientationFence(input),
            })
            .catch(() => {
              throw Error(
                "Save was not confirmed. It may have reached the phone. Review the preview before saving again.",
              );
            });
          if (!reply.profile) throw Error("Phone did not confirm the save.");
          const profile = parseProfile(reply.profile);
          if (
            profile.version !== 21 ||
            !equalVisualSettings(profileVisualSettings(profile), expectedAppearance) ||
            !equalSounds(profileSounds(profile), expectedSounds) ||
            !equalSharedAppearance(profileSharedAppearance(profile), expectedShared) ||
            orientations.some(
              (orientation) =>
                !equalLayout(profileLayout(profile, orientation), expectedLayouts[orientation]),
            )
          )
            throw Error("Phone saved different settings. Review the preview.");
          try {
            await saveProfile(options.saveTo, reply.profile);
          } catch {
            return json(
              {
                error:
                  "Saved on the phone, but the host copy could not be written. Check the save destination and try Save again.",
              },
              500,
            );
          }
          saved = profile;
        }
        return json(status());
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "Could not update the phone" },
          502,
        );
      } finally {
        mutating = false;
      }
    },
    error() {
      return json({ error: "Configurator request failed" }, 500);
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}${prefix}`,
    async close() {
      captureAbort.abort();
      await captureTask?.catch(() => undefined);
      await server.stop(true);
    },
  };
}
