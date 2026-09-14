export const UPLOAD_URL = "https://lyvisiuknkumqrxihqnb.supabase.co/functions/v1/mobile-intake/upload";

export function readAndClearCapability(locationValue, historyValue) {
  const token = new URLSearchParams(locationValue.hash.slice(1)).get("token") || "";
  historyValue.replaceState(null, "", locationValue.pathname);
  return token;
}

export async function submitCapture(form, token, fetcher = fetch) {
  const body = new FormData(form);
  body.set("token", token);
  return fetcher(UPLOAD_URL, { method: "POST", body, referrerPolicy: "no-referrer" });
}

function initialize() {
  const form = document.querySelector("#capture-form");
  const status = document.querySelector("#status");
  const button = form.querySelector("button");
  const token = readAndClearCapability(window.location, window.history);

  if (!token) {
    status.textContent = "This link is incomplete. Request a new pairing link.";
    button.disabled = true;
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Uploading… Keep this page open.";
    try {
      const response = await submitCapture(form, token);
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
