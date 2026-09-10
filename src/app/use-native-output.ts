import { useCallback, useEffect, useRef, useState } from "react";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput, desktopOutputBridge } from "@devices/native-output.ts";
import type { NativeOutputSelection } from "@devices/native-output.ts";
import { nativeOutputSender } from "@devices/native-output-channel.ts";

/** Development Electron output attachment. SDR conversion is explicitly selected. */
export function useNativeOutput(backend: LoomBackend | null, selection: NativeOutputSelection | null, documentIdentity: string) {
  const bridge = desktopOutputBridge();
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const session = useRef<ReturnType<typeof attachNativeOutput> | null>(null);
  const name = useRef("");
  const channel = useRef<ReturnType<typeof nativeOutputSender> | null>(null);
  const frameRequest = useRef<number | null>(null);
  const generation = useRef(0);
  const close = useCallback(() => {
    generation.current++;
    if (frameRequest.current !== null) window.cancelAnimationFrame(frameRequest.current);
    frameRequest.current = null;
    channel.current?.close(); channel.current = null;
    const closingName = name.current; name.current = "";
    if (closingName && bridge) void bridge.close(closingName).catch(error => setStatus(String(error)));
    session.current?.dispose(); session.current = null; setActive(false); setReady(false);
  }, [bridge]);
  useEffect(() => close, [close, backend, documentIdentity]);
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
        else setStatus(`Native GPU: ${result.copied} published, ${result.dropped} dropped; ${session.current?.presentedFrames() ?? 0} rendered, ${channel.current?.sentFrames ?? 0} transferred`);
      } catch (error) { if (!retired) { close(); setStatus(String(error)); } }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { retired = true; window.clearInterval(timer); };
  }, [active, bridge, close]);
  const toggle = async () => {
    if (active) { close(); setStatus(""); return; }
    if (!bridge || !backend || !selection) return;
    const epoch = ++generation.current;
    const outputName = `loom-native-output-${crypto.randomUUID()}`;
    try {
      name.current = outputName;
      const sender = nativeOutputSender(outputName);
      channel.current = sender; setActive(true);
      await Promise.all([bridge.open(outputName, selection.size[0], selection.size[1]), sender.promise]);
      if (generation.current !== epoch) { await bridge.close(outputName); return; }
      const canvas = new OffscreenCanvas(selection.size[0], selection.size[1]);
      session.current = attachNativeOutput(backend, selection, canvas);
      const owner = session.current;
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
