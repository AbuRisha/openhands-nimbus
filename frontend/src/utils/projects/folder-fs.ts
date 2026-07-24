/**
 * Thin async helpers over a FileSystemDirectoryHandle so higher-level code
 * (the MCP fs bridge, the workspace chip preview, drag-drop targets) doesn't
 * have to re-implement path-splitting and permission checks.
 *
 * All operations resolve paths relative to the root handle; a leading "/" is
 * tolerated. Absolute paths outside the folder are rejected — a bound
 * workspace never escapes its root, even if the model asks for one.
 */

export interface FsListEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

function normalize(path: string): string[] {
  const cleaned = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned === "") return [];
  const parts = cleaned.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") {
      throw new Error(`Illegal path segment: ${p}`);
    }
  }
  return parts;
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  parts: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

export async function listDirectory(
  root: FileSystemDirectoryHandle,
  path = "",
): Promise<FsListEntry[]> {
  const parts = normalize(path);
  const dir = await resolveDir(root, parts, false);
  const entries: FsListEntry[] = [];
  // FileSystemDirectoryHandle is async-iterable via .entries() in Chromium.
  const iter = (
    dir as unknown as {
      entries: () => AsyncIterableIterator<
        [string, FileSystemHandle & { kind: "file" | "directory" }]
      >;
    }
  ).entries();
  // eslint-disable-next-line no-restricted-syntax
  for await (const [name, handle] of iter) {
    entries.push({
      name,
      path: [...parts, name].join("/"),
      kind: handle.kind,
    });
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const parts = normalize(path);
  if (parts.length === 0) throw new Error("Cannot read root as file");
  const fileName = parts.pop() as string;
  const dir = await resolveDir(root, parts, false);
  const fileHandle = await dir.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  return file.text();
}

export async function writeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  contents: string,
): Promise<void> {
  const parts = normalize(path);
  if (parts.length === 0) throw new Error("Cannot write root as file");
  const fileName = parts.pop() as string;
  const dir = await resolveDir(root, parts, true);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await (
    fileHandle as unknown as {
      createWritable: () => Promise<
        WritableStream & { write: (s: string) => Promise<void> }
      >;
    }
  ).createWritable();
  await writable.write(contents);
  await writable.close();
}
