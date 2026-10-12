import { randomUUID } from 'node:crypto';

export interface AddressBinding { readonly userId: string; readonly providerScope: string; }
export interface AddressReference extends AddressBinding {
  readonly addressId: string; readonly alias: string; readonly isDefault: boolean;
  readonly createdAtMs: number; readonly updatedAtMs: number;
}
export interface NewAddressReference extends AddressBinding {
  readonly addressId: string; readonly alias: string; readonly makeDefault?: boolean;
}
export interface AddressBookStore {
  add(input: NewAddressReference): AddressReference;
  list(binding: AddressBinding): readonly AddressReference[];
  setDefault(binding: AddressBinding, addressId: string): AddressReference;
  delete(binding: AddressBinding, addressId: string): boolean;
}
/** Raw provider data is query-only and must never leave the query service or enter storage. */
export interface ProviderAddress {
  readonly addressId: string; readonly contactName: string; readonly phone: string; readonly fullAddress: string;
}
export interface AddressOption { readonly digit: number; readonly label: string; }
export interface AddressSearchResult {
  readonly snapshotId: string; readonly options: readonly AddressOption[];
  readonly expiresAtMs: number; readonly message: string;
}
export interface DeliveryAddressGateway {
  /** Adapters may be unbound (for synthetic/offline data). */
  readonly addressBinding?: AddressBinding;
  listDeliveryAddresses(): Promise<readonly ProviderAddress[]>;
}
export const MAX_PROVIDER_ADDRESSES = 100;
export const MAX_BOOK_ADDRESSES = 50;
export const MAX_ADDRESS_OPTIONS = 20;
export const DEFAULT_ADDRESS_TTL_MS = 300_000;
export class AddressBookError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'AddressBookError'; this.code = code; }
}
export function addressText(value: unknown, code: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new AddressBookError(code);
  return value.trim();
}
export function validateAddressBinding(binding: AddressBinding): AddressBinding {
  if (!binding || typeof binding !== 'object') throw new AddressBookError('INVALID_ADDRESS_SCOPE');
  return Object.freeze({ userId: addressText(binding.userId, 'INVALID_ADDRESS_SCOPE'), providerScope: addressText(binding.providerScope, 'INVALID_ADDRESS_SCOPE', 256) });
}
export function sameAddressBinding(a: AddressBinding | undefined, b: AddressBinding): boolean {
  return a !== undefined && a.userId === b.userId && a.providerScope === b.providerScope;
}
interface Snapshot { readonly id: string; readonly addressIds: readonly string[]; readonly expiresAtMs: number; }

export class AddressBookService {
  private readonly store: AddressBookStore;
  private readonly gateway: DeliveryAddressGateway;
  private readonly binding: AddressBinding;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private snapshot: Snapshot | undefined;
  private queryVersion = 0;
  constructor(store: AddressBookStore, binding: AddressBinding, gateway: DeliveryAddressGateway, options: { readonly ttlMs?: number; readonly now?: () => number } = {}) {
    this.store = store;
    this.gateway = gateway;
    this.binding = validateAddressBinding(binding);
    this.ttlMs = options.ttlMs ?? DEFAULT_ADDRESS_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > DEFAULT_ADDRESS_TTL_MS) throw new AddressBookError('INVALID_ADDRESS_TTL');
    this.checkBinding();
  }
  private checkBinding(): void {
    if (!sameAddressBinding(this.gateway.addressBinding, this.binding)) throw new AddressBookError('ADDRESS_SCOPE_MISMATCH');
  }
  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - this.ttlMs) throw new AddressBookError('INVALID_ADDRESS_TIME');
    return value;
  }
  private async addresses(): Promise<readonly ProviderAddress[]> {
    this.checkBinding();
    let rows: readonly ProviderAddress[];
    try { rows = await this.gateway.listDeliveryAddresses(); } catch { throw new AddressBookError('ADDRESS_QUERY_FAILED'); }
    this.checkBinding();
    if (!Array.isArray(rows) || rows.length > MAX_PROVIDER_ADDRESSES) throw new AddressBookError('INVALID_ADDRESS_RESPONSE');
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new AddressBookError('INVALID_ADDRESS_RESPONSE');
      const id = addressText(row.addressId, 'INVALID_ADDRESS_RESPONSE');
      addressText(row.contactName, 'INVALID_ADDRESS_RESPONSE', 80);
      addressText(row.phone, 'INVALID_ADDRESS_RESPONSE', 80);
      addressText(row.fullAddress, 'INVALID_ADDRESS_RESPONSE', 300);
      if (ids.has(id)) throw new AddressBookError('INVALID_ADDRESS_RESPONSE');
      ids.add(id);
    }
    return rows;
  }
  async query(query = ''): Promise<AddressSearchResult> {
    if (typeof query !== 'string' || query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) throw new AddressBookError('INVALID_ADDRESS_QUERY');
    const version = ++this.queryVersion;
    this.snapshot = undefined;
    const rows = await this.addresses();
    if (version !== this.queryVersion) throw new AddressBookError('ADDRESS_QUERY_SUPERSEDED');
    const wanted = query.trim().toLocaleLowerCase();
    const matched = rows.filter((row) => (row.fullAddress + ' ' + row.contactName).toLocaleLowerCase().includes(wanted));
    if (matched.length > MAX_ADDRESS_OPTIONS) throw new AddressBookError('ADDRESS_QUERY_TOO_BROAD');
    const expiresAtMs = this.time() + this.ttlMs;
    const snapshot: Snapshot = Object.freeze({ id: randomUUID(), addressIds: Object.freeze(matched.map((row) => row.addressId)), expiresAtMs });
    this.snapshot = snapshot;
    const hints = matched.map((row) => coarseAddressHint(row.fullAddress));
    const ambiguousHints = new Set(hints.filter((hint, index) => hints.indexOf(hint) !== index));
    if (ambiguousHints.size > 0) throw new AddressBookError('ADDRESS_QUERY_NEEDS_NARROWING');
    const options = Object.freeze(matched.map((row, index) => Object.freeze({ digit: index + 1, label: '配送地址 ' + (index + 1) + '：' + hints[index] })));
    return Object.freeze({ snapshotId: snapshot.id, options, expiresAtMs, message: options.length ? '请回复地址编号；保存后可单独设为默认地址。' : '未找到匹配地址，请先在麦当劳官方渠道添加地址，再重新查询。' });
  }
  async selectAndSave(snapshotId: string, digit: number, alias: string, makeDefault = false): Promise<AddressReference> {
    this.checkBinding();
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== snapshotId || this.time() >= snapshot.expiresAtMs) throw new AddressBookError('ADDRESS_SELECTION_EXPIRED');
    if (!Number.isSafeInteger(digit) || digit < 1 || digit > snapshot.addressIds.length) throw new AddressBookError('INVALID_ADDRESS_SELECTION');
    const safeAlias = addressText(alias, 'INVALID_ADDRESS_ALIAS', 64);
    if (typeof makeDefault !== 'boolean') throw new AddressBookError('INVALID_ADDRESS_DEFAULT');
    this.snapshot = undefined;
    const addressId = snapshot.addressIds[digit - 1];
    const current = await this.addresses();
    if (this.time() >= snapshot.expiresAtMs) throw new AddressBookError('ADDRESS_SELECTION_EXPIRED');
    if (!current.some((row) => row.addressId === addressId)) throw new AddressBookError('ADDRESS_PROVIDER_REFERENCE_STALE');
    try { return this.store.add({ ...this.binding, addressId, alias: safeAlias, makeDefault }); }
    catch (error) { throw safeStoreError(error, 'ADDRESS_SAVE_FAILED'); }
  }
  list(): readonly AddressReference[] { this.checkBinding(); return this.store.list(this.binding); }
  async setDefault(addressId: string): Promise<AddressReference> {
    const id = addressText(addressId, 'INVALID_ADDRESS_ID');
    if (!(await this.addresses()).some((row) => row.addressId === id)) throw new AddressBookError('ADDRESS_PROVIDER_REFERENCE_STALE');
    try { return this.store.setDefault(this.binding, id); }
    catch (error) { throw safeStoreError(error, 'ADDRESS_NOT_FOUND'); }
  }
  delete(addressId: string): boolean { this.checkBinding(); return this.store.delete(this.binding, addressText(addressId, 'INVALID_ADDRESS_ID')); }
  async resolveDefault(): Promise<AddressReference | undefined> {
    const entry = this.list().find((row) => row.isDefault);
    if (!entry) return undefined;
    if (!(await this.addresses()).some((row) => row.addressId === entry.addressId)) throw new AddressBookError('ADDRESS_PROVIDER_REFERENCE_STALE');
    return entry;
  }
}
function coarseAddressHint(value: string): string {
  const normalized = value.trim();
  // Chinese doorplate numbers (e.g. "一号" / "十二号") are detail fields too.
  // Keep them out of the public candidate label just like Arabic numerals.
  const detailStart = normalized.search(
    /[0-9０-９#＃栋幢座单元室楼层弄巷号號-]|[〇零一二两三四五六七八九十百千万亿甲乙丙丁]+(?=[号號栋幢座单元室楼层弄巷])/u,
  );
  const coarse = (detailStart >= 0 ? normalized.slice(0, detailStart) : normalized).trim();
  return coarse.length ? coarse.slice(-24) + '附近' : '已保存地址';
}
function safeStoreError(error: unknown, fallback: string): AddressBookError {
  const code = error instanceof AddressBookError ? error.code : '';
  const allowed = new Set(['ADDRESS_DUPLICATE', 'ADDRESS_BOOK_FULL', 'ADDRESS_NOT_FOUND']);
  return new AddressBookError(allowed.has(code) ? code : fallback);
}
function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 2 ? '******' + digits.slice(-2) : '******';
}
function maskContactName(value: string): string {
  const chars = Array.from(value);
  return chars.length > 1 ? chars[0] + '*'.repeat(Math.min(8, chars.length - 1)) : '*';
}
function maskFullAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2) return '**';
  return trimmed.slice(0, 1) + '*'.repeat(Math.min(8, Math.max(2, trimmed.length - 2))) + trimmed.slice(-1);
}
/** Validate and whitelist provider fields; raw values live only during this query call. */
export function normalizeProviderAddress(value: unknown): ProviderAddress {
  const raw = normalizeProviderAddressForQuery(value);
  return Object.freeze({
    addressId: raw.addressId,
    contactName: maskContactName(raw.contactName),
    phone: maskPhone(raw.phone),
    fullAddress: maskFullAddress(raw.fullAddress),
  });
}
/** Query-only normalized provider fields. Never persist or return this object. */
export function normalizeProviderAddressForQuery(value: unknown): ProviderAddress {
  if (!value || typeof value !== 'object') throw new AddressBookError('INVALID_ADDRESS_RESPONSE');
  const row = value as Record<string, unknown>;
  return Object.freeze({ addressId: addressText(row.addressId, 'INVALID_ADDRESS_RESPONSE'), contactName: addressText(row.contactName, 'INVALID_ADDRESS_RESPONSE', 80), phone: addressText(row.phone, 'INVALID_ADDRESS_RESPONSE', 80), fullAddress: addressText(row.fullAddress, 'INVALID_ADDRESS_RESPONSE', 300) });
}
