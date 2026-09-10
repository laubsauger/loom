import NativeOutputWorker from "./native-output-worker.ts?sharedworker";

export function nativeOutputChannel(name: string) {
  return new NativeOutputWorker({ name });
}

export function nativeOutputSender(name: string) {
  const worker = nativeOutputChannel(name);
  let rejectPending: (error: Error) => void;
  let done = false;
  let busy = false;
  let sent = 0;
  let failure: Error | null = null;
  let framePort: MessagePort | null = null;
  let closed = false;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPending = reject;
    const fail = (error: Error) => { failure = error; done = true; reject(error); };
    worker.onerror = () => fail(new Error("Native output surface worker failed"));
    worker.port.onmessageerror = () => fail(new Error("Native output acknowledgment could not be deserialized"));
    worker.port.onmessage = ({ data }) => {
      if (data.error) fail(new Error(data.error));
      else if (data.kind === "ready" && data.port instanceof MessagePort && !framePort && !closed) {
        const port: MessagePort = data.port;
        framePort = port;
        port.onmessage = ({ data: reply }) => {
          if (reply.kind === "released" && busy) busy = false;
          else fail(new Error("Invalid native output frame acknowledgment"));
        };
        port.onmessageerror = () => fail(new Error("Native output frame acknowledgment could not be deserialized"));
        port.start(); done = true; resolve();
      }
      else fail(new Error("Invalid native output acknowledgment"));
    };
    worker.port.start(); worker.port.postMessage({ kind: "producer" });
  });
  return { promise, get sentFrames() { return sent; }, get available() { if (failure) throw failure; return done && !closed && !busy; }, send(frame: ImageBitmap) {
    if (failure) throw failure;
    if (!framePort || closed || busy) throw new Error("Native output frame port is unavailable or busy");
    framePort.postMessage({ kind: "frame", frame }, [frame]); busy = true; sent++;
  }, close() {
    if (closed) return;
    closed = true;
    framePort?.close();
    if (!done) { done = true; rejectPending(new Error("Native output surface acquisition cancelled")); }
    worker.port.postMessage({ kind: "close" }); worker.port.close();
  } };
}
