import React from "react";

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
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
    // onClose belongs here. The listener closes over it, and callers almost
    // always pass an inline arrow — so with an empty dependency array the
    // handler registered on the FIRST render is the one Escape keeps calling
    // forever, holding whatever state that closure captured. Clicking the
    // backdrop went through the current prop and Escape did not, which is a
    // difference nobody would think to look for.
  }, [onClose]);

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
