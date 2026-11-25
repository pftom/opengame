// Runs inside the sandboxed preview, where the editor cannot read its DOM.
export const DESIGN_ANNOTATION_BRIDGE = `
  let annotationFrame;
  let trackedAnnotationElements = [];
  let trackedAnnotationScopes = [];
  let reportTrackedGeometry = false;
  const legacyAnnotationScopes = new Map();

  function uniqueAnnotationSelectorMatch(selector) {
    if (typeof selector !== 'string' || !selector) return;
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length === 1) return matches[0];
    } catch { /* A saved selector can become invalid after an edit. */ }
  }

  function stableAnnotationSelector(element) {
    const id = element.id;
    const designId = element.getAttribute('data-od-id');
    const byId = id && '#' + CSS.escape(id);
    const byDesignId = designId && '[data-od-id="' + CSS.escape(designId) + '"]';
    if (byId && uniqueAnnotationSelectorMatch(byId) === element) return byId;
    if (byDesignId && uniqueAnnotationSelectorMatch(byDesignId) === element) return byDesignId;
  }

  function annotationContainerSelector(element) {
    const path = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const stable = stableAnnotationSelector(ancestor);
      if (stable) { path.unshift(stable); break; }
      let index = 1;
      for (let sibling = ancestor.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === ancestor.localName) index++;
      }
      path.unshift(CSS.escape(ancestor.localName) + ':nth-of-type(' + index + ')');
    }
    const selector = path.join(' > ');
    if (uniqueAnnotationSelectorMatch(selector) === element) return selector;
  }

  function isAnnotationScrollContainer(element) {
    if (element === document.scrollingElement || element === document.documentElement) return false;
    const style = getComputedStyle(element);
    const isScrollable = overflow => /^(auto|scroll|overlay)$/.test(overflow);
    return isScrollable(style.overflowX) || isScrollable(style.overflowY)
      || (style.overflowX === 'hidden' && element.scrollWidth > element.clientWidth)
      || (style.overflowY === 'hidden' && element.scrollHeight > element.clientHeight);
  }

  function designAnnotationScroll(element) {
    const scroll = { x: window.scrollX, y: window.scrollY };
    const containers = [];
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (!isAnnotationScrollContainer(ancestor)) continue;
      const selector = annotationContainerSelector(ancestor);
      if (selector) containers.unshift({ selector, x: ancestor.scrollLeft, y: ancestor.scrollTop });
    }
    return containers.length ? { ...scroll, containers } : scroll;
  }

  function annotationScopeContainers(ref) {
    if (Array.isArray(ref.containers)) return ref.containers;
    const point = ref.point;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    const cached = legacyAnnotationScopes.get(ref.id);
    if (cached && cached.x === point.x && cached.y === point.y) return cached.containers;

    // Legacy marks only stored viewport coordinates. Resolve their scope once at the saved point.
    const element = document.elementFromPoint(point.x, point.y);
    const scroll = designAnnotationScroll(element);
    const containers = (scroll.containers || []).map(({ selector }) => ({ selector, x: 0, y: 0 }));
    legacyAnnotationScopes.set(ref.id, { x: point.x, y: point.y, containers });
    return containers;
  }

  function annotationScopeGeometry(ref) {
    const containers = annotationScopeContainers(ref);
    if (!containers.length) return;
    const offset = { x: 0, y: 0 };
    let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
    for (const captured of containers) {
      if (!captured || !Number.isFinite(captured.x) || !Number.isFinite(captured.y)) return;
      const element = uniqueAnnotationSelectorMatch(captured.selector);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
      const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
      // The annotation is in viewport pixels; each scroll delta is in its container's local pixels.
      offset.x += (captured.x - element.scrollLeft) * scaleX;
      offset.y += (captured.y - element.scrollTop) * scaleY;
      const clientLeft = rect.left + element.clientLeft * scaleX;
      const clientTop = rect.top + element.clientTop * scaleY;
      left = Math.max(left, clientLeft);
      top = Math.max(top, clientTop);
      right = Math.min(right, clientLeft + element.clientWidth * scaleX);
      bottom = Math.min(bottom, clientTop + element.clientHeight * scaleY);
    }
    const width = right - left, height = bottom - top;
    const clip = width > 0 && height > 0
      ? { x: left, y: top, width, height }
      : { x: 0, y: 0, width: 0, height: 0 };
    return { id: ref.id, offset, clip };
  }

  function visibleAnnotationBox(element) {
    if (!element.isConnected || getComputedStyle(element).visibility !== 'visible') return;
    if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
  }

  function findAnnotationBox(ref) {
    try {
      if (typeof ref.elementId === 'string' && ref.elementId) {
        const byId = uniqueAnnotationSelectorMatch('#' + CSS.escape(ref.elementId));
        if (byId) return visibleAnnotationBox(byId);
      }
      if (typeof ref.selector !== 'string' || !ref.selector) return;
      const matches = Array.from(document.querySelectorAll(ref.selector), visibleAnnotationBox).filter(Boolean);
      if (matches.length === 1) return matches[0];
    } catch { /* A saved selector can become invalid after an edit. */ }
  }

  function scheduleAnnotationGeometry() {
    if (window.parent === window || annotationFrame !== undefined) return;
    annotationFrame = requestAnimationFrame(() => {
      annotationFrame = undefined;
      window.parent.postMessage({ type: 'om:design-scroll', token: TOKEN, scroll: designAnnotationScroll() }, '*');
      if (!reportTrackedGeometry && !trackedAnnotationElements.length && !trackedAnnotationScopes.length) return;
      reportTrackedGeometry = false;
      const boxes = trackedAnnotationElements.flatMap(ref => {
        const box = findAnnotationBox(ref);
        return box ? [{ id: ref.id, box }] : [];
      });
      const scopes = trackedAnnotationScopes.map(annotationScopeGeometry).filter(Boolean);
      window.parent.postMessage({ type: 'om:design-element-boxes', token: TOKEN, boxes, scopes }, '*');
    });
  }

  window.addEventListener('scroll', scheduleAnnotationGeometry, { capture: true, passive: true });
  window.addEventListener('resize', scheduleAnnotationGeometry);
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || !message || message.token !== TOKEN) return;
    if (message.type === 'om:design-request-scroll') scheduleAnnotationGeometry();
    if (message.type === 'om:design-track-elements') {
      const withId = ref => ref && typeof ref.id === 'string';
      trackedAnnotationElements = Array.isArray(message.elements) ? message.elements.filter(withId) : [];
      trackedAnnotationScopes = Array.isArray(message.scopes) ? message.scopes.filter(withId) : [];
      const trackedScopeIds = new Set(trackedAnnotationScopes.map(ref => ref.id));
      for (const id of legacyAnnotationScopes.keys()) {
        if (!trackedScopeIds.has(id)) legacyAnnotationScopes.delete(id);
      }
      reportTrackedGeometry = true;
      scheduleAnnotationGeometry();
    }
    if (message.type === 'om:design-pick-scroll' && typeof message.requestId === 'string') {
      const point = message.point;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const element = document.elementFromPoint(point.x, point.y);
      window.parent.postMessage({ type: 'om:design-picked-scroll', token: TOKEN, requestId: message.requestId, scroll: designAnnotationScroll(element) }, '*');
    }
  });
  scheduleAnnotationGeometry();
`;
