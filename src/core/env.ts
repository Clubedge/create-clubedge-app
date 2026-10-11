// The local env file holds the developer's secrets, so commands treat it line by line, the way
// the three-way merge treats files: values still at their generated defaults follow the new
// selection, and values the developer set are never changed or removed.

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENT = /^\s*#/;

const keyOf = (line: string) => LINE.exec(line)?.[1];
const valueOf = (line: string) => LINE.exec(line)![2]!.replace(/\s+#.*$/, "").trim();
const find = (lines: string[], key: string) => lines.findIndex((line) => keyOf(line) === key);

function values(lines: string[]) {
  const map = new Map<string, string>();
  for (const line of lines) {
    const key = keyOf(line);
    if (key) map.set(key, valueOf(line));
  }
  return map;
}

/** The comment lines directly above line `at`. */
function commentsAbove(lines: string[], at: number) {
  let start = at;
  while (start > 0 && COMMENT.test(lines[start - 1]!)) start--;
  return lines.slice(start, at);
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

export interface EnvUpdate {
  /** The local file after the update; equal to the input when nothing changed. */
  text: string;
  /** Variables added because the target's example introduces them. */
  added: string[];
  /** Variables still set to the base's example value, now set to the target's. */
  updated: string[];
  /** Variables still set to the base's example value that the target no longer uses, removed. */
  removed: string[];
  /** Variables the developer set whose example value changed; left as they are. */
  customized: string[];
  /** Variables the developer set that the target no longer uses; left as they are. */
  unused: string[];
}

/**
 * Updates the local env file from the base example to the target example. Each variable's
 * comment lines move with it unless the developer edited them, and a new variable is added after
 * the variable it follows in the target's example, or at the end.
 */
export function updateEnvFile(local: string, baseExample: string, targetExample: string): EnvUpdate {
  const base = baseExample.split(/\r?\n/);
  const target = targetExample.split(/\r?\n/);
  const baseValues = values(base);
  const targetValues = values(target);
  const lines = local.split(/\r?\n/);
  const mine = values(lines);
  const eol = local.includes("\r\n") ? "\r\n" : "\n";
  const result: EnvUpdate = { text: local, added: [], updated: [], removed: [], customized: [], unused: [] };

  /** Replaces the variable's line, and its comments if the developer kept the base's. */
  function replace(key: string, replacement: string[]) {
    const at = find(lines, key);
    const comments = commentsAbove(lines, at);
    const generated = sameLines(comments, commentsAbove(base, find(base, key)));
    const start = generated ? at - comments.length : at;
    lines.splice(start, at - start + 1, ...(generated ? replacement : replacement.slice(-1)));
  }

  for (const [key, before] of baseValues) {
    if (!mine.has(key)) continue;
    const after = targetValues.get(key);
    if (after === before || mine.get(key) === after) continue;
    const generated = mine.get(key) === before;
    if (after === undefined) {
      (generated ? result.removed : result.unused).push(key);
      if (generated) replace(key, []);
    } else {
      (generated ? result.updated : result.customized).push(key);
      if (generated) {
        const at = find(target, key);
        replace(key, [...commentsAbove(target, at), target[at]!]);
      }
    }
  }

  const appended: string[] = [];
  target.forEach((line, at) => {
    const key = keyOf(line);
    if (!key || baseValues.has(key) || mine.has(key) || result.added.includes(key)) return;
    result.added.push(key);
    // The nearest variable above it in the target, and the blank or comment lines in between.
    let anchor = at - 1;
    while (anchor >= 0 && !keyOf(target[anchor]!)) anchor--;
    const position = anchor >= 0 ? find(lines, keyOf(target[anchor]!)!) : -1;
    if (position === -1) appended.push(...commentsAbove(target, at), line);
    else lines.splice(position + 1, 0, ...target.slice(anchor + 1, at + 1));
  });

  let text = lines.join(eol);
  // Removed variables can leave blank lines in a row, as removed template blocks do.
  if (result.removed.length) {
    text = text.replace(new RegExp(`(?:${eol}){3,}`, "g"), eol + eol);
    if (local.endsWith(eol)) text = text.replace(new RegExp(`(?:${eol})+$`), eol);
  }
  if (appended.length) {
    const separator = text === "" || text.endsWith(eol) ? "" : eol;
    text += `${separator}${eol}${appended.join(eol)}${eol}`;
  }
  result.text = text;
  return result;
}
