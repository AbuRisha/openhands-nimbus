/**
 * File System Access API — feature detection + directory-picker wrapper.
 *
 * `window.showDirectoryPicker()` ships in Chromium-based browsers as of 2022;
 * Safari and Firefox still lack it. We feature-detect and return a discriminated
 * result so the caller can render a graceful fallback ("upgrade browser" or
 * "use git URL / web-only mode") instead of throwing.
 *
 * We also expose `verifyReadWritePermission` — a re-open after a browser
 * restart needs the user to re-grant permission on the persisted handle before
 * we can read/write. Best invoked lazily when the user actually opens a
 * project, not on every session boot.
 */

export type FolderPickResult =
  | { ok: true; handle: FileSystemDirectoryHandle }
  | { ok: false; reason: "unsupported" | "cancelled" | "error"; error?: Error };

export function isFsAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function"
  );
}

export async function pickDirectory(): Promise<FolderPickResult> {
  if (!isFsAccessSupported()) {
    return { ok: false, reason: "unsupported" };
  }
  try {
    // `mode: "readwrite"` requests write permission up front so we can save
    // agent edits back to disk without a second prompt later.
    const handle = await (
      window as unknown as {
        showDirectoryPicker: (opts?: {
          mode?: "read" | "readwrite";
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode: "readwrite" });
    return { ok: true, handle };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, reason: "cancelled" };
    }
    return {
      ok: false,
      reason: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export async function verifyReadWritePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const anyHandle = handle as unknown as {
    queryPermission?: (opts: {
      mode: "read" | "readwrite";
    }) => Promise<PermissionState>;
    requestPermission?: (opts: {
      mode: "read" | "readwrite";
    }) => Promise<PermissionState>;
  };
  if (!anyHandle.queryPermission) return true; // pre-2022 API missing, assume ok
  const opts = { mode: "readwrite" as const };
  const current = await anyHandle.queryPermission(opts);
  if (current === "granted") return true;
  if (!anyHandle.requestPermission) return false;
  const next = await anyHandle.requestPermission(opts);
  return next === "granted";
}
