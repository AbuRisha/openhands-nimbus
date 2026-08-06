/**
 * Nimbus Bridge — the browser half.
 *
 * Holds one WebSocket to the relay, answers tool calls from a paired
 * conversation, and does nothing at all until the user has entered a pairing
 * code. There is no auto-connect and no discovery: an extension that attaches
 * itself to whatever account it can see is the failure this design exists to
 * avoid.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not read pages on its own, does not run on page load, and holds no
 * credential beyond the device token the relay issued at pairing. Every action
 * happens because a call arrived over the socket for THIS device id.
 */

const RELAY_PATH = "/bridge/device";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

async function getConfig() {
  const { relayOrigin, deviceId, deviceToken, deviceName } =
    await chrome.storage.local.get([
      "relayOrigin",
      "deviceId",
      "deviceToken",
      "deviceName",
    ]);
  return { relayOrigin, deviceId, deviceToken, deviceName };
}

/**
 * Backoff, because a relay that is down should not be hammered by every
 * browser that has ever paired with it. Jittered so a restart does not bring
 * them all back in the same second.
 */
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const capped = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    RECONNECT_MAX_MS,
  );
  const jittered = capped * (0.5 + Math.random() * 0.5);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(connect, jittered);
}

async function connect() {
  const { relayOrigin, deviceId, deviceToken } = await getConfig();
  // Unpaired is the resting state, not an error worth retrying.
  if (!relayOrigin || !deviceId || !deviceToken) return;

  const url = new URL(RELAY_PATH, relayOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    // The token goes in the first application message rather than the URL: a
    // query string lands in proxy and server logs, and this one is long-lived.
    socket.send(
      JSON.stringify({ type: "hello", device_id: deviceId, token: deviceToken }),
    );
  });

  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message.request_id !== "string") return;

    try {
      const result = await handleCall(message);
      send({ type: "result", request_id: message.request_id, result });
    } catch (error) {
      // Answer even on failure. A silent drop makes the agent wait out its
      // whole timeout for something already known to have failed.
      send({
        type: "result",
        request_id: message.request_id,
        result: { error: String(error && error.message ? error.message : error) },
      });
    }
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket && socket.close());
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/** The active tab, or an error the agent can act on rather than a null. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab in this browser");
  return tab;
}

async function handleCall(message) {
  switch (message.tool) {
    case "get_page_text": {
      const tab = await activeTab();
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText.slice(0, 100000),
      });
      return { url: tab.url, title: tab.title, text: result };
    }

    case "get_page_url": {
      const tab = await activeTab();
      return { url: tab.url, title: tab.title };
    }

    case "navigate": {
      if (typeof message.url !== "string") throw new Error("navigate needs a url");
      // http(s) only. A tool call that can open file:// or javascript: URLs is
      // a way to read the local disk or run script in a privileged context.
      const target = new URL(message.url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error(`refusing to navigate to ${target.protocol}`);
      }
      const tab = await activeTab();
      await chrome.tabs.update(tab.id, { url: target.href });
      return { url: target.href };
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
      };
    }

    default:
      throw new Error(`unsupported tool: ${message.tool}`);
  }
}

// Reconnect when the browser or the service worker restarts. Pairing state
// lives in storage, so this resumes without asking the user again.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.deviceToken) connect();
});

connect();
