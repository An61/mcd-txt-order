/**
 * S10-A1: search based ordering input contract.
 *
 * This module only parses a message into typed, non executable intent. It does
 * not search MCP, choose a store or meal, and never turns arbitrary text into
 * create-order arguments. Entity resolution belongs to later S10 tasks.
 */

import { foldWidth, normalizeLoose, stripCourtesy, trimPunctuation } from './text.ts';

export type SearchOrderMode = 'delivery' | 'dineIn' | 'pickup' | 'driveThrough';

export type SearchOrderMissingField = 'mode' | 'meal' | 'store' | 'address';

export type SearchOrderParseStatus = 'ready' | 'needs-input' | 'needs-resolution' | 'invalid';

export type CandidateKind = 'store' | 'meal' | 'address';

export interface CandidateOption<T = unknown> {
  readonly key: string;
  readonly label: string;
  readonly value: T;
}

/** A candidate list is a response contract; selecting it is handled by S10-A3. */
export interface CandidateSet<T = unknown> {
  readonly kind: CandidateKind;
  readonly options: readonly CandidateOption<T>[];
  readonly selectedIndex?: number;
}

export interface SearchOrderParseBase {
  readonly rawText: string;
  readonly normalizedText: string;
  readonly status: SearchOrderParseStatus;
  readonly missingFields: readonly SearchOrderMissingField[];
  readonly ambiguities: readonly string[];
}

export interface NamedSearchOrderInput extends SearchOrderParseBase {
  readonly kind: 'named';
  readonly mode?: SearchOrderMode;
  /** The user-facing meal query; it is not a provider product code. */
  readonly mealQuery?: string;
  /** Store query for dine-in, pickup and drive-through. */
  readonly storeQuery?: string;
  /** Saved-address reference or address search text for delivery. */
  readonly addressReference?: string;
  /** Kept when mode is missing and the place role cannot be decided safely. */
  readonly placeQuery?: string;
  /** Modifier text is preserved for the modification parser in a later task. */
  readonly modifierText?: string;
  /** Parts whose entity role cannot be decided from syntax alone. */
  readonly unresolvedParts: readonly string[];
}

export interface LegacySlotSearchOrderInput extends SearchOrderParseBase {
  readonly kind: 'legacy';
  readonly mode: SearchOrderMode;
  /** Compatibility slot 1/2/3; S10-A4 resolves it only through configured data. */
  readonly mealSlot: '1' | '2' | '3';
  /** Compatibility slot a/b/c; S10-A4 resolves it only through configured data. */
  readonly placeSlot: 'a' | 'b' | 'c';
}

export interface InvalidSearchOrderInput extends SearchOrderParseBase {
  readonly kind: 'invalid';
  readonly reason: 'empty' | 'multiple-modes' | 'unsupported-format';
}

export type SearchOrderInput = NamedSearchOrderInput | LegacySlotSearchOrderInput | InvalidSearchOrderInput;

const MODE_ALIASES: readonly [string, SearchOrderMode][] = [
  ['得来速', 'driveThrough'],
  ['外卖', 'delivery'],
  ['配送', 'delivery'],
  ['堂食', 'dineIn'],
  ['自取', 'pickup'],
  ['取餐', 'pickup'],
];

const ADDRESS_REFERENCES = new Set(['家', '家里', '公司', '单位', '宿舍', '办公室']);

/** Parse a message without performing provider lookup or any write operation. */
export function parseSearchOrder(rawText: string): SearchOrderInput {
  const raw = typeof rawText === 'string' ? rawText : '';
  const normalizedText = normalizeLoose(stripCourtesy(raw));
  if (!normalizedText) {
    return {
      kind: 'invalid',
      rawText: raw,
      normalizedText,
      status: 'invalid',
      reason: 'empty',
      missingFields: [],
      ambiguities: [],
    };
  }

  const legacy = parseLegacy(normalizedText, raw);
  if (legacy) return legacy;

  const modeMatches = findModes(normalizedText);
  if (modeMatches.length > 1) {
    return {
      kind: 'invalid',
      rawText: raw,
      normalizedText,
      status: 'invalid',
      reason: 'multiple-modes',
      missingFields: [],
      ambiguities: ['multiple-mode-tokens'],
    };
  }

  const modeMatch = modeMatches[0];
  const mode = modeMatch?.mode;
  const withoutMode = modeMatch ? removeAt(normalizedText, modeMatch.start, modeMatch.length) : normalizedText;
  const { modifierText, searchText } = extractModifier(withoutMode);
  const explicit = extractExplicitQueries(searchText);
  const hasExplicitQuery = Boolean(explicit.mealQuery || explicit.placeQuery);
  const parts = hasExplicitQuery ? explicit.remainingParts : splitParts(searchText);
  const resolved = resolveRoles(mode, explicit.mealQuery, explicit.placeQuery, parts);
  const missingFields = missingFor(mode, resolved.mealQuery, resolved.placeQuery);
  const ambiguities = [...resolved.ambiguities];
  if (!mode) ambiguities.push('mode-required');

  const status: SearchOrderParseStatus = missingFields.length > 0
    ? (resolved.unresolvedParts.length > 0 && mode ? 'needs-resolution' : 'needs-input')
    : (resolved.unresolvedParts.length > 0 || ambiguities.length > 0 ? 'needs-resolution' : 'ready');

  return {
    kind: 'named',
    rawText: raw,
    normalizedText,
    status,
    mode,
    mealQuery: resolved.mealQuery,
    ...(mode === 'delivery'
      ? { addressReference: resolved.placeQuery }
      : { storeQuery: resolved.placeQuery }),
    ...(!mode && resolved.placeQuery ? { placeQuery: resolved.placeQuery } : {}),
    ...(modifierText ? { modifierText } : {}),
    missingFields,
    ambiguities,
    unresolvedParts: resolved.unresolvedParts,
  };
}

function parseLegacy(normalizedText: string, rawText: string): LegacySlotSearchOrderInput | undefined {
  const compact = normalizedText.replace(/[\s,，、;；|/]+/g, '');
  const match = /^(1|2|3)(外卖|配送|堂食|自取|取餐|得来速)(a|b|c)$/i.exec(compact);
  if (!match) return undefined;
  const mode = modeForAlias(match[2]);
  if (!mode) return undefined;
  return {
    kind: 'legacy',
    rawText,
    normalizedText,
    status: 'ready',
    mode,
    mealSlot: match[1] as '1' | '2' | '3',
    placeSlot: match[3].toLowerCase() as 'a' | 'b' | 'c',
    missingFields: [],
    ambiguities: ['legacy-slots-require-configured-resolution'],
  };
}

function findModes(text: string): Array<{ mode: SearchOrderMode; start: number; length: number }> {
  const found: Array<{ mode: SearchOrderMode; start: number; length: number }> = [];
  for (const [alias, mode] of MODE_ALIASES) {
    let start = text.indexOf(alias);
    while (start >= 0) {
      found.push({ mode, start, length: alias.length });
      start = text.indexOf(alias, start + alias.length);
    }
  }
  return found.sort((a, b) => a.start - b.start || b.length - a.length);
}

function modeForAlias(alias: string): SearchOrderMode | undefined {
  return MODE_ALIASES.find(([name]) => name === alias)?.[1];
}

function removeAt(text: string, start: number, length: number): string {
  return normalizeLoose(`${text.slice(0, start)} ${text.slice(start + length)}`);
}

function extractModifier(text: string): { modifierText?: string; searchText: string } {
  const markers = '(?:不要|不加|少放|去掉|去除|多加)';
  const match = new RegExp(`${markers}[^,，、;；|/]+`, 'g');
  const values = [...text.matchAll(match)];
  if (values.length === 0) return { searchText: text };
  const modifierText = values.map((entry) => trimPunctuation(entry[0])).filter(Boolean).join('，');
  let searchText = text;
  for (const entry of values) searchText = searchText.replace(entry[0], ' ');
  return { modifierText, searchText: normalizeLoose(searchText) };
}

function extractExplicitQueries(text: string): {
  mealQuery?: string;
  placeQuery?: string;
  remainingParts: string[];
} {
  const stop = '(?=\\s|$)';
  const meal = takeLabeled(text, new RegExp(`(?:餐品|菜品|meal)[:：]\\s*([^,，、;；|/\\s]+)${stop}`, 'i'));
  const place = takeLabeled(text, new RegExp(`(?:餐厅|门店|地址|store|address)[:：]\\s*([^,，、;；|/\\s]+)${stop}`, 'i'));
  const consumed = [meal?.full, place?.full].filter((value): value is string => Boolean(value));
  let remaining = text;
  for (const value of consumed) remaining = remaining.replace(value, ' ');
  return {
    ...(meal?.value ? { mealQuery: cleanQuery(meal.value) } : {}),
    ...(place?.value ? { placeQuery: cleanQuery(place.value) } : {}),
    remainingParts: splitParts(remaining),
  };
}

function takeLabeled(text: string, pattern: RegExp): { full: string; value: string } | undefined {
  const match = pattern.exec(text);
  return match?.[0] && match[1] ? { full: match[0], value: match[1] } : undefined;
}

function splitParts(text: string): string[] {
  return text
    .replace(/[，、,;；|/]+/g, ' ')
    .split(/\s+/)
    .map(cleanQuery)
    .filter(Boolean);
}

function cleanQuery(value: string): string {
  return trimPunctuation(normalizeLoose(foldWidth(value)));
}

function resolveRoles(
  mode: SearchOrderMode | undefined,
  explicitMeal: string | undefined,
  explicitPlace: string | undefined,
  parts: readonly string[],
): { mealQuery?: string; placeQuery?: string; unresolvedParts: string[]; ambiguities: string[] } {
  if (explicitMeal || explicitPlace) {
    const unresolvedParts = parts.filter((part) => part !== explicitMeal && part !== explicitPlace);
    return {
      ...(explicitMeal ? { mealQuery: explicitMeal } : {}),
      ...(explicitPlace ? { placeQuery: explicitPlace } : {}),
      unresolvedParts: unresolvedParts as string[],
      ambiguities: unresolvedParts.length > 0 ? ['extra-query-parts'] : [],
    };
  }

  if (parts.length === 2) {
    const firstIsPlace = looksLikePlace(parts[0], mode);
    const secondIsPlace = looksLikePlace(parts[1], mode);
    if (firstIsPlace !== secondIsPlace) {
      return firstIsPlace
        ? { mealQuery: parts[1], placeQuery: parts[0], unresolvedParts: [], ambiguities: [] }
        : { mealQuery: parts[0], placeQuery: parts[1], unresolvedParts: [], ambiguities: [] };
    }
  }

  return {
    unresolvedParts: [...parts],
    ambiguities: parts.length > 0 ? ['meal-place-role-unresolved'] : [],
  };
}

function looksLikePlace(value: string, mode: SearchOrderMode | undefined): boolean {
  const compact = value.replace(/\s+/g, '');
  if (mode === 'delivery' && ADDRESS_REFERENCES.has(compact)) return true;
  if (/(店|餐厅|门店|餐馆|中心|广场|商场)$/.test(compact)) return true;
  return false;
}

function missingFor(
  mode: SearchOrderMode | undefined,
  mealQuery: string | undefined,
  placeQuery: string | undefined,
): SearchOrderMissingField[] {
  const missing: SearchOrderMissingField[] = [];
  if (!mode) missing.push('mode');
  if (!mealQuery) missing.push('meal');
  if (!placeQuery) missing.push(mode === 'delivery' ? 'address' : 'store');
  return missing;
}

