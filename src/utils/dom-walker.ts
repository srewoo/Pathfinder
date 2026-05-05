/**
 * A fast, memory-efficient DOM walker that pierces Shadow DOM boundaries.
 * Rather than relying on document.querySelectorAll() which cannot see into
 * open Shadow Roots, this recursively walks the tree.
 */

export function walkDOM(
  rootNode: Node,
  onElement: (el: Element) => boolean | void
): void {
  // We use an iterative stack to avoid call stack limits on deeply nested DOMs
  const stack: Node[] = [rootNode];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      
      // Call the visitor. If it returns strictly `false`, we skip traversing its children.
      // This is useful for ignoring completely hidden trees like <script>, <style>, or display:none elements.
      const shouldContinue = onElement(el);
      if (shouldContinue === false) {
        continue;
      }

      // If the element has a Shadow Root, we must traverse into it to pierce the boundary
      if (el.shadowRoot) {
        stack.push(el.shadowRoot);
      }

      // Same-origin iframes — accessing contentDocument throws on cross-origin,
      // so we guard with try/catch and silently skip those.
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc && doc.body) {
            stack.push(doc.body);
          }
        } catch {
          // Cross-origin iframe — browser blocks access. Nothing we can do.
        }
      }
    }

    // Push children onto the stack in reverse order so they are processed in normal DOM order
    let child = node.lastChild;
    while (child) {
      if (child.nodeType === Node.ELEMENT_NODE || child.nodeType === Node.TEXT_NODE) {
        stack.push(child);
      }
      child = child.previousSibling;
    }
  }
}
