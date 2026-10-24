// IndexedDB storage for browser-only mode (no server plugin).

const DB_NAME = 'ST_BgReply';
const STORE = 'jobs';
let dbPromise = null;

function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then(r => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

export async function storeAll() {
    try {
        return await tx('readonly', store => new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        }));
    } catch (error) {
        console.warn('[BgReply] IndexedDB read failed', error);
        return [];
    }
}

export async function storePut(record) {
    try {
        await tx('readwrite', store => { store.put(record); });
    } catch (error) {
        console.warn('[BgReply] IndexedDB write failed', error);
    }
}

export async function storeDelete(id) {
    try {
        await tx('readwrite', store => { store.delete(id); });
    } catch (error) {
        console.warn('[BgReply] IndexedDB delete failed', error);
    }
}
