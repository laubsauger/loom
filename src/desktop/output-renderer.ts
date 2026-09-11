import { nativeOutputChannel } from '../devices/native-output-channel.ts';
declare const window: Window & { loomNativeSurface: { frameReady(): Promise<void> } };
const query = new URL(location.href).searchParams;
const name = query.get('name');
const width = Number(query.get('width')); const height = Number(query.get('height'));
if (!name || ![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384)) throw new Error('Invalid native output extent');
window.name = name;
const canvas = document.createElement('canvas');
canvas.width = width; canvas.height = height;
canvas.style.cssText = 'display:block;width:100%;height:100%';
document.body.append(canvas);
// Adopt the transferred GPU image into the compositor instead of allocating a
// second WebGPU device and copying it into another swapchain texture.
const context = canvas.getContext('bitmaprenderer', { alpha: false });
if (!context) throw new Error('Native output has no ImageBitmap presentation context');
const channel = nativeOutputChannel(name);
channel.onerror = () => { throw new Error('Native output shared worker failed'); };
channel.port.onmessageerror = () => { throw new Error('Native frame could not be deserialized by the output renderer'); };
let receivedFrames = 0;
let presentationMs = 0;
let framePort: MessagePort | null = null;
channel.port.onmessage = ({ data }) => {
  if (data.error) throw new Error(data.error);
  if (data.kind !== 'ready' || !(data.port instanceof MessagePort) || framePort) throw new Error('Invalid native output port handshake');
  const port: MessagePort = data.port;
  framePort = port;
  port.onmessageerror = () => { throw new Error('Native frame could not be deserialized by the output renderer'); };
  port.onmessage = async ({ data }) => {
    if (data.kind !== 'frame' || !(data.frame instanceof ImageBitmap)) throw new Error('Invalid native output frame');
    const frame = data.frame;
    const started = performance.now();
    try {
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      context.transferFromImageBitmap(frame);
    } finally { frame.close(); }
    presentationMs += performance.now() - started;
    canvas.dataset.presentationMs = String(presentationMs);
    canvas.dataset.receivedFrames = String(++receivedFrames);
    if (receivedFrames === 1) await window.loomNativeSurface.frameReady();
    port.postMessage({ kind: 'released' });
  };
  port.start();
};
channel.port.start(); channel.port.postMessage({ kind: 'consumer' });
window.addEventListener('pagehide', () => { framePort?.close(); channel.port.postMessage({ kind: 'close' }); channel.port.close(); });
