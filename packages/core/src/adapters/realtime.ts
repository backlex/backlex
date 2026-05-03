export interface RealtimeMessage {
  channel: string;
  event: string;
  payload: unknown;
}

export interface RealtimeAdapter {
  publish(msg: RealtimeMessage): Promise<void>;
  subscribe(channel: string, onMessage: (msg: RealtimeMessage) => void): () => void;
}
