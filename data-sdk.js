// Stockage local de l'application Échéance (remplace le stockage Canva).
//
// Pour que l'historique ne soit jamais perdu :
//  1. Chaque écriture va dans le localStorage (copie principale) ET dans une copie de secours.
//  2. Chaque écriture est aussi dupliquée dans IndexedDB (second stockage du navigateur).
//  3. Au démarrage, si la copie principale est illisible, on récupère la copie de secours
//     puis IndexedDB. Une lecture ratée n'écrase JAMAIS les données.
//  4. On demande au navigateur de rendre le stockage « persistant » (non effaçable en cas de manque de place).
//  5. Export / import JSON disponibles depuis les Paramètres.
(() => {
  "use strict";

  const KEY = "echeance-data-v1";           // copie principale (même clé qu'avant : rien n'est perdu)
  const BACKUP_KEY = "echeance-data-backup-v1";
  const SAVED_AT_KEY = "echeance-saved-at-v1";
  const DB_NAME = "echeance-db", STORE = "kv", IDB_KEY = "records";

  let handler = null;
  let cache = [];
  let ready = false;
  let statusListener = null;
  let persisted = null;

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = (list) => list.map((r) => ({ ...r }));
  const status = (info) => { try { statusListener && statusListener(info); } catch {} };

  function parseList(text) {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }
  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }

  // ---- IndexedDB (copie miroir) ----
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB indisponible"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  // IndexedDB conserve { savedAt, list } pour pouvoir comparer avec le localStorage.
  async function idbRead() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(IDB_KEY);
      req.onsuccess = () => {
        const v = req.result;
        resolve(v && Array.isArray(v.list) ? { savedAt: String(v.savedAt || ""), list: v.list } : null);
      };
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  }
  async function idbWrite(list, savedAt) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ savedAt, list }, IDB_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }).finally(() => db.close());
  }

  // ---- Lecture au démarrage ----
  async function loadInitial() {
    const main = parseList(lsGet(KEY));
    const mainAt = lsGet(SAVED_AT_KEY) || "";
    const backup = parseList(lsGet(BACKUP_KEY));
    let idb = null;
    try { idb = await idbRead(); } catch {}

    // 1. Copie principale lisible : c'est la référence (sauf si IndexedDB est plus récent).
    if (main) {
      if (idb && idb.savedAt > mainAt) return { list: idb.list, recovered: true };
      return { list: main, recovered: false };
    }
    // 2. Copie principale absente ou illisible : IndexedDB (à jour), sinon la copie de secours.
    if (idb) return { list: idb.list, recovered: true };
    if (backup) return { list: backup, recovered: true };
    return { list: [], recovered: false };
  }

  // ---- Écriture ----
  async function persist(list) {
    const json = JSON.stringify(list);
    const savedAt = new Date().toISOString();
    const previous = lsGet(KEY);
    if (previous && parseList(previous)) lsSet(BACKUP_KEY, previous);  // la version d'avant devient la copie de secours
    const okLocal = lsSet(KEY, json);
    if (okLocal) lsSet(SAVED_AT_KEY, savedAt);
    let okIdb = false;
    try { okIdb = await idbWrite(list, savedAt); } catch {}
    if (!okLocal && !okIdb) return false;
    status({ savedAt, local: okLocal, idb: okIdb, persisted });
    return true;
  }

  const emit = () => { if (handler && ready) handler(clone(cache)); };

  async function commit(next) {
    const previous = cache;
    cache = next;
    const ok = await persist(next);
    if (!ok) { cache = previous; return { isOk: false }; }
    emit();
    return { isOk: true };
  }

  // Mise à jour quand un autre onglet modifie les données.
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !ready) return;
    const list = parseList(e.newValue);
    if (list) { cache = list; emit(); }
  });

  window.dataSdk = {
    async init(options) {
      handler = options.onDataChanged;
      try {
        const { list, recovered } = await loadInitial();
        cache = list;
        ready = true;
        if (recovered && list.length) {
          // On réécrit tout de suite la copie principale réparée.
          await persist(cache);
        }
      } catch {
        return { isOk: false };
      }
      // Demande de stockage persistant (évite l'effacement automatique par le navigateur).
      try {
        if (navigator.storage && navigator.storage.persist) {
          persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
        }
      } catch {}
      emit();
      status({ savedAt: lsGet(SAVED_AT_KEY), local: true, idb: true, persisted });
      return { isOk: true };
    },
    async create(record) {
      return commit([...cache, { ...record, __backendId: newId() }]);
    },
    async update(record) {
      const i = cache.findIndex((r) => String(r.__backendId) === String(record.__backendId));
      if (i === -1) return { isOk: false };
      const next = cache.slice();
      next[i] = { ...record };
      return commit(next);
    },
    async delete(record) {
      const next = cache.filter((r) => String(r.__backendId) !== String(record.__backendId));
      if (next.length === cache.length) return { isOk: false };
      return commit(next);
    },

    // ---- Outils de sauvegarde ----
    getAll() { return clone(cache); },
    // Remplace tout (import « remplacer »)
    async replaceAll(records) {
      const list = records.map((r) => ({ ...r, __backendId: r.__backendId || newId() }));
      return commit(list);
    },
    // Ajoute sans doublons (import « fusionner »). Retourne le nombre d'éléments ajoutés.
    async mergeAll(records) {
      const known = new Set(cache.map((r) => String(r.__backendId)));
      const added = records.filter((r) => !r.__backendId || !known.has(String(r.__backendId)))
        .map((r) => ({ ...r, __backendId: r.__backendId || newId() }));
      const result = await commit([...cache, ...added]);
      return { ...result, added: added.length };
    },
    onStatus(fn) { statusListener = fn; },
    info() { return { count: cache.length, persisted, savedAt: lsGet(SAVED_AT_KEY) }; },
  };
})();
