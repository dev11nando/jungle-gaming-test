export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldGoNegative = 'REVERSAL_WOULD_GO_NEGATIVE',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}

export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
