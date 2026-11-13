import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras vivem aqui, não só no código:
 * unicidade, imutabilidade do ledger, não-negatividade, aritmética de cada lançamento,
 * encadeamento do ledger e equivalência saldo ↔ último lançamento (constraint trigger diferida).
 */
export class Migration20261113000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id              uuid primary key,
        player_id       varchar(128)   not null check (length(btrim(player_id)) > 0),
        currency        char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance_amount  numeric(19,2)  not null,
        version         integer        not null check (version >= 1),
        created_at      timestamptz    not null,
        updated_at      timestamptz    not null,
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_currency_uq unique (id, currency)
      );
    `);

    // ------------------------------------------------------ wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        varchar(128)  not null check (length(btrim(provider_id)) > 0),
        external_transaction_id            varchar(256)  not null check (length(btrim(external_transaction_id)) > 0),
        idempotency_key                    varchar(512)  not null check (length(btrim(idempotency_key)) > 0),
        payload_hash                       char(64)      not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid          not null references wallets(id),
        player_id                          varchar(128)  not null,
        round_id                           varchar(256)  not null,
        game_id                            varchar(256)  not null,
        kind                               varchar(16)   not null
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(19,2) not null check (amount >= 0),
        currency                           char(3)       not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  varchar(256),
        reference_transaction_id           uuid references wager_transactions(id),
        status                             varchar(24)   not null
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        result_balance_amount              numeric(19,2) check (result_balance_amount >= 0),
        result_wallet_version              integer check (result_wallet_version >= 1),
        reference_attempts                 integer       not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz   not null,
        processed_at                       timestamptz,
        completed_at                       timestamptz,
        updated_at                         timestamptz   not null default now(),

        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        -- alvo das FKs compostas do ledger: lançamento pertence à wallet e ao valor da transação
        constraint wager_tx_ledger_target_uq unique (id, wallet_id, amount, currency),

        constraint wager_tx_reference_required
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reference_not_self
          check (reference_transaction_id is null or reference_transaction_id <> id),
        constraint wager_tx_amount_positive_when_moving
          check (kind = 'LOSS' or amount > 0),
        constraint wager_tx_opening_is_internal
          check ((kind = 'OPENING') = (provider_id = 'internal')),
        constraint wager_tx_failure_code_iff_rejected_or_failed
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_completed_iff_terminal
          check ((status in ('PROCESSED','REJECTED','FAILED')) = (completed_at is not null)),
        constraint wager_tx_processed_has_result
          check (status <> 'PROCESSED'
                 or (processed_at is not null and result_balance_amount is not null and result_wallet_version is not null)),
        constraint wager_tx_pending_reference_scheduled
          check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null)
      );
    `);

    // Uma única reversão PROCESSED (REFUND ou ROLLBACK) por transação referenciada.
    // Tentativas rejeitadas não entram no índice e não bloqueiam uma futura válida.
    this.addSql(`
      create unique index wager_tx_one_processed_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_tx_reference_lookup_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null;
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    // Transação terminal é imutável; campos de negócio nunca mudam; não há DELETE.
    this.addSql(`
      create function wager_transactions_guard() returns trigger
      language plpgsql as $fn$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted' using errcode = 'P0001';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status using errcode = 'P0001';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id using errcode = 'P0001';
        end if;
        if new.status = 'PENDING' and old.status <> 'PENDING' then
          raise exception 'invalid transition % -> PENDING', old.status using errcode = 'P0001';
        end if;
        new.updated_at := now();
        return new;
      end
      $fn$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    // ------------------------------------------------------------------ ledger
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        position        bigint generated always as identity,
        wallet_id       uuid          not null,
        transaction_id  uuid          not null,
        direction       varchar(6)    not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(19,2) not null check (amount > 0),
        currency        char(3)       not null,
        balance_before  numeric(19,2) not null check (balance_before >= 0),
        balance_after   numeric(19,2) not null check (balance_after >= 0),
        wallet_version  integer       not null check (wallet_version >= 1),
        created_at      timestamptz   not null,

        constraint ledger_position_uq unique (position),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        ),
        constraint ledger_one_entry_per_wallet_transaction unique (wallet_id, transaction_id),
        constraint ledger_one_entry_per_transaction unique (transaction_id),
        constraint ledger_one_entry_per_wallet_version unique (wallet_id, wallet_version),
        constraint ledger_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, amount, currency)
          references wager_transactions (id, wallet_id, amount, currency)
      );
    `);
    this.addSql(`create index ledger_wallet_position_idx on wallet_ledger_entries (wallet_id, position);`);

    // Append-only: nenhum UPDATE, DELETE ou TRUNCATE.
    this.addSql(`
      create function wallet_ledger_append_only() returns trigger
      language plpgsql as $fn$
      begin
        raise exception 'wallet_ledger_entries is append-only (% rejected)', tg_op using errcode = 'P0001';
      end
      $fn$;
    `);
    this.addSql(`
      create trigger wallet_ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_append_only();
    `);
    this.addSql(`
      create trigger wallet_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_append_only();
    `);

    // Encadeamento: balance_before de um lançamento = balance_after do lançamento da versão anterior.
    this.addSql(`
      create function wallet_ledger_chain() returns trigger
      language plpgsql as $fn$
      declare
        previous_after numeric(19,2);
      begin
        select balance_after into previous_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
        if found then
          if previous_after <> new.balance_before then
            raise exception 'ledger chain broken for wallet % at version %', new.wallet_id, new.wallet_version
              using errcode = '23514';
          end if;
        elsif new.balance_before <> 0
              or exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id) then
          raise exception 'ledger chain broken for wallet % at version %', new.wallet_id, new.wallet_version
            using errcode = '23514';
        end if;
        return new;
      end
      $fn$;
    `);
    this.addSql(`
      create trigger wallet_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_chain();
    `);

    // Saldo materializado = balance_after do lançamento da versão atual (verificado no commit).
    this.addSql(`
      create function wallets_match_ledger() returns trigger
      language plpgsql as $fn$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted' using errcode = 'P0001';
        end if;
        if exists (select 1 from wallet_ledger_entries e
                    where e.wallet_id = new.id
                      and e.wallet_version = new.version
                      and e.balance_after = new.balance_amount) then
          return null;
        end if;
        if new.balance_amount = 0 and new.version = 1
           and not exists (select 1 from wallet_ledger_entries e where e.wallet_id = new.id) then
          return null;
        end if;
        raise exception 'wallet % balance % at version % has no matching ledger entry',
          new.id, new.balance_amount, new.version using errcode = '23514';
      end
      $fn$;
    `);
    this.addSql(`
      create constraint trigger wallets_match_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_match_ledger();
    `);
    this.addSql(`
      create trigger wallets_no_delete
        before delete on wallets
        for each row execute function wallets_match_ledger();
    `);

    // ------------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name   varchar(128) not null,
        message_id      varchar(256) not null,
        payload_hash    char(64)     not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        transaction_id  uuid references wager_transactions(id),
        received_at     timestamptz  not null,
        processed_at    timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    // ------------------------------------------------------------------ outbox
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        position         bigint generated always as identity,
        aggregate_id     varchar(64)  not null,
        event_type       varchar(128) not null,
        payload          jsonb        not null,
        occurred_at      timestamptz  not null,
        attempts         integer      not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz  not null,
        published_at     timestamptz,
        locked_by        varchar(128),
        locked_until     timestamptz,
        last_error       varchar(512),
        constraint outbox_position_uq unique (position),
        constraint outbox_payload_matches check (
          payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type
        )
      );
    `);
    this.addSql(`
      create index outbox_pending_due_idx
        on outbox_messages (next_attempt_at, position)
        where published_at is null;
    `);
    this.addSql(`
      create function outbox_payload_immutable() returns trigger
      language plpgsql as $fn$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox event % is immutable', old.id using errcode = 'P0001';
        end if;
        if old.published_at is not null and new.published_at is distinct from old.published_at then
          raise exception 'outbox event % already published', old.id using errcode = 'P0001';
        end if;
        return new;
      end
      $fn$;
    `);
    this.addSql(`
      create trigger outbox_payload_immutable
        before update on outbox_messages
        for each row execute function outbox_payload_immutable();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop function if exists outbox_payload_immutable();');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_chain();');
    this.addSql('drop function if exists wallet_ledger_append_only();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop function if exists wager_transactions_guard();');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists wallets_match_ledger();');
  }
}
