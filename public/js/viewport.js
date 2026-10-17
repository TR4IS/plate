// Keeps the app inside the visible area while the iPhone keyboard is open.
//
// iOS does not resize the page for the keyboard: it only shrinks the "visual viewport" and slides
// the page up to reveal the focused field, which pushes headers off screen and hides anything
// docked at the bottom. Here the app is sized and positioned to match what is actually visible,
// so a sheet's Save button or the camera's note box sits right above the keyboard.
const viewport = window.visualViewport;
const root = document.documentElement;
let keyboardOpen = false;

function sync() {
  // A pinch-zoom also shrinks the visual viewport; only react to the keyboard.
  const open = viewport.scale <= 1.01 && window.innerHeight - viewport.height > 120;
  if (open) {
    root.style.setProperty('--app-height', `${Math.round(viewport.height)}px`);
    root.style.setProperty('--app-top', `${Math.round(viewport.offsetTop)}px`);
  } else if (keyboardOpen) {
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-top');
    // Safari can leave the page slid up after the keyboard goes away.
    window.scrollTo(0, 0);
  }
  if (open !== keyboardOpen) {
    keyboardOpen = open;
    root.classList.toggle('keyboard-open', open);
    if (open) {
      // The area just got shorter; make sure the field being typed in is still in view.
      setTimeout(() => document.activeElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 60);
    }
  }
}

if (viewport) {
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
}
