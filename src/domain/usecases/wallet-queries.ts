import type { UnitOfWork } from '../contracts';
import type { WagerTransaction } from '../entities/wager-transaction';
import type { Wallet } from '../entities/wallet';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry';
import { NotFoundError } from '../errors/application-errors';
import { InvalidInputError } from '../errors/domain-error';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

const MAX_PAGE = 200;

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (wallet === undefined) throw new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
    return wallet;
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new InvalidInputError('INVALID_FIELD', `limit must be an integer between 1 and ${MAX_PAGE}`);
    }
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    await this.getWallet(walletId);
    const rows = await this.uow.read((r) => r.ledger.page(walletId, after, limit + 1));
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => row.entry),
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.position) : undefined,
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findById(transactionId));
    if (tx === undefined) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${transactionId} not found`);
    return tx;
  }

  async getByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((r) => r.transactions.findByProviderExternalId(providerId, externalTransactionId));
    if (tx === undefined) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    return tx;
  }
}

export function encodeCursor(position: string): string {
  return Buffer.from(`v1:${position}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (match?.[1] === undefined) throw new InvalidInputError('INVALID_CURSOR', 'cursor is invalid');
  return match[1];
}
