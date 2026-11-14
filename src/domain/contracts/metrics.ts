export type Labels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
  setGauge(name: string, value: number, labels?: Labels): void;
}

export const METRICS = Symbol('Metrics');

export const METRIC = {
  transactionsByStatus: 'wagering_transactions_total',
  duplicatesDetected: 'wagering_duplicates_total',
  idempotencyConflicts: 'wagering_idempotency_conflicts_total',
  lockConflicts: 'wagering_lock_conflicts_total',
  retries: 'wagering_retries_total',
  processingLatency: 'wagering_processing_seconds',
  reconciliationDivergences: 'wagering_reconciliation_divergences_total',
  sqsMessages: 'wagering_sqs_messages_total',
  dlqMessages: 'wagering_dlq_messages_total',
  outboxPublished: 'wagering_outbox_published_total',
  outboxFailures: 'wagering_outbox_failures_total',
  outboxLag: 'wagering_outbox_lag_seconds',
  outboxPublishDelay: 'wagering_outbox_publish_delay_seconds',
  outboxPending: 'wagering_outbox_pending',
  pendingReferenceResolved: 'wagering_pending_reference_total',
} as const;

export class NoopMetrics implements Metrics {
  increment(): void {}
  observe(): void {}
  setGauge(): void {}
}
