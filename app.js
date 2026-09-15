export const UPLOAD_URL = "https://lyvisiuknkumqrxihqnb.supabase.co/functions/v1/mobile-intake/upload";

export function readAndClearCapability(locationValue, historyValue) {
  const token = new URLSearchParams(locationValue.hash.slice(1)).get("token") || "";
  historyValue.replaceState(null, "", locationValue.pathname);
  return token;
}

export function selectImage(selections, side, source, file) {
  if (!file) return false;
  selections[side] = { file, source };
  return true;
}

export function buildUploadBody(selections, token) {
  if (!selections.front?.file || !selections.back?.file) {
    throw new Error("Front and back photos are required.");
  }
  const body = new FormData();
  body.set("front", selections.front.file);
  body.set("back", selections.back.file);
  body.set("token", token);
  return body;
}

export async function submitCapture(selections, token, fetcher = fetch) {
  const body = buildUploadBody(selections, token);
  return fetcher(UPLOAD_URL, { method: "POST", body, referrerPolicy: "no-referrer" });
}

function initialize() {
  const form = document.querySelector("#capture-form");
  const status = document.querySelector("#status");
  const button = form.querySelector("button");
  const token = readAndClearCapability(window.location, window.history);
  const selections = {};

  if (!token) {
    status.textContent = "This link is incomplete. Request a new pairing link.";
    button.disabled = true;
    return;
  }

  for (const input of form.querySelectorAll("[data-image-input]")) {
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!selectImage(selections, input.dataset.side, input.dataset.source, file)) return;
      for (const alternate of form.querySelectorAll(`[data-side="${input.dataset.side}"]`)) {
        if (alternate !== input) alternate.value = "";
      }
      const source = input.dataset.source === "camera" ? "camera" : "photo library";
      form.querySelector(`[data-selection-for="${input.dataset.side}"]`).textContent = `Selected from ${source}.`;
      status.textContent = "";
      button.disabled = !(selections.front && selections.back);
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Uploading… Keep this page open.";
    try {
      const response = await submitCapture(selections, token);
      if (response.ok) {
        status.textContent = "Photos received. You may close this page.";
        return;
      }
      button.disabled = false;
      status.textContent = response.status === 403
        ? "This link expired or was already used. Request a new pairing link."
        : response.status === 413
        ? "One of the images could not be accepted. Retake both photos and try again."
        : "Upload did not finish. Check your connection and try again.";
    } catch {
      button.disabled = false;
      status.textContent = "Upload was interrupted. Check your connection and try again.";
    }
  });
}

if (typeof document !== "undefined") initialize();
