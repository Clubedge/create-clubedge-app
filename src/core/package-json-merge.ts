// package.json files merge by key instead of by line (#142), so edits to different keys never
// conflict: a script the project adds after the Starter's, or an override next to one the
// Starter adds. A key both sides changed to different values is a conflict, except a dependency
// both raised within its range (see higherRange). The merged file is written twice, with your
// value for each conflict and with the Starter's, and merge.ts puts conflict markers around the
// lines where the two differ, which are that key's.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** A key both sides changed to different values; undefined is a side that removed it. */
class Conflict {
  constructor(
    readonly yours: Json | undefined,
    readonly theirs: Json | undefined,
  ) {}
}

type Merged = Json | Conflict | MergedObject;
interface MergedObject {
  [key: string]: Merged;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Conflict);

const own = (object: JsonObject, key: string): Json | undefined => (Object.hasOwn(object, key) ? object[key] : undefined);

/** Sets a key as data, so a key named __proto__ cannot change the object's prototype. */
function set<T>(object: Record<string, T>, key: string, value: T) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Equal JSON values; objects regardless of their key order. */
function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return false;
}

/** The objects whose values are version ranges: a package's dependencies, and pnpm's overrides. */
const RANGE_OBJECTS = [["dependencies"], ["devDependencies"], ["peerDependencies"], ["optionalDependencies"], ["pnpm", "overrides"]];

const holdsRanges = (path: readonly string[]) =>
  RANGE_OBJECTS.some((object) => object.length === path.length && object.every((key, i) => key === path[i]));

/** A ^ or ~ range on a full version, without a prerelease: ^1.7.21, ~58.0.24. */
const SIMPLE_RANGE = /^([\^~])(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Of two ^ ranges, or two ~ ranges, the one with the higher minimum, when every version it
 * allows the other allows too: the same major for ^ (the same minor for ^0.x, the same version
 * for ^0.0.x), the same minor for ~. Then the higher one satisfies both sides, as `pnpm up` raising
 * a project's version within its range does. Undefined for anything else, which stays a conflict:
 * exact versions (Expo pins some), different operators or majors, prereleases, workspace:, npm:
 * aliases and URLs.
 */
function higherRange(a: string, b: string): string | undefined {
  const first = SIMPLE_RANGE.exec(a);
  const second = SIMPLE_RANGE.exec(b);
  if (!first || !second || first[1] !== second[1]) return undefined;
  const x = first.slice(2).map(Number);
  const y = second.slice(2).map(Number);
  // How many numbers a range keeps fixed: ~ the major and minor, ^ up to its first one that is not 0.
  const fixed = (version: number[]) => (first[1] === "~" ? 2 : version.findIndex((n) => n !== 0) + 1 || 3);
  const kept = fixed(x);
  if (kept !== fixed(y) || x.slice(0, kept).some((n, i) => n !== y[i])) return undefined;
  for (const [i, n] of x.entries()) if (n !== y[i]) return n > (y[i] ?? 0) ? a : b;
  return a;
}

/**
 * Whether `range` raises `base` within the versions `base` already allowed, as `pnpm up` does:
 * ^5.8.0 to ^5.12.2. A raise like that only takes newer releases, so it is no edit of its own.
 */
const raisedWithin = (base: Json | undefined, range: Json | undefined) =>
  typeof base === "string" && typeof range === "string" && range !== base && higherRange(base, range) === range;

/** Whether a dependency map has the base's dependencies, each the same or only raised within its range. */
const onlyRaised = (base: Json | undefined, map: Json | undefined) =>
  isObject(base) &&
  isObject(map) &&
  Object.keys(map).length === Object.keys(base).length &&
  Object.entries(map).every(([key, range]) => Object.hasOwn(base, key) && (same(base[key], range) || raisedWithin(base[key], range)));

/** The lowest version a ^ or ~ range, or an exact version, allows; undefined for anything else. */
function minimum(range: Json | undefined): number[] | undefined {
  if (typeof range !== "string") return undefined;
  const match = SIMPLE_RANGE.exec(range) ?? /^()(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(range);
  return match ? match.slice(2).map(Number) : undefined;
}

/** Whether `range` asks for at least the lowest version `than` allows: ^6.3.1 than ^5.12.2. */
function atLeast(range: Json | undefined, than: Json | undefined) {
  const [a, b] = [minimum(range), minimum(than)];
  if (!a || !b) return false;
  const differs = a.findIndex((n, i) => n !== b[i]);
  return differs === -1 || a[differs]! > b[differs]!;
}

/**
 * One key's value, at `path` from the file's root: whoever changed it, or a conflict when both
 * did, differently. Objects both changed merge key by key; arrays and scalars are single values.
 * Undefined is a removed key. A dependency both raised within its range takes the higher range.
 * One that a side only raised within its range, as `pnpm up` does, takes the other side's change
 * when that removes it or asks for at least the raised version: the Starter's removal of a
 * dependency, or its new major, over the project's `pnpm up`, and the other way round.
 */
function merge(base: Json | undefined, yours: Json | undefined, theirs: Json | undefined, path: string[]): Merged | undefined {
  if (same(yours, theirs) || same(base, theirs)) return yours;
  if (same(base, yours)) return theirs;
  if (isObject(yours) && isObject(theirs)) return mergeObjects(isObject(base) ? base : {}, yours, theirs, path);
  if (holdsRanges(path.slice(0, -1))) {
    const yoursRaised = raisedWithin(base, yours);
    if (yoursRaised !== raisedWithin(base, theirs)) {
      const [raised, other] = yoursRaised ? [yours, theirs] : [theirs, yours];
      if (other === undefined || atLeast(other, raised)) return other;
    }
  }
  // A whole dependency map one side only raised within its ranges, removed by the other side.
  if (holdsRanges(path) && ((theirs === undefined && onlyRaised(base, yours)) || (yours === undefined && onlyRaised(base, theirs)))) {
    return undefined;
  }
  if (typeof yours === "string" && typeof theirs === "string" && holdsRanges(path.slice(0, -1))) {
    const higher = higherRange(yours, theirs);
    if (higher !== undefined) return higher;
  }
  return new Conflict(yours, theirs);
}

/**
 * Your keys in your order; a key only the Starter has goes after the key it follows in the
 * Starter's file, or first. At the root, `clubedge` (the provenance) is always the Starter's.
 * `path` is the object's, from the file's root.
 */
function mergeObjects(base: JsonObject, yours: JsonObject, theirs: JsonObject, path: string[] = []): MergedObject {
  const order = Object.keys(yours);
  let previous: string | undefined;
  for (const key of Object.keys(theirs)) {
    if (!order.includes(key)) order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, key);
    previous = key;
  }
  const result: MergedObject = {};
  for (const key of order) {
    const value =
      path.length === 0 && key === "clubedge" ? own(theirs, key) : merge(own(base, key), own(yours, key), own(theirs, key), [...path, key]);
    if (value !== undefined) set(result, key, value);
  }
  return result;
}

/** The merged value with one side's value for each conflict. */
function resolve(value: Merged, side: "yours" | "theirs"): Json | undefined {
  if (value instanceof Conflict) return value[side];
  if (!isObject(value)) return value as Json;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value as MergedObject)) {
    const resolved = resolve(item, side);
    if (resolved !== undefined) set(result, key, resolved);
  }
  return result;
}

/**
 * The file's indentation, as npm reads it: the whitespace before the first key, after the
 * opening brace's line. A file on one line has none, and stays on one line.
 */
function indentation(text: string) {
  return /^\s*\{\n([ \t]*)"/.exec(text)?.[1] ?? "";
}

/**
 * Merges base -> target into current, all LF text. Resolves the result written with your value
 * for each conflict and with the Starter's (equal when there are none), in your file's
 * indentation and final newline; null when a side is not a JSON object, to merge by line.
 */
export function mergePackageJson(current: string, base: string, target: string): { yours: string; theirs: string } | null {
  let parsed: [unknown, unknown, unknown];
  try {
    parsed = [JSON.parse(current), JSON.parse(base), JSON.parse(target)];
  } catch {
    return null;
  }
  const [yours, before, theirs] = parsed;
  if (!isObject(yours) || !isObject(before) || !isObject(theirs)) return null;
  const merged = mergeObjects(before, yours, theirs);
  const write = (side: "yours" | "theirs") =>
    JSON.stringify(resolve(merged, side), null, indentation(current)) + (current.endsWith("\n") ? "\n" : "");
  return { yours: write("yours"), theirs: write("theirs") };
}
