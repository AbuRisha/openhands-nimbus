import React from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { useConversationStore } from "#/stores/conversation-store";
import { cn } from "#/utils/utils";

/**
 * Dictate into the composer.
 *
 * Two transcription tiers, tried in order:
 *   1. POST /api/nimbus/voice/transcribe — Nimbus' own gpt-4o-mini-transcribe
 *      deployment. Not sold, not billed; the platform absorbs it.
 *   2. The browser's own SpeechRecognition, captured live while recording and
 *      used whenever the server cannot answer (501 unconfigured, 502 failed,
 *      offline). Less accurate, free, and always present in Chrome/Edge/Safari.
 *
 * The difference is deliberately invisible: either way the words land in the
 * composer. A quality difference is not an error state.
 *
 * Firefox has no SpeechRecognition, so there is no local tier there — the
 * server path still works, and if it is unconfigured too the button stays
 * hidden rather than offering a control that cannot do anything.
 */

type SRLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((ev: {
        resultIndex: number;
        results: ArrayLike<
          ArrayLike<{ transcript: string }> & { isFinal: boolean }
        >;
      }) => void)
    | null;
  onerror: ((ev: unknown) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): (new () => SRLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SRLike;
    webkitSpeechRecognition?: new () => SRLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  return candidates.find((c) => {
    try {
      return MediaRecorder.isTypeSupported(c);
    } catch {
      return false;
    }
  });
}

export function VoiceInputButton({ disabled = false }: { disabled?: boolean }) {
  const setMessageToSend = useConversationStore(
    (state) => state.setMessageToSend,
  );
  const messageToSend = useConversationStore((state) => state.messageToSend);

  const [recording, setRecording] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const srRef = React.useRef<SRLike | null>(null);
  const srFinalRef = React.useRef("");
  // Read at insertion time rather than captured at mount, so dictating after
  // typing appends instead of replacing.
  const existingRef = React.useRef("");

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof MediaRecorder !== "undefined";

  const cleanup = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    try {
      srRef.current?.abort();
    } catch {
      /* a recogniser that never started has nothing to abort */
    }
    srRef.current = null;
  }, []);

  React.useEffect(() => cleanup, [cleanup]);

  const insert = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const before = existingRef.current;
      setMessageToSend(
        before ? `${before.replace(/\s+$/, "")} ${trimmed}` : trimmed,
      );
    },
    [setMessageToSend],
  );

  const startRecording = React.useCallback(async () => {
    // messageToSend is {text, timestamp}, not a string — read .text so an
    // existing draft is appended to rather than stringified as [object].
    existingRef.current = messageToSend?.text ?? "";
    srFinalRef.current = "";
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Permission denied or no device. Nothing to report beyond not starting;
      // the browser has already shown its own prompt.
      return;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start();

    // Local recogniser runs alongside, purely so there is something to fall
    // back to. Its interim results are not shown: the composer is the only
    // text surface here, and flickering partials in it would be worse than
    // waiting.
    const Ctor = getSpeechRecognitionCtor();
    if (Ctor) {
      try {
        const rec = new Ctor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = navigator.language || "en-US";
        rec.onresult = (ev) => {
          for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
            const res = ev.results[i];
            const alt = res?.[0];
            if (alt && res.isFinal) srFinalRef.current += alt.transcript;
          }
        };
        rec.onerror = () => {
          /* silent — a failed recogniser just means no local fallback */
        };
        rec.start();
        srRef.current = rec;
      } catch {
        /* non-fatal */
      }
    }

    setRecording(true);
  }, [messageToSend]);

  const stopRecording = React.useCallback(async () => {
    const recorder = recorderRef.current;
    setRecording(false);
    if (!recorder) return;

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    try {
      srRef.current?.stop();
    } catch {
      /* already stopped */
    }

    const local = srFinalRef.current;
    const blob = new Blob(chunksRef.current, {
      type: recorder.mimeType || "audio/webm",
    });
    cleanup();

    if (blob.size === 0) {
      insert(local);
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      const ext = (recorder.mimeType || "").includes("mp4") ? "m4a" : "webm";
      form.append("file", blob, `recording.${ext}`);
      const response = await fetch("/api/nimbus/voice/transcribe", {
        method: "POST",
        body: form,
      });
      if (response.ok) {
        const json = (await response.json()) as { text?: string };
        insert(json.text ?? local);
      } else {
        // 501 unconfigured / 502 failed — the local transcript is a real
        // result and dropping it to show an error would throw away the answer.
        insert(local);
      }
    } catch {
      insert(local);
    } finally {
      setBusy(false);
    }
  }, [cleanup, insert]);

  if (!supported) return null;

  // A lookup rather than nested ternaries: three states, one place to read
  // them, and the lint rule that forbids the nesting is right that the
  // conditional form gets unreadable at three.
  let icon = <Mic size={16} />;
  if (busy) icon = <Loader2 size={16} className="animate-spin" />;
  else if (recording) icon = <Square size={16} />;

  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={recording ? stopRecording : startRecording}
      aria-label={recording ? "Stop dictation" : "Dictate a message"}
      title={recording ? "Stop dictation" : "Dictate a message"}
      className={cn(
        "cursor-pointer transition-colors",
        recording ? "text-[#FF8A3D]" : "text-[#9099AC] hover:text-white",
        (disabled || busy) && "cursor-not-allowed opacity-50",
      )}
    >
      {icon}
    </button>
  );
}
