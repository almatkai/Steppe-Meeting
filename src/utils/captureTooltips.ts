/** WebKit's native title tooltips use separate, unprotected macOS windows.
 * Suppress them while capture protection is active; keep accessible labels.
 */
export function suppressCaptureTooltips(root: HTMLElement): () => void {
  const strip = (element: Element) => {
    const title = element.getAttribute("title");
    if (!title) return;
    element.setAttribute("data-capture-title", title);
    if (!element.hasAttribute("aria-label")) {
      element.setAttribute("aria-label", title);
      element.setAttribute("data-capture-label", "true");
    } else if (element.hasAttribute("data-capture-label")) {
      element.setAttribute("aria-label", title);
    }
    element.removeAttribute("title");
  };
  const stripTree = (element: Element) => {
    strip(element);
    element.querySelectorAll("[title]").forEach(strip);
  };
  stripTree(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) strip(record.target);
      else for (const node of record.addedNodes) {
        if (node instanceof Element) stripTree(node);
      }
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  return () => {
    observer.disconnect();
    root.querySelectorAll("[data-capture-title]").forEach((element) => {
      element.setAttribute("title", element.getAttribute("data-capture-title") || "");
      element.removeAttribute("data-capture-title");
      if (element.hasAttribute("data-capture-label")) {
        element.removeAttribute("aria-label");
        element.removeAttribute("data-capture-label");
      }
    });
  };
}
