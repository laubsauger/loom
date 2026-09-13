import { nativeOutputChannel } from "../devices/native-output-channel.ts";
declare const window: Window & { loomNativeSurface: { frameReady(): Promise<{ kind: "completed" | "closed" }> } };
const query = new URL(location.href).searchParams;
const name = query.get("name"), width = Number(query.get("width")), height = Number(query.get("height"));
if (!name || ![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16384))
  throw new Error("Invalid native inference capture extent");
window.name = name;
const canvas = document.createElement("canvas");
canvas.width = width; canvas.height = height; canvas.style.display = "block";
document.body.append(canvas);
const context = canvas.getContext("bitmaprenderer", { alpha: false });
if (!context) throw new Error("Native inference requires ImageBitmap presentation");
const channel = nativeOutputChannel(name);
let framePort: MessagePort | null = null;
channel.onerror = () => { throw new Error("Native inference channel failed"); };
channel.port.onmessage = ({ data }) => {
  if (data.kind !== "ready" || !(data.port instanceof MessagePort) || framePort) throw new Error("Invalid native inference handshake");
  const port: MessagePort = data.port; framePort = port;
  port.onmessage = async ({ data }) => {
    if (data.kind !== "frame" || !(data.frame instanceof ImageBitmap)) throw new Error("Invalid native inference image");
    try {
      if (data.frame.width !== width || data.frame.height !== height) throw new Error("Native inference input extent changed");
      context.transferFromImageBitmap(data.frame);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const result = await window.loomNativeSurface.frameReady();
      if (result.kind === "closed") return;
      if (result.kind !== "completed") throw new Error("Invalid native inference completion");
      port.postMessage({ kind: "released" });
    } catch (error) { port.postMessage({ kind: "error", message: String(error) }); }
    finally { data.frame.close(); }
  };
  port.start();
};
channel.port.start(); channel.port.postMessage({ kind: "consumer" });
window.addEventListener("pagehide", () => { framePort?.close(); channel.port.postMessage({ kind: "close" }); channel.port.close(); });
