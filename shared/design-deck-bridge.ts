export const DESIGN_DECK_SLIDE_SELECTOR = '.slide, [data-screen-label], .deck-slide, .ppt-slide, .slide-frame';
export const DESIGN_DECK_INACTIVE_ATTRIBUTE = 'data-om-deck-inactive';
export const DESIGN_DECK_ISOLATION_CSS = `[${DESIGN_DECK_INACTIVE_ATTRIBUTE}] { display: none !important; }`;

// Runs only in Design preview documents. The host enables it for presentations.
export const DESIGN_DECK_BRIDGE = `
  const deckSlideSelector = ${JSON.stringify(DESIGN_DECK_SLIDE_SELECTOR)};
  const deckHiddenAttribute = ${JSON.stringify(DESIGN_DECK_INACTIVE_ATTRIBUTE)};
  let deckMode = null;
  let deckActive = 0;
  let deckIsolated = false;
  let deckNative = false;
  let deckStyle;
  let deckCommand = 0;

  function deckSlides() {
    return Array.from(document.querySelectorAll(deckSlideSelector)).filter(slide => !slide.parentElement?.closest(deckSlideSelector));
  }

  function deckVisibleSlides(slides) {
    return slides.map((slide, index) => {
      const style = getComputedStyle(slide);
      return slide.getClientRects().length && style.visibility === 'visible' && Number(style.opacity) > 0
        ? index : -1;
    }).filter(index => index >= 0);
  }

  function deckAuthoredIndex(slides) {
    const active = slides.findIndex(slide => slide.classList.contains('active')
      || slide.matches('[aria-current="page"], [aria-current="true"]'));
    if (active >= 0) return active;
    const visible = deckVisibleSlides(slides);
    return visible.length === 1 ? visible[0] : -1;
  }

  function deckAnnounce(count) {
    if (count) window.parent.postMessage({
      type: 'od:slide-state', active: deckActive, count, protocolVersion: 1, token: TOKEN, isolated: deckIsolated
    }, '*');
  }

  function deckApplyVisibility(slides) {
    if (deckIsolated && !deckStyle) {
      deckStyle = document.createElement('style');
      deckStyle.textContent = ${JSON.stringify(DESIGN_DECK_ISOLATION_CSS)};
      (document.head || document.documentElement).appendChild(deckStyle);
    }
    slides.forEach((slide, index) => slide.toggleAttribute(deckHiddenAttribute, deckIsolated && index !== deckActive));
  }

  function deckConfigure() {
    const slides = deckSlides();
    if (deckIsolated) {
      deckIsolated = false;
      deckApplyVisibility(slides);
    }
    if (!deckMode?.enabled || !slides.length) return;
    deckActive = Math.max(0, deckAuthoredIndex(slides));
    deckNative = Array.from(document.scripts).some(script => {
      if (script.matches('[data-om-design-bridge], [data-om-preview-bridge]')) return false;
      const source = script.textContent || '';
      return /['"]od:slide['"]/.test(source) && /od:(deck-ready|slide-state)/.test(source);
    });
    if (!deckNative && deckMode.singlePage && deckVisibleSlides(slides).length > 1) {
      deckIsolated = true;
      deckApplyVisibility(slides);
    }
    if (!deckNative) deckAnnounce(slides.length);
  }

  function deckResetScroll(slide) {
    for (let element = slide.parentElement; element; element = element.parentElement) {
      if (element.scrollTop || element.scrollLeft) element.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    }
    if (window.scrollY || window.scrollX) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }

  function deckRequestedIndex(message, count, active) {
    if (message.action === 'first') return 0;
    if (message.action === 'last') return count - 1;
    if (message.action === 'prev') return Math.max(0, active - 1);
    if (message.action === 'next') return Math.min(count - 1, active + 1);
    if (message.action === 'go' && Number.isFinite(message.index)) {
      return Math.max(0, Math.min(count - 1, Math.trunc(message.index)));
    }
    return active;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || !message || typeof message !== 'object') return;
    if (message.type === 'om:design-deck-mode' && message.token === TOKEN) {
      const nextMode = { enabled: Boolean(message.enabled), singlePage: Boolean(message.singlePage) };
      if (deckMode?.enabled === nextMode.enabled && deckMode.singlePage === nextMode.singlePage) {
        if (deckMode.enabled && !deckNative && document.readyState !== 'loading') deckAnnounce(deckSlides().length);
        return;
      }
      deckMode = nextMode;
      deckCommand += 1;
      if (document.readyState !== 'loading') deckConfigure();
      return;
    }
    if (message.type !== 'od:slide' || !deckMode?.enabled || deckNative) return;
    const command = ++deckCommand;
    // Let any authored navigation handler change the page first.
    setTimeout(() => {
      if (command !== deckCommand) return;
      const slides = deckSlides();
      if (!slides.length) return;
      const authored = deckAuthoredIndex(slides);
      const target = deckRequestedIndex(message, slides.length, deckActive);
      if (!deckIsolated && authored >= 0 && authored !== deckActive) {
        deckActive = authored;
      } else if (target !== deckActive) {
        deckActive = target;
        if (deckIsolated) {
          deckApplyVisibility(slides);
          deckResetScroll(slides[target]);
        } else {
          slides.forEach((slide, index) => slide.classList.toggle('active', index === target));
        }
      }
      deckAnnounce(slides.length);
    }, 0);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', deckConfigure, { once: true });
  window.parent.postMessage({ type: 'om:design-deck-ready', token: TOKEN }, '*');
`;
