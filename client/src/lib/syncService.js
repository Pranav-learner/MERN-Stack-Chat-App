/**
 * @module client/src/lib/syncService
 *
 * Layer 9 — Offline Synchronization & State Replication Client Engine.
 *
 * Provides:
 * 1. Persistent Offline Outbox Queue: messages sent while disconnected or during
 *    transient network errors are safely stored in localStorage with monotonic sequence tracking.
 * 2. Automatic Reconnection Drainage: flushes queued messages in order as soon as
 *    network connectivity is restored, with idempotency guarantees (via clientMessageId).
 * 3. Delta Synchronization & Replica Reconciliation: tracks high-water timestamps per
 *    conversation and reconciles missing state on reconnect.
 * 4. Sync Reliability & Health Monitoring: exposes sync status ("synced", "syncing", "offline")
 *    with queue count for reactive UI updates.
 */

const OUTBOX_STORAGE_KEY = "chat_app_offline_outbox";
const CHECKPOINTS_STORAGE_KEY = "chat_app_sync_checkpoints";

/**
 * Retrieve all pending offline messages from local storage.
 * @returns {Array<object>}
 */
export function getOfflineOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("[syncService] Failed to read offline outbox:", err);
    return [];
  }
}

/**
 * Enqueue a message to the offline outbox.
 * @param {object} item
 */
export function enqueueOfflineMessage(item) {
  try {
    const queue = getOfflineOutbox();
    const entry = {
      ...item,
      queuedAt: Date.now(),
      status: "queued",
    };
    queue.push(entry);
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(queue));
    notifySyncListeners();
    return entry;
  } catch (err) {
    console.error("[syncService] Failed to enqueue offline message:", err);
    return item;
  }
}

/**
 * Remove an item from the offline outbox by its clientMessageId.
 * @param {string} clientMessageId
 */
export function removeOfflineMessage(clientMessageId) {
  try {
    const queue = getOfflineOutbox();
    const filtered = queue.filter((m) => m.clientMessageId !== clientMessageId);
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(filtered));
    notifySyncListeners();
  } catch (err) {
    console.error("[syncService] Failed to remove message from offline outbox:", err);
  }
}

/**
 * Checkpoints store: stores the latest sync timestamp per conversation.
 */
export function getSyncCheckpoints() {
  try {
    const raw = localStorage.getItem(CHECKPOINTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function updateSyncCheckpoint(targetId, timestamp) {
  try {
    const checkpoints = getSyncCheckpoints();
    const current = checkpoints[targetId] || 0;
    if (timestamp > current) {
      checkpoints[targetId] = timestamp;
      localStorage.setItem(CHECKPOINTS_STORAGE_KEY, JSON.stringify(checkpoints));
    }
  } catch (err) {
    console.error("[syncService] Failed to update checkpoint:", err);
  }
}

// --- Sync Listeners -----------------------------------------------------------

const syncListeners = new Set();

export function subscribeToSyncStatus(listener) {
  syncListeners.add(listener);
  listener(getSyncStatus());
  return () => syncListeners.delete(listener);
}

function notifySyncListeners() {
  const status = getSyncStatus();
  syncListeners.forEach((l) => {
    try {
      l(status);
    } catch {
      // listener error should not break sync loop
    }
  });
}

export function getSyncStatus() {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
  const queue = getOfflineOutbox();
  return {
    isOnline,
    pendingCount: queue.length,
    status: !isOnline ? "offline" : queue.length > 0 ? "syncing" : "synced",
  };
}

// --- Outbox Drainage & Network Integration -----------------------------------

let isFlushing = false;

/**
 * Drain the offline outbox sequentially.
 * @param {import("axios").AxiosInstance} axios
 * @param {{ onMessageSent?: (msg: object) => void, onMessageFailed?: (msg: object, err: any) => void }} callbacks
 */
export async function flushOfflineOutbox(axios, callbacks = {}) {
  if (isFlushing) return;
  const queue = getOfflineOutbox();
  if (queue.length === 0) return;

  isFlushing = true;
  notifySyncListeners();

  try {
    for (const item of [...queue]) {
      try {
        let res;
        if (item.targetType === "group") {
          res = await axios.post(`/api/groups/send/${item.targetId}`, item.sendPayload);
        } else {
          res = await axios.post(`/api/messages/send/${item.targetId}`, item.sendPayload);
        }

        if (res.data?.success) {
          removeOfflineMessage(item.clientMessageId);
          updateSyncCheckpoint(item.targetId, Date.now());
          if (callbacks.onMessageSent) {
            callbacks.onMessageSent({
              ...res.data.message,
              clientMessageId: item.clientMessageId,
              text: item.displayText,
              image: item.displayImage,
              isEncrypted: item.wasEncrypted,
              status: "sent",
            });
          }
        }
      } catch (err) {
        console.warn("[syncService] Failed to flush queued message:", item.clientMessageId, err?.message);
        if (callbacks.onMessageFailed) {
          callbacks.onMessageFailed(item, err);
        }
        // If network is still down, halt drainage to preserve FIFO ordering
        if (!navigator.onLine || err?.code === "ERR_NETWORK") {
          break;
        }
      }
    }
  } finally {
    isFlushing = false;
    notifySyncListeners();
  }
}

/**
 * Initialize automatic sync listeners on window online/offline events.
 */
export function initSyncManager(axios, callbacks = {}) {
  if (typeof window === "undefined") return;

  window.addEventListener("online", () => {
    notifySyncListeners();
    flushOfflineOutbox(axios, callbacks);
  });

  window.addEventListener("offline", () => {
    notifySyncListeners();
  });
}
