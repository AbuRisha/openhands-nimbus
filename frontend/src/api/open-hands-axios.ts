import axios, { AxiosError, AxiosResponse } from "axios";
import { getStoredEffort } from "#/stores/effort-store";
import { isReasoningEffortSupported } from "#/utils/reasoning-effort-support";

export const openHands = axios.create({
  baseURL: `${window.location.protocol}//${import.meta.env.VITE_BACKEND_BASE_URL || window?.location.host}`,
});

// Helper function to check if a response contains an email verification error
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const checkForEmailVerificationError = (data: any): boolean => {
  const EMAIL_NOT_VERIFIED = "EmailNotVerifiedError";

  if (typeof data === "string") {
    return data.includes(EMAIL_NOT_VERIFIED);
  }

  if (typeof data === "object" && data !== null) {
    if ("message" in data) {
      const { message } = data;
      if (typeof message === "string") {
        return message.includes(EMAIL_NOT_VERIFIED);
      }
      if (Array.isArray(message)) {
        return message.some(
          (msg) => typeof msg === "string" && msg.includes(EMAIL_NOT_VERIFIED),
        );
      }
    }

    // Search any values in object in case message key is different
    return Object.values(data).some(
      (value) =>
        (typeof value === "string" && value.includes(EMAIL_NOT_VERIFIED)) ||
        (Array.isArray(value) &&
          value.some(
            (v) => typeof v === "string" && v.includes(EMAIL_NOT_VERIFIED),
          )),
    );
  }

  return false;
};

// Set up the global response interceptor
openHands.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    // Check if it's a 403 error with the email verification message
    if (
      error.response?.status === 403 &&
      checkForEmailVerificationError(error.response?.data)
    ) {
      if (window.location.pathname !== "/settings/user") {
        window.location.reload();
      }
    }

    // Continue with the error for other error handlers
    return Promise.reject(error);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Nimbus reasoning-effort request interceptor
//
// Every /chat/completions request picks up the current effort selection from
// the EffortSlider store and rides it into the outbound payload:
//
//   • X-Nimbus-Reasoning-Effort header is set on every /chat/completions call
//     so the backend can log / route / meter based on the tier.
//   • body.reasoning_effort is injected when the body has a JSON shape AND
//     the target model is known to accept the parameter (per the substring
//     whitelist in reasoning-effort-support.ts).
//   • For models that don't support reasoning_effort the field is silently
//     removed so an inherited value from a previous request never lands on
//     a non-reasoning model.
//
// The interceptor is defensive — any thrown error is swallowed so it can
// never break the outgoing request.
// ─────────────────────────────────────────────────────────────────────────────
openHands.interceptors.request.use((config) => {
  try {
    const url = (config.url ?? "").toString();
    if (!url.includes("/chat/completions")) return config;

    const effort = getStoredEffort();

    // Always advertise via header — backend can decide independently.
    // AxiosHeaders / plain-object headers both accept bracket-set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers = (config.headers ?? {}) as any;
    if (typeof headers.set === "function") {
      headers.set("X-Nimbus-Reasoning-Effort", effort);
    } else {
      headers["X-Nimbus-Reasoning-Effort"] = effort;
    }
    config.headers = headers;

    // If the body is a plain JSON payload, inject or strip reasoning_effort.
    if (config.data && typeof config.data === "object" && !Array.isArray(config.data)) {
      const body = config.data as Record<string, unknown>;
      const model = typeof body.model === "string" ? body.model : null;
      if (isReasoningEffortSupported(model)) {
        body.reasoning_effort = effort;
      } else if ("reasoning_effort" in body) {
        delete body.reasoning_effort;
      }
    }
  } catch {
    // Never break an outbound request over an effort-injection failure.
  }
  return config;
});
