export interface DocumentToProcess {
  id: number;
  emp_id: number;
  doc_documento: string | null;
}

export interface PromptRow {
  id: number;
  prompt: string;
  active?: boolean;
  enabled?: boolean;
  habilitado?: boolean;
}

export interface PreparedOcrPayload {
  documentUpdates: Record<string, unknown>;
  providerFiscalId: string | null;
  providerName: string | null;
  ignoredFields: string[];
  aliasesApplied: Record<string, string>;
}

export interface DaemonCycleSummary {
  runId: string;
  trigger: 'startup' | 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string;
  totalFound: number;
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  partnersCreated: number;
}
