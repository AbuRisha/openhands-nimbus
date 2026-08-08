import React from "react";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";

interface ModalBackdropProps {
  children: React.ReactNode;
  onClose?: () => void;
  "aria-label"?: string;
}

export function ModalBackdrop({
  children,
  onClose,
  "aria-label": ariaLabel,
}: ModalBackdropProps) {
  // The stale-closure hazard that the old dependency comment described is now
  // structural rather than remembered: `useShortcut` holds the handler in a
  // ref, so an inline arrow from the caller is always the CURRENT one and there
  // is no dependency array to get wrong. Escape and a backdrop click go through
  // the same `onClose` by construction.
  //
  // MODAL priority, so an open menu inside the modal takes Escape first.
  useShortcut({ key: "Escape" }, () => onClose?.(), {
    priority: ShortcutLayer.MODAL,
    allowInInput: true,
  });

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose?.(); // only close if the click was on the backdrop
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 flex items-center justify-center z-60"
    >
      <div
        onClick={handleClick}
        className="fixed inset-0 bg-black opacity-60"
      />
      <div className="relative">{children}</div>
    </div>
  );
}
