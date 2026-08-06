import { PreviewPanel } from "#/components/features/preview/preview-panel";

/**
 * Route wrapper so the preview joins the tab registry the same way the others
 * do, and so the panel itself stays free of routing concerns.
 */
function PreviewTab() {
  return <PreviewPanel />;
}

export default PreviewTab;
