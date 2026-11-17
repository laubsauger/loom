import { describe, expect, it } from "vitest";

import { createLookStore, lookOrMove, rekeyedOrbitStore } from "./look-store.ts";
import { createPreviewOrbitStore } from "./preview-orbit-store.ts";

/**
 * §T1732b — the looks ask the compile for a second drawing of a Render, which costs a full
 * compile to add and another to remove, and a second Render every frame while it stands. So
 * the ask must follow what the user DID: none for arming a look (alt over a tile, a press of
 * C), one the moment the look leaves the camera, none again once it is home. And a gesture
 * that edits the document must only ever reach the camera when MOVE was asked for by name.
 */
describe("§T1732b looks", () => {
  it("asks for a look only while one is moved off its camera, with one stable sink per renderer", () => {
    const looks = createLookStore();
    let told = 0;
    looks.subscribeSinks(() => {
      told += 1;
    });
    looks.setMode("render_shot", "adjustable");
    // Armed and unmoved: the camera's own picture, which needs no second drawing.
    expect(looks.sinks).toEqual([]);
    expect(told).toBe(0);
    looks.apply("render_shot", { azimuth: 0.3 });
    expect(looks.sinks.map((sink) => [sink.nodeId, sink.kind])).toEqual([["render_shot", "look"]]);
    expect(told).toBe(1);
    const asked = looks.sinks;
    // Another drag moves the look; the ask is the same ask (no recompile per pointer move)...
    looks.apply("render_shot", { azimuth: 0.1 });
    expect(looks.sinks).toBe(asked);
    expect(told).toBe(1);
    // ...and its orbit is read through it, at whatever moment the frame asks.
    expect(asked[0]?.orbit?.()?.azimuth).toBeCloseTo(0.4);
    // Home: no ask, and the getter reads the camera itself.
    looks.setMode("render_shot", "home");
    expect(looks.sinks).toEqual([]);
    expect(told).toBe(2);
    expect(asked[0]?.orbit?.()).toBeUndefined();
  });

  it("C and alt arm the LOOK; only M arms the camera, and arming one sends the other home", () => {
    const look = createPreviewOrbitStore();
    const move = createPreviewOrbitStore();
    const tile = lookOrMove(look, move, "camera_shot");
    // What alt over the tile and the viewer's first drag do: they name no camera.
    tile.setMode("render_shot", "adjustable");
    expect(tile.armed("render_shot")).toBe("look");
    tile.apply("render_shot", { azimuth: 0.5 });
    expect(look.get("render_shot")?.azimuth).toBe(0.5);
    expect(move.get("render_shot")).toBeUndefined();

    tile.arm("render_shot", "move");
    expect(tile.armed("render_shot")).toBe("move");
    // The look went home with it: a camera being moved is seen through itself.
    expect(look.mode("render_shot")).toBe("home");
    expect(look.get("render_shot")).toBeUndefined();
    tile.apply("render_shot", { azimuth: 0.2 });
    expect(move.get("render_shot")?.azimuth).toBe(0.2);
    expect(look.get("render_shot")).toBeUndefined();

    tile.setMode("render_shot", "home");
    expect(tile.armed("render_shot")).toBeNull();
    expect(move.mode("render_shot")).toBe("home");
  });

  it("with nothing here to move, M is absent and every gesture is a look", () => {
    const look = createPreviewOrbitStore();
    const tile = lookOrMove(look, null, "camera_shot");
    expect(tile.moves).toBeNull();
    tile.arm("render_shot", "move");
    expect(tile.armed("render_shot")).toBeNull();
    tile.setMode("render_shot", "adjustable");
    tile.zoom("render_shot", 0.5);
    expect(look.get("render_shot")?.distance).toBe(0.5);
  });

  it("a camera's tile looks through its Render's look: one picture, one look", () => {
    const looks = createLookStore();
    const cameraTile = rekeyedOrbitStore(looks, () => "render_shot");
    cameraTile.setMode("camera_shot", "adjustable");
    cameraTile.apply("camera_shot", { elevation: 0.2 });
    expect(looks.get("render_shot")?.elevation).toBe(0.2);
    expect(looks.sinks.map((sink) => sink.nodeId)).toEqual(["render_shot"]);
  });
});
