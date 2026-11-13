import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ProviderIdentityPort, type ProviderIdentity } from '../../../iam/provider-identity';
import { InvalidInputError } from '../../../shared/domain/domain-error';
import { WagerTransactionStatus } from '../domain/wagering-types';
import { ForbiddenProviderError, NotFoundError } from '../application/errors';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { parseMoney, parseSubmitWagerCommand, requireObject, requireString, requireUuid } from '../application/wager-command';
import { OpenWallet, ReconcileWallet, WalletQueries } from '../application/wallet-use-cases';
import { CorrelationId } from './correlation';
import {
  presentLedgerEntry,
  presentReconciliation,
  presentSubmission,
  presentTransaction,
  presentWallet,
} from './presenters';

function requireIdentity(port: ProviderIdentityPort): ProviderIdentity {
  const identity = port.current();
  if (identity === undefined) throw new UnauthorizedException('missing_identity');
  return identity;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const src = requireObject(body, 'body');
    const playerId = requireString(src, 'playerId', 128);
    const initialBalance = parseMoney(src.initialBalance, 'initialBalance');
    const wallet = await this.openWallet.execute({ playerId, initialBalance }, { correlationId });
    return presentWallet(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(requireUuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const parsedLimit = limit === undefined ? 50 : /^\d{1,4}$/.test(limit) ? Number(limit) : Number.NaN;
    if (cursor !== undefined && typeof cursor !== 'string') {
      throw new InvalidInputError('INVALID_CURSOR', 'cursor is invalid');
    }
    const page = await this.queries.getLedger(requireUuid(walletId, 'walletId'), cursor || undefined, parsedLimit);
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor ?? null };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string, @CorrelationId() correlationId: string) {
    return presentReconciliation(await this.reconcile.execute(requireUuid(walletId, 'walletId'), { correlationId }));
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort,
  ) {}

  /**
   * 200 PROCESSED (inclusive replay) · 202 PENDING/PENDING_REFERENCE · 422 REJECTED/FAILED.
   * Replay repete o status HTTP original com `idempotentReplay: true`.
   */
  @Post('wagering/transactions')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const identity = requireIdentity(this.identity);
    const command = parseSubmitWagerCommand(body, idempotencyKey);
    if (identity.providerId !== command.providerId) throw new ForbiddenProviderError();
    const result = await this.submit.execute(command, { correlationId });
    res.status(httpStatusFor(result.transaction.status));
    return presentSubmission(result.transaction, result.idempotentReplay);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const identity = requireIdentity(this.identity);
    const tx = await this.queries.getTransaction(requireUuid(transactionId, 'transactionId'));
    // Um provedor não enxerga transações de outro: responde como inexistente.
    if (tx.providerId !== identity.providerId) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'transaction not found');
    return presentTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    const identity = requireIdentity(this.identity);
    if (identity.providerId !== providerId) throw new ForbiddenProviderError();
    return presentTransaction(await this.queries.getByProviderExternalId(providerId, externalId));
  }
}

export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}
