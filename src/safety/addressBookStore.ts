import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AddressBookError,
  MAX_BOOK_ADDRESSES,
  addressText,
  type AddressBinding,
  type AddressBookStore,
  type AddressReference,
  type NewAddressReference,
} from '../domain/addressBook.ts';

const require = createRequire(import.meta.url);

function openSqlite(): { new (path: string): any } {
  try { return require('node:sqlite').DatabaseSync; }
  catch { throw new AddressBookError('ADDRESS_STORE_SQLITE_UNAVAILABLE'); }
}
function scope(value: unknown): string { return addressText(value, 'INVALID_ADDRESS_SCOPE', 256); }
function id(value: unknown): string { return addressText(value, 'INVALID_ADDRESS_ID', 256); }
function alias(value: unknown): string { return addressText(value, 'INVALID_ADDRESS_ALIAS', 64); }

export class SqliteAddressBookStore implements AddressBookStore {
  private readonly db: any;
  constructor(file: string) {
    const path = file === ':memory:' ? file : resolve(addressText(file, 'INVALID_ADDRESS_STORE_PATH', 4096));
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = openSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA busy_timeout=5000; ' +
      'PRAGMA journal_mode=WAL; ' +
      'CREATE TABLE IF NOT EXISTS address_book (' +
      'user_id TEXT NOT NULL, provider_scope TEXT NOT NULL, address_id TEXT NOT NULL, alias TEXT NOT NULL, ' +
      'is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)), ' +
      'created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, ' +
      'PRIMARY KEY (user_id, provider_scope, address_id), ' +
      'UNIQUE (user_id, provider_scope, alias)' +
      '); ' +
      'CREATE UNIQUE INDEX IF NOT EXISTS one_default_address ON address_book(user_id, provider_scope) WHERE is_default=1;',
    );
  }
  add(input: NewAddressReference): AddressReference {
    const userId = scope(input.userId);
    const providerScope = scope(input.providerScope);
    const addressId = id(input.addressId);
    const name = alias(input.alias);
    if (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean') throw new AddressBookError('INVALID_ADDRESS_DEFAULT');
    const now = Date.now();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (input.makeDefault === true) {
        this.db.prepare('UPDATE address_book SET is_default=0, updated_at_ms=? WHERE user_id=? AND provider_scope=?').run(now, userId, providerScope);
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM address_book WHERE user_id=? AND provider_scope=?').get(userId, providerScope) as { count: number };
      if (count.count >= MAX_BOOK_ADDRESSES) throw new AddressBookError('ADDRESS_BOOK_FULL');
      this.db.prepare(
        'INSERT INTO address_book(user_id,provider_scope,address_id,alias,is_default,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)',
      ).run(userId, providerScope, addressId, name, input.makeDefault === true ? 1 : 0, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      if (error instanceof AddressBookError) throw error;
      throw new AddressBookError('ADDRESS_DUPLICATE');
    }
    return this.get({ userId, providerScope }, addressId)!;
  }
  list(binding: AddressBinding): readonly AddressReference[] {
    const userId = scope(binding.userId);
    const providerScope = scope(binding.providerScope);
    const rows = this.db.prepare(
      'SELECT * FROM address_book WHERE user_id=? AND provider_scope=? ORDER BY is_default DESC, updated_at_ms DESC, address_id ASC',
    ).all(userId, providerScope) as unknown[];
    return Object.freeze(rows.map((row) => Object.freeze(this.row(row as Record<string, unknown>))));
  }
  private get(binding: AddressBinding, addressId: string): AddressReference | undefined {
    const row = this.db.prepare(
      'SELECT * FROM address_book WHERE user_id=? AND provider_scope=? AND address_id=?',
    ).get(binding.userId, binding.providerScope, addressId) as Record<string, unknown> | undefined;
    return row ? Object.freeze(this.row(row)) : undefined;
  }
  setDefault(binding: AddressBinding, addressId: string): AddressReference {
    const userId = scope(binding.userId);
    const providerScope = scope(binding.providerScope);
    const target = id(addressId);
    const now = Date.now();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const exists = this.db.prepare('SELECT 1 FROM address_book WHERE user_id=? AND provider_scope=? AND address_id=?').get(userId, providerScope, target);
      if (!exists) throw new AddressBookError('ADDRESS_NOT_FOUND');
      this.db.prepare('UPDATE address_book SET is_default=0, updated_at_ms=? WHERE user_id=? AND provider_scope=?').run(now, userId, providerScope);
      this.db.prepare('UPDATE address_book SET is_default=1, updated_at_ms=? WHERE user_id=? AND provider_scope=? AND address_id=?').run(now, userId, providerScope, target);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      if (error instanceof AddressBookError) throw error;
      throw new AddressBookError('ADDRESS_NOT_FOUND');
    }
    return this.get({ userId, providerScope }, target)!;
  }
  delete(binding: AddressBinding, addressId: string): boolean {
    return this.db.prepare('DELETE FROM address_book WHERE user_id=? AND provider_scope=? AND address_id=?').run(
      scope(binding.userId), scope(binding.providerScope), id(addressId),
    ).changes === 1;
  }
  close(): void { this.db.close(); }
  private row(row: Record<string, unknown>): AddressReference {
    return {
      userId: String(row.user_id), providerScope: String(row.provider_scope), addressId: String(row.address_id),
      alias: String(row.alias), isDefault: row.is_default === 1, createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
    };
  }
}
