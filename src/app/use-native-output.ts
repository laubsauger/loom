import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput, desktopOutputBridge } from "@devices/native-output.ts";
import type { NativeOutputSelection } from "@devices/native-output.ts";
import { nativeOutputSender } from "@devices/native-output-channel.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { renderRangeHolderFor } from "./render-range.ts";
import { registerNativeViewerOutput, trackNativeViewerDrain } from "./native-viewer-outputs.ts";

/** Electron viewer output attachment. SDR conversion is explicitly selected. */
export function useNativeOutput(backend: LoomBackend | null, selection: NativeOutputSelection | null, documentIdentity: string, bus: LoomBus) {
  const bridge = desktopOutputBridge();
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const session = useRef<ReturnType<typeof attachNativeOutput> | null>(null);
  const name = useRef("");
  const channel = useRef<ReturnType<typeof nativeOutputSender> | null>(null);
  const frameRequest = useRef<number | null>(null);
  const generation = useRef(0);
  const opening = useRef<Promise<void> | null>(null);
  // Window/worker acquisition is asynchronous; its initial selection may be
  // removed or resized before it completes. Only use the committed viewer state.
  const currentSelection = useRef(selection);
  useLayoutEffect(() => { currentSelection.current = selection; }, [selection]);
  const close = useCallback(() => {
    generation.current++;
    if (frameRequest.current !== null) window.cancelAnimationFrame(frameRequest.current);
    frameRequest.current = null;
    channel.current?.close(); channel.current = null;
    const closingName = name.current; name.current = "";
    const pendingOpen = opening.current; opening.current = null;
    if (closingName && bridge) {
      if (!backend) throw new Error("Native output lost its owning backend before retirement");
      // An in-progress open can create its native owner after this close begins.
      // Wait for either open outcome, then retire that exact session and its GPU leases.
      const retire = () => bridge.close(closingName);
      const drain = pendingOpen ? pendingOpen.then(retire, retire) : retire();
      trackNativeViewerDrain(backend, drain);
      void drain.catch(error => setStatus(String(error)));
    }
    session.current?.dispose(); session.current = null; setActive(false); setReady(false);
  }, [bridge, backend]);
  useEffect(() => close, [close, backend, documentIdentity]);
  useEffect(() => {
    if (!backend) return;
    return registerNativeViewerOutput(backend, () => {
      if (!name.current) return;
      close(); setStatus("Native output stopped for offline export");
    });
  }, [backend, close]);
  const resourceId = selection?.resourceId;
  const width = selection?.size[0]; const height = selection?.size[1];
  useEffect(() => {
    if (!session.current || !bridge) return;
    if (resourceId === undefined || width === undefined || height === undefined) { close(); return; }
    const owner = session.current;
    owner.update({ resourceId, size: [width, height] });
    void bridge.resize(name.current, width, height).catch(error => {
      if (session.current === owner) { close(); setStatus(String(error)); }
    });
  }, [resourceId, width, height, bridge, close]);
  useEffect(() => {
    if (!active || !bridge) return;
    let retired = false;
    const outputName = name.current;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await bridge.status(outputName);
        if (retired) return;
        if (result.error) { close(); setStatus(result.error); }
        else if (!session.current) setStatus("Acquiring native output window and frame channel");
        else setStatus(`Native GPU: ${result.copied} published, ${result.dropped} dropped; ${session.current.presentedFrames()} rendered, ${channel.current?.sentFrames ?? 0} transferred`);
      } catch (error) { if (!retired) { close(); setStatus(String(error)); } }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { retired = true; window.clearInterval(timer); };
  }, [active, bridge, close]);
  const toggle = async () => {
    if (active) { close(); setStatus(""); return; }
    if (renderRangeHolderFor(bus).current?.busy()) {
      setStatus("Native output is unavailable during offline export"); return;
    }
    if (!bridge || !backend || !selection) return;
    const epoch = ++generation.current;
    const outputName = `loom-native-output-${crypto.randomUUID()}`;
    try {
      name.current = outputName;
      const sender = nativeOutputSender(outputName);
      channel.current = sender; setActive(true);
      const opened = bridge.open(outputName, selection.size[0], selection.size[1], outputName);
      opening.current = opened;
      await Promise.all([opened, sender.promise]);
      if (generation.current !== epoch) return; // close() owns and awaits retirement.
      const selected = currentSelection.current;
      if (!selected) { close(); return; }
      const canvas = new OffscreenCanvas(selected.size[0], selected.size[1]);
      session.current = attachNativeOutput(backend, selected, canvas);
      const owner = session.current;
      if (selected.size[0] !== selection.size[0] || selected.size[1] !== selection.size[1]) {
        await bridge.resize(outputName, selected.size[0], selected.size[1]);
        if (generation.current !== epoch) return;
      }
      let lastFrame = 0;
      const pump = () => {
        if (session.current !== owner) return;
        try {
          const count = owner.presentedFrames();
          if (count > lastFrame && sender.available) {
            const frame = canvas.transferToImageBitmap();
            try { sender.send(frame); } catch (error) { frame.close(); throw error; }
            lastFrame = count;
          }
          frameRequest.current = window.requestAnimationFrame(pump);
        } catch (error) { close(); setStatus(String(error)); }
      };
      frameRequest.current = window.requestAnimationFrame(pump);
      setReady(true);
      setActive(true); setStatus("Waiting for native GPU output");
    } catch (error) { if (generation.current === epoch) { close(); setStatus(String(error)); } }
  };
  return { available: bridge !== undefined, active, ready, status, toggle };
}
