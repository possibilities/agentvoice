import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { saveProfile } from "./profile.ts";
import {
  equalLayout,
  exact,
  integer,
  layoutOf,
  type Phone,
  type Profile,
  parseOrientationFence,
  parsePreview,
  parseProfile,
  profileLayout,
  record,
  sameOrientation,
} from "./protocol.ts";

export async function serveConfigurator(
  phone: Phone,
  options: { port: number; device: string; saveTo: string },
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
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
  const status = () => ({
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
        if (path === "state") return json(status());
        return json({ error: "Not found" }, 404);
      }
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type") !== "application/json"
      )
        return json({ error: "Invalid request origin or content type" }, 403);
      if (path !== "preview" && path !== "save") return json({ error: "Not found" }, 404);
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
            "theme",
            "mutedPresence",
            "presenceScope",
            "mutedTuning",
            "connection",
            "activity",
            "mode",
            "scales",
            "verticalOffsetDp",
            "design",
            "halo",
            "spirit",
          ]);
          parsePreview({
            orientation: input["orientation"],
            orientationEpoch: input["orientationEpoch"],
            personaSide: input["personaSide"],
            theme: input["theme"],
            mutedPresence: input["mutedPresence"],
            presenceScope: input["presenceScope"],
            mutedTuning: input["mutedTuning"],
            connection: input["connection"],
            activity: input["activity"],
            mode: input["mode"],
            scales: input["scales"],
            verticalOffsetDp: input["verticalOffsetDp"],
            design: input["design"],
            halo: input["halo"],
            spirit: input["spirit"],
          });
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
        if (path === "preview")
          await phone.request({
            method: "preview",
            ...parsePreview({
              orientation: input["orientation"],
              orientationEpoch: input["orientationEpoch"],
              personaSide: input["personaSide"],
              theme: input["theme"],
              mutedPresence: input["mutedPresence"],
              presenceScope: input["presenceScope"],
              mutedTuning: input["mutedTuning"],
              connection: input["connection"],
              activity: input["activity"],
              mode: input["mode"],
              scales: input["scales"],
              verticalOffsetDp: input["verticalOffsetDp"],
              design: input["design"],
              halo: input["halo"],
              spirit: input["spirit"],
            }),
          });
        else {
          if (input["revision"] !== phone.state.revision)
            return json({ error: "Preview changed. Review it before saving." }, 409);
          const expected = layoutOf(phone.state);
          const expectedOther = layoutOf(phone.state.otherLayout);
          const expectedOrientation = phone.state.orientation;
          const otherOrientation = expectedOrientation === "portrait" ? "landscape" : "portrait";
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
            profile.version !== 13 ||
            !equalLayout(profileLayout(profile, expectedOrientation), expected) ||
            !equalLayout(profileLayout(profile, otherOrientation), expectedOther)
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
  return { server, url: `http://127.0.0.1:${server.port}${prefix}` };
}
