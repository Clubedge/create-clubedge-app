// package.json files merge by key instead of by line (#142), so edits to different keys never
// conflict: a script the project adds after the Starter's, or an override next to one the
// Starter adds. A key both sides changed to different values is a conflict. The merged file is
// written twice, with your value for each such key and with the Starter's, and merge.ts puts
// conflict markers around the lines where the two differ, which are that key's.

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

/**
 * One key's value: whoever changed it, or a conflict when both did, differently. Objects both
 * changed merge key by key; arrays and scalars are single values. Undefined is a removed key.
 */
function merge(base: Json | undefined, yours: Json | undefined, theirs: Json | undefined): Merged | undefined {
  if (same(yours, theirs) || same(base, theirs)) return yours;
  if (same(base, yours)) return theirs;
  if (isObject(yours) && isObject(theirs)) return mergeObjects(isObject(base) ? base : {}, yours, theirs);
  return new Conflict(yours, theirs);
}

/**
 * Your keys in your order; a key only the Starter has goes after the key it follows in the
 * Starter's file, or first. At the root, `clubedge` (the provenance) is always the Starter's.
 */
function mergeObjects(base: JsonObject, yours: JsonObject, theirs: JsonObject, root = false): MergedObject {
  const order = Object.keys(yours);
  let previous: string | undefined;
  for (const key of Object.keys(theirs)) {
    if (!order.includes(key)) order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, key);
    previous = key;
  }
  const result: MergedObject = {};
  for (const key of order) {
    const value = root && key === "clubedge" ? own(theirs, key) : merge(own(base, key), own(yours, key), own(theirs, key));
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
  const merged = mergeObjects(before, yours, theirs, true);
  const write = (side: "yours" | "theirs") =>
    JSON.stringify(resolve(merged, side), null, indentation(current)) + (current.endsWith("\n") ? "\n" : "");
  return { yours: write("yours"), theirs: write("theirs") };
}
