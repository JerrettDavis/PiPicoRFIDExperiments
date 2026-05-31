import type { SerialTransport, LineHandler, StatusHandler } from './transport.js';

export class WebSerialTransport implements SerialTransport {
  readonly isSupported: boolean = 'serial' in navigator;

  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _isConnected = false;
  private _disconnectListener: (() => void) | null = null;

  private lineHandlers: Set<LineHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();

  get isConnected(): boolean {
    return this._isConnected;
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(connected: boolean): void {
    this._isConnected = connected;
    this.statusHandlers.forEach(h => h(connected));
  }

  private emitLine(line: string): void {
    this.lineHandlers.forEach(h => h(line));
  }

  async connect(): Promise<void> {
    if (!this.isSupported) {
      throw new Error('Web Serial is not available. Use Chrome or Edge on desktop from localhost or HTTPS.');
    }
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    if (!this.port.writable) throw new Error('Serial port not writable');
    this.writer = this.port.writable.getWriter();
    this.emitStatus(true);

    // Listen for hardware disconnect (stored so it can be removed on disconnect)
    this._disconnectListener = () => {
      this.emitStatus(false);
    };
    navigator.serial.addEventListener('disconnect', this._disconnectListener);

    this.startReadLoop().catch(() => {});
  }

  private async startReadLoop(): Promise<void> {
    if (!this.port || !this.port.readable) return;
    const decoder = new TextDecoder();
    let buffer = '';

    // Acquire the reader once; termination is driven by reader.cancel() in
    // disconnect(). If releaseLock() ever throws we break rather than
    // re-acquiring on a still-locked stream (which would throw silently).
    this.reader = this.port.readable.getReader();
    try {
      while (this._isConnected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line.length) this.emitLine(line);
        }
      }
    } catch {
      // Read failed (e.g. cancelled during disconnect); fall through to cleanup.
    } finally {
      try { this.reader.releaseLock(); } catch { /* ignore */ }
      this.reader = null;
    }
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    if (this._disconnectListener) {
      navigator.serial.removeEventListener('disconnect', this._disconnectListener);
      this._disconnectListener = null;
    }
    try { if (this.reader) await this.reader.cancel(); } catch { /* ignore */ }
    try { if (this.writer) { this.writer.releaseLock(); this.writer = null; } } catch { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch { /* ignore */ }
    this.port = null;
    this.emitStatus(false);
  }

  async send(command: string): Promise<void> {
    if (!this.writer) throw new Error('Not connected');
    const data = new TextEncoder().encode(command.trim() + '\n');
    await this.writer.write(data);
  }
}
