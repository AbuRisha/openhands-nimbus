import React from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { cn } from "#/utils/utils";

/**
 * Read an agent reply aloud.
 *
 * Two tiers, tried in order:
 *   1. POST /api/nimbus/voice/speak — Nimbus' own gpt-4o-mini-tts deployment.
 *      Natural voice. Not sold, not billed; the platform absorbs it.
 *   2. The browser's speechSynthesis. Robotic but free, offline-capable and
 *      always present. Used when the server 501s (internal AI unconfigured),
 *      errors, or the reply exceeds the server's input cap.
 *
 * The distinction is deliberately invisible — either way the reply is read
 * aloud, and a voice-quality difference is not an error state.
 */

/** Mirrors MAX_TTS_CHARS in openhands/app_server/nimbus_voice/internal_ai.py. */
const SERVER_MAX_CHARS = 1800;

/** Strip markdown down to something worth listening to. */
export function speakableText(markdown: string): string {
  let s = markdown;
  // Code blocks become a placeholder. Nobody wants JSON read character by
  // character, and a diff read aloud is pure noise.
  s = s.replace(/```[\s\S]*?```/g, " Code omitted. ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1");
  // Tables read terribly; drop the pipes so rows become sentences.
  s = s.replace(/\|/g, ", ");
  return s.replace(/\s+/g, " ").trim();
}

type Phase = "idle" | "loading" | "playing";

interface ReadAloudButtonProps {
  text: string;
  isHidden?: boolean;
}

export function ReadAloudButton({ text, isHidden }: ReadAloudButtonProps) {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    setPhase("idle");
  }, []);

  // Never leave audio playing after the message unmounts.
  React.useEffect(() => stop, [stop]);

  const speakLocally = React.useCallback((spoken: string): boolean => {
    if (typeof speechSynthesis === "undefined") return false;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.onend = () => setPhase("idle");
    utterance.onerror = () => setPhase("idle");
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
    setPhase("playing");
    return true;
  }, []);

  const start = React.useCallback(async () => {
    const spoken = speakableText(text);
    if (!spoken) return;

    // Over the server cap: go straight to the browser voice rather than
    // truncating the reply mid-sentence.
    if (spoken.length > SERVER_MAX_CHARS) {
      speakLocally(spoken);
      return;
    }

    setPhase("loading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/nimbus/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: spoken }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (!speakLocally(spoken)) setPhase("idle");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = stop;
      audio.onerror = () => {
        if (!speakLocally(spoken)) stop();
      };
      await audio.play();
      setPhase("playing");
    } catch {
      if (controller.signal.aborted) return; // user pressed stop mid-load
      if (!speakLocally(spoken)) setPhase("idle");
    }
  }, [text, speakLocally, stop]);

  const busy = phase !== "idle";

  let icon = <Volume2 size={14} />;
  if (phase === "loading")
    icon = <Loader2 size={14} className="animate-spin" />;
  else if (phase === "playing") icon = <Square size={14} />;

  return (
    <button
      type="button"
      onClick={busy ? stop : start}
      aria-label={busy ? "Stop reading" : "Read aloud"}
      title={busy ? "Stop reading" : "Read aloud"}
      className={cn(
        "button-base p-1 cursor-pointer",
        // Stays visible while speaking even when the pointer leaves, or there
        // would be no way to stop it.
        isHidden && !busy && "invisible",
      )}
    >
      {icon}
    </button>
  );
}
