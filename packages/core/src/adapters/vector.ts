export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}

export interface VectorQuery {
  values: number[];
  topK?: number;
  namespace?: string;
  filter?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorAdapter {
  upsert(records: VectorRecord[]): Promise<void>;
  query(q: VectorQuery): Promise<VectorMatch[]>;
  delete(ids: string[], namespace?: string): Promise<void>;
}
