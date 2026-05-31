import { WebSerialTransport } from './webserial.js';
import { MockSerialTransport } from './mockPico.js';

export type LineHandler = (line: string) => void;
export type StatusHandler = (connected: boolean) => void;

export interface SerialTransport {
  readonly isSupported: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  send(command: string): Promise<void>;
  onLine(handler: LineHandler): () => void;
  onStatus(handler: StatusHandler): () => void;
}

declare global {
  interface Window {
    __USE_MOCK_SERIAL__?: boolean;
  }
}

export function createTransport(): SerialTransport {
  const useMock =
    new URLSearchParams(location.search).has('mock') ||
    window.__USE_MOCK_SERIAL__ === true;
  if (useMock) {
    return new MockSerialTransport();
  }
  return new WebSerialTransport();
}
