/**
 * IndexedDB layer for Nimbus Projects.
 *
 * Two object stores:
 *   - "projects":       JSON-serializable Project metadata, keyed by id.
 *   - "folderHandles":  raw FileSystemDirectoryHandle objects, keyed by
 *                       folderHandleKey. Handles can be stored directly in
 *                       IndexedDB via structured clone in Chromium — they
 *                       cannot be sent to the server, which is exactly why
 *                       Project.folderHandle lives here and not on the API.
 *
 * Conversation-to-project mapping is stored inside Project.chats, so a chat
 * belongs to at most one project. Server-side conversation records stay
 * untouched — this is a purely additive, client-owned index.
 */

import { Project } from "#/types/project";

const DB_NAME = "nimbus-projects";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_HANDLES = "folderHandles";

/** SSR-safe check — IndexedDB is only available in the browser. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isBrowser()) {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result: T | undefined;
        const maybeReq = work(store);
        if (maybeReq instanceof IDBRequest) {
          maybeReq.onsuccess = () => {
            result = maybeReq.result as T;
          };
          maybeReq.onerror = () => reject(maybeReq.error);
        } else {
          maybeReq.then((v) => {
            result = v;
          }, reject);
        }
        tx.oncomplete = () => resolve(result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function listProjects(): Promise<Project[]> {
  if (!isBrowser()) return [];
  return withStore<Project[]>(STORE_PROJECTS, "readonly", (store) =>
    store.getAll(),
  );
}

export async function getProject(id: string): Promise<Project | undefined> {
  if (!isBrowser()) return undefined;
  return withStore<Project | undefined>(STORE_PROJECTS, "readonly", (store) =>
    store.get(id),
  );
}

export async function putProject(project: Project): Promise<void> {
  await withStore<IDBValidKey>(STORE_PROJECTS, "readwrite", (store) =>
    store.put(project),
  );
}

export async function deleteProject(id: string): Promise<void> {
  const project = await getProject(id);
  if (project?.folderHandleKey) {
    await deleteFolderHandle(project.folderHandleKey);
  }
  await withStore<undefined>(STORE_PROJECTS, "readwrite", (store) =>
    store.delete(id),
  );
}

export async function putFolderHandle(
  key: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await withStore<IDBValidKey>(STORE_HANDLES, "readwrite", (store) =>
    store.put(handle, key),
  );
}

export async function getFolderHandle(
  key: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  if (!isBrowser()) return undefined;
  return withStore<FileSystemDirectoryHandle | undefined>(
    STORE_HANDLES,
    "readonly",
    (store) => store.get(key),
  );
}

export async function deleteFolderHandle(key: string): Promise<void> {
  await withStore<undefined>(STORE_HANDLES, "readwrite", (store) =>
    store.delete(key),
  );
}

/**
 * Attach a conversation id to a project. Idempotent.
 * The reverse index (conversationId -> projectId) is derived by scanning
 * projects on read — the collection is small (dozens at most) and this keeps
 * the write path simple.
 */
export async function attachConversation(
  projectId: string,
  conversationId: string,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  if (project.chats.includes(conversationId)) return;
  project.chats = [...project.chats, conversationId];
  await putProject(project);
}

export async function findProjectForConversation(
  conversationId: string,
): Promise<Project | undefined> {
  const all = await listProjects();
  return all.find((p) => p.chats.includes(conversationId));
}
