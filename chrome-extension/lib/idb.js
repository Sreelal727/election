/**
 * Lightweight IndexedDB Promise Wrapper
 * No dependencies. Provides async/await interface for IndexedDB operations.
 *
 * Kerala 2026 Election Sentiment Chrome Extension
 */

'use strict';

/**
 * Open (or create/upgrade) an IndexedDB database.
 * @param {string} name - Database name
 * @param {number} version - Schema version
 * @param {function} upgradeCallback - Called with (db, oldVersion, newVersion) during onupgradeneeded
 * @returns {Promise<IDBDatabase>}
 */
function openDB(name, version, upgradeCallback) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (typeof upgradeCallback === 'function') {
        upgradeCallback(db, event.oldVersion, event.newVersion);
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(new Error(`IndexedDB open failed: ${event.target.error?.message || 'Unknown error'}`));
    };

    request.onblocked = () => {
      reject(new Error('IndexedDB open blocked — close other tabs using this database'));
    };
  });
}

/**
 * Get a transaction and object store from an open database.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBTransactionMode} mode - 'readonly' or 'readwrite'
 * @returns {{ tx: IDBTransaction, store: IDBObjectStore }}
 */
function getStore(db, storeName, mode) {
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  return { tx, store };
}

/**
 * Put (insert or update) a record in an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {*} data - The record to store
 * @returns {Promise<IDBValidKey>} The key of the stored record
 */
function put(db, storeName, data) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readwrite');
    const request = store.put(data);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`put failed on ${storeName}: ${request.error?.message}`));
  });
}

/**
 * Get a single record by key.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<*>} The record, or undefined if not found
 */
function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readonly');
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`get failed on ${storeName}: ${request.error?.message}`));
  });
}

/**
 * Get all records from an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<Array>}
 */
function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readonly');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(new Error(`getAll failed on ${storeName}: ${request.error?.message}`));
  });
}

/**
 * Delete a record by key.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
function deleteRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readwrite');
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`delete failed on ${storeName}: ${request.error?.message}`));
  });
}

/**
 * Clear all records from an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<void>}
 */
function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readwrite');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(`clear failed on ${storeName}: ${request.error?.message}`));
  });
}

/**
 * Count records in an object store.
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<number>}
 */
function countRecords(db, storeName) {
  return new Promise((resolve, reject) => {
    const { store } = getStore(db, storeName, 'readonly');
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`count failed on ${storeName}: ${request.error?.message}`));
  });
}
