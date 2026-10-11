// pnpm links a package's optional peer dependency whenever that peer is installed anywhere in the
// workspace, and records the link in lockfile keys: drizzle-orm@0.45.4(@electric-sql/pglite@0.5.8).
// When a left-out workspace package was the only reason the peer was installed, the link would
// keep installing it, so these helpers remove such links from the lockfile.

type Dependency = { name: string; ref: string };

function unquote(text: string) {
  return text.replace(/^(['"])(.*)\1$/, "$2");
}

/** "drizzle-orm@0.45.4(pglite@0.5.8)" -> "drizzle-orm@0.45.4"; "0.45.4(x@1)" -> "0.45.4". */
function withoutSuffix(text: string) {
  const start = text.indexOf("(");
  return start === -1 ? text : text.slice(0, start);
}

interface ParsedLockfile {
  roots: string[];
  optionalPeers: Map<string, Set<string>>;
  snapshots: Map<string, Dependency[]>;
}

function parse(source: string): ParsedLockfile {
  const roots: string[] = [];
  const optionalPeers = new Map<string, Set<string>>();
  const snapshots = new Map<string, Dependency[]>();
  let section = "";
  let key = "";
  let group = "";
  let entry = "";

  for (const line of source.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      continue;
    }
    const keyMatch = /^ {2}(\S.*?):(?: \{\})?$/.exec(line);
    if (keyMatch) {
      key = unquote(keyMatch[1]!);
      group = entry = "";
      if (section === "snapshots") snapshots.set(key, snapshots.get(key) ?? []);
      continue;
    }
    const groupMatch = /^ {4}(\S+):$/.exec(line);
    if (groupMatch) {
      group = groupMatch[1]!;
      entry = "";
      continue;
    }
    const entryMatch = /^ {6}(\S.*?):(?: (.*))?$/.exec(line);
    if (entryMatch) {
      entry = unquote(entryMatch[1]!);
      const value = entryMatch[2] ? unquote(entryMatch[2]) : "";
      if (section === "snapshots" && (group === "dependencies" || group === "optionalDependencies")) {
        snapshots.get(key)!.push({ name: entry, ref: value });
      }
      continue;
    }
    const fieldMatch = /^ {8}(\S+): (.*)$/.exec(line);
    if (!fieldMatch) continue;
    const [, field, value] = fieldMatch;
    if (section === "importers" && field === "version") roots.push(`${entry}@${unquote(value!)}`);
    if (section === "packages" && group === "peerDependenciesMeta" && field === "optional" && value === "true") {
      const peers = optionalPeers.get(key) ?? new Set<string>();
      peers.add(entry);
      optionalPeers.set(key, peers);
    }
  }
  return { roots, optionalPeers, snapshots };
}

/**
 * Finds optional peers that only optional-peer links keep installed: packages that no importer
 * reaches through regular or required dependencies. Returns them as "name@version".
 */
export function findUnneededOptionalPeers(source: string): string[] {
  const { roots, optionalPeers, snapshots } = parse(source);
  const reached = new Set<string>();
  const peerLinks = new Set<string>();
  const queue = roots.filter((key) => snapshots.has(key));

  while (queue.length) {
    const key = queue.pop()!;
    if (reached.has(key)) continue;
    reached.add(key);
    const peers = optionalPeers.get(withoutSuffix(key));
    for (const { name, ref } of snapshots.get(key) ?? []) {
      if (peers?.has(name)) {
        peerLinks.add(`${name}@${withoutSuffix(ref)}`);
        continue;
      }
      const target = `${name}@${ref}`;
      if (snapshots.has(target)) queue.push(target);
    }
  }

  const reachedPackages = new Set([...reached].map(withoutSuffix));
  return [...peerLinks].filter((peer) => !reachedPackages.has(peer)).sort();
}

/** Removes every "(peer)" or "(peer(...))" segment from lockfile keys and versions. */
function removeSuffixSegments(text: string, peer: string) {
  const marker = `(${peer}`;
  let result = "";
  let index = 0;
  for (let found = text.indexOf(marker); found !== -1; found = text.indexOf(marker, index)) {
    const next = text[found + marker.length];
    if (next !== ")" && next !== "(") {
      // A different package whose name merely starts with this one.
      result += text.slice(index, found + marker.length);
      index = found + marker.length;
      continue;
    }
    let depth = 0;
    let end = found;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    result += text.slice(index, found);
    index = end + 1;
  }
  return result + text.slice(index);
}

/**
 * Drops optional-peer links to packages nothing else installs (see findUnneededOptionalPeers),
 * so `pnpm install --frozen-lockfile` no longer installs them. Snapshot entries that become
 * identical are merged.
 */
export function pruneOptionalPeers(source: string): string {
  const peers = findUnneededOptionalPeers(source);
  if (!peers.length) return source;

  let text = source;
  for (const peer of peers) text = removeSuffixSegments(text, peer);

  const output: string[] = [];
  const seenKeys = new Set<string>();
  let section = "";
  let skippingEntry = false;
  let pendingGroup: string | null = null;

  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      skippingEntry = false;
      pendingGroup = null;
      output.push(line);
      continue;
    }
    if (section !== "snapshots") {
      output.push(line);
      continue;
    }
    const keyMatch = /^ {2}(\S.*?):(?: \{\})?$/.exec(line);
    if (keyMatch) {
      pendingGroup = null;
      // Removing a link can make two snapshot keys identical; keep the first entry.
      skippingEntry = seenKeys.has(keyMatch[1]!);
      seenKeys.add(keyMatch[1]!);
      if (!skippingEntry) output.push(line);
      continue;
    }
    if (skippingEntry) continue;
    if (/^ {4}\S+:$/.test(line)) {
      // Held until the group gets an entry, so a group whose only entry was removed disappears.
      pendingGroup = line;
      continue;
    }
    const dependency = /^ {6}(\S.*?): (.*)$/.exec(line);
    if (dependency && peers.includes(`${unquote(dependency[1]!)}@${withoutSuffix(unquote(dependency[2]!))}`)) {
      continue;
    }
    if (pendingGroup !== null && line.trim() !== "") {
      output.push(pendingGroup);
      pendingGroup = null;
    }
    output.push(line);
  }
  return output.join("\n");
}
