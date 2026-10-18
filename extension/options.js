const originInput = document.getElementById("origin");
const authOriginInput = document.getElementById("auth-origin");
const optOutInput = document.getElementById("optout");
const userLine = document.getElementById("user");
const saved = document.getElementById("saved");

chrome.storage.local.get(["simmerOrigin", "simmerAuthOrigin", "simmerOptOut", "simmerUserId"], (items) => {
  if (typeof items.simmerOrigin === "string" && items.simmerOrigin) {
    originInput.value = items.simmerOrigin;
  }
  if (typeof items.simmerAuthOrigin === "string") {
    authOriginInput.value = items.simmerAuthOrigin;
  }
  if (Array.isArray(items.simmerOptOut)) {
    optOutInput.value = items.simmerOptOut.join("\n");
  }
  userLine.textContent = typeof items.simmerUserId === "string" ? `Text once: link ${items.simmerUserId}` : "Open an Apple bag once to mint your link id.";
});

document.getElementById("save").addEventListener("click", () => {
  const optOut = optOutInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  chrome.storage.local.set(
    {
      simmerOrigin: originInput.value.trim(),
      simmerAuthOrigin: authOriginInput.value.trim(),
      simmerOptOut: optOut,
    },
    () => {
      saved.hidden = false;
    },
  );
});
