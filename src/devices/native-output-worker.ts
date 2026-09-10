// Rendezvous only. Hand off ports so GPU-backed ImageBitmap frames travel
// directly between renderers, with no extra shared-worker serialization hop.
const scope = globalThis as unknown as { onconnect: (event: MessageEvent) => void; close(): void };
let consumer: MessagePort | null = null;
let producer: MessagePort | null = null;
const ports = new Set<MessagePort>();
let connected = false;
function ready() {
  if (!consumer || !producer || connected) return;
  connected = true;
  const channel = new MessageChannel();
  consumer.postMessage({ kind: "ready", port: channel.port1 }, [channel.port1]);
  producer.postMessage({ kind: "ready", port: channel.port2 }, [channel.port2]);
}
scope.onconnect = event => {
  const port = event.ports[0];
  if (!port) throw new Error("Missing native surface port");
  if (ports.size >= 2) { port.postMessage({ error: "Native surface session already occupied" }); port.close(); return; }
  ports.add(port);
  port.onmessageerror = () => {
    for (const connected of ports) connected.postMessage({ error: "Native frame could not be deserialized by the shared worker" });
  };
  port.onmessage = ({ data }) => {
    if (data.kind === "close") { for (const connected of ports) connected.close(); scope.close(); return; }
    if (data.kind === "consumer" && consumer === null) { consumer = port; ready(); return; }
    if (data.kind === "producer" && producer === null) { producer = port; ready(); return; }
    port.postMessage({ error: "Invalid native surface handshake" });
  };
  port.start();
};
