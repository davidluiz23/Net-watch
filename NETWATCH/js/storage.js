/**
 * IndexedDB persistent telemetry storage for NETWATCH.
 * Stores latency samples, speed test runs, incidents, and alerts.
 */

const DB_NAME = 'netwatch_db';
const DB_VERSION = 1;

const STORES = {
  SAMPLES: 'latency_samples',
  SPEEDS: 'speed_tests',
  INCIDENTS: 'incidents',
  ALERTS: 'alerts'
};

class StorageService {
  constructor() {
    this.db = null;
    this.available = typeof indexedDB !== 'undefined';
  }

  async init() {
    if (!this.available) return false;
    if (this.db) return true;

    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORES.SAMPLES)) {
          const store = db.createObjectStore(STORES.SAMPLES, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.SPEEDS)) {
          const store = db.createObjectStore(STORES.SPEEDS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.INCIDENTS)) {
          const store = db.createObjectStore(STORES.INCIDENTS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.ALERTS)) {
          const store = db.createObjectStore(STORES.ALERTS, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(true);
      };

      request.onerror = () => {
        this.available = false;
        resolve(false);
      };
    });
  }

  async addRecord(storeName, record) {
    if (!this.db) return null;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).add(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async getSince(storeName, minTimestamp) {
    if (!this.db) return [];
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(storeName, 'readonly');
        const index = tx.objectStore(storeName).index('timestamp');
        const range = IDBKeyRange.lowerBound(minTimestamp);
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async getAll(storeName, limit = 500) {
    if (!this.db) return [];
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => {
          const res = req.result || [];
          resolve(res.slice(-limit));
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async clearStore(storeName) {
    if (!this.db) return;
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async purgeAll() {
    await Promise.all(Object.values(STORES).map((s) => this.clearStore(s)));
  }

  async getCounts() {
    if (!this.db) return {};
    const counts = {};
    for (const [key, store] of Object.entries(STORES)) {
      counts[key] = await new Promise((resolve) => {
        try {
          const tx = this.db.transaction(store, 'readonly');
          const req = tx.objectStore(store).count();
          req.onsuccess = () => resolve(req.result || 0);
          req.onerror = () => resolve(0);
        } catch {
          resolve(0);
        }
      });
    }
    return counts;
  }
}

export const storage = new StorageService();
export { STORES };
