import ReactDOM from "react-dom";
import { useLocation } from "react-router";
import { cn } from "#/utils/utils";

interface NimbusSkillsPanelWrapperProps {
  isOpen: boolean;
}

/**
 * Portal wrapper for the Skills Panel — mirrors ConversationPanelWrapper so
 * the overlay renders inside the main outlet and gets the same rounded-corner
 * clip as every other side-panel in the app.
 */
export function NimbusSkillsPanelWrapper({
  isOpen,
  children,
}: React.PropsWithChildren<NimbusSkillsPanelWrapperProps>) {
  const { pathname } = useLocation();

  if (!isOpen) return null;
  const portalTarget = document.getElementById("root-outlet");
  if (!portalTarget) return null;

  return ReactDOM.createPortal(
    <div
      className={cn(
        "absolute left-0 top-0 z-[100] h-full w-full rounded-xl bg-black/80 backdrop-blur-sm",
        pathname === "/" && "bottom-0 top-0 h-auto md:top-3 md:bottom-3",
      )}
    >
      {children}
    </div>,
    portalTarget,
  );
}
