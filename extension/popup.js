/**
 * Pairing, from the browser's side.
 *
 * The user reads a code in their Nimbus conversation and types it here. That
 * direction matters: a browser that could pair itself by answering a broadcast
 * is one a hostile extension on the same account could impersonate.
 */

const RELAY_ORIGIN = "https://chat.nimbusapi.net";

const codeInput = document.getElementById("code");
const pairButton = document.getElementById("pair");
const status = document.getElementById("status");
const intro = document.getElementById("intro");

function setStatus(text, kind) {
  status.textContent = text;
  status.className = `status ${kind || ""}`;
}

/** A device id this browser keeps, so a reconnect is not a re-pair. */
async function deviceId() {
  const stored = await chrome.storage.local.get("deviceId");
  if (stored.deviceId) return stored.deviceId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

async function showExistingPairing() {
  const { deviceToken } = await chrome.storage.local.get("deviceToken");
  if (deviceToken) {
    intro.textContent =
      "This browser is paired. Entering a new code re-pairs it.";
  }
}

pairButton.addEventListener("click", async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 8) {
    setStatus("A pairing code is 8 characters.", "err");
    return;
  }

  pairButton.disabled = true;
  setStatus("Pairing…");

  try {
    const response = await fetch(`${RELAY_ORIGIN}/bridge/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        device_id: await deviceId(),
        device_name: "Chrome",
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // The relay's reasons are deliberately specific — expired and wrong are
      // different problems and the user can act on the difference.
      const reasons = {
        unknown_code: "That code was not recognised.",
        expired: "That code has expired. Generate a new one.",
        already_used: "That code has already been used.",
        too_many_attempts: "Too many attempts. Generate a new code.",
      };
      setStatus(reasons[body.reason] || "Pairing failed.", "err");
      return;
    }

    const { token } = await response.json();
    await chrome.storage.local.set({
      deviceToken: token,
      relayOrigin: RELAY_ORIGIN,
      deviceName: "Chrome",
    });
    setStatus("Paired. This browser is now connected.", "ok");
    codeInput.value = "";
  } catch (error) {
    setStatus(`Could not reach Nimbus: ${error.message}`, "err");
  } finally {
    pairButton.disabled = false;
  }
});

showExistingPairing();
