// Transport contract: send(text) -> {sequence, byteLength, at}; rxSequence(); subscribe(cb(line)) -> unsubscribe; close().
function createCore() {
  const listeners = new Set();
  let rx = 0; let tx = 0;
  return {
    rxSequence: () => rx,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    receive(text) { rx += 1; const at = Date.now(); for (const piece of text.split(/\r?\n/).filter(Boolean)) for (const callback of listeners) callback({ text: piece, rxSequence: rx, at, byteLength: Buffer.byteLength(piece) }); },
    nextTx() { tx += 1; return tx; }
  };
}

// In-memory device for tests and dry runs. responder(command) -> array of response lines.
export function createSimulatedTransport({ responder = () => [], delayMs = 5 } = {}) {
  const core = createCore();
  return {
    rxSequence: core.rxSequence, subscribe: core.subscribe, close: async () => {},
    injectStale: (text) => core.receive(text),
    async send(text) {
      const receipt = { sequence: core.nextTx(), byteLength: Buffer.byteLength(text + "\n"), at: Date.now() };
      for (const reply of responder(text)) setTimeout(() => core.receive(reply), delayMs);
      return receipt;
    }
  };
}

export async function openSerialTransport({ path, baudRate = 115200, dataBits = 8, stopBits = 1, parity = "none", ending = "\n", rtscts = false }) {
  let SerialPort;
  try { ({ SerialPort } = await import("serialport")); } catch { throw new Error("The optional 'serialport' package is not installed. Run npm install in the gateway directory on the gateway host."); }
  const core = createCore();
  const port = new SerialPort({ path, baudRate, dataBits, stopBits, parity, rtscts, autoOpen: false });
  await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
  let pending = "";
  port.on("data", (chunk) => { pending += chunk.toString("utf8"); const cut = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r")); if (cut === -1) return; const complete = pending.slice(0, cut + 1); pending = pending.slice(cut + 1); core.receive(complete); });
  return {
    rxSequence: core.rxSequence, subscribe: core.subscribe,
    async send(text) { const data = Buffer.from(text + ending); await new Promise((resolve, reject) => port.write(data, (error) => error ? reject(error) : port.drain((drainError) => drainError ? reject(drainError) : resolve()))); return { sequence: core.nextTx(), byteLength: data.length, at: Date.now() }; },
    close: () => new Promise((resolve) => port.close(() => resolve()))
  };
}
