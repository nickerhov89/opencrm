import {useEffect} from 'react';

// Pressing the mouse on an empty part of the board and moving it scrolls the board sideways, as in
// amoCRM. Cards (they are dragged between stages), buttons, links and fields keep their own behavior.
const interactive = 'a,button,input,textarea,select,label,[draggable="true"],[contenteditable="true"],[role="button"],article';

// element: the scrolling element itself (from a callback ref), so a re-mounted board is picked up.
export function useDragScroll(element) {
  useEffect(() => {
    if (!element) return undefined;
    let start = null, moved = false;
    const down = event => {
      if (event.button !== 0 || event.pointerType !== 'mouse' || event.target.closest(interactive)) return;
      start = {x: event.clientX, left: element.scrollLeft};
      moved = false;
    };
    const move = event => {
      if (!start) return;
      const shift = event.clientX - start.x;
      if (!moved && Math.abs(shift) < 4) return;
      if (!moved) { moved = true; element.classList.add('drag-scrolling'); window.getSelection()?.removeAllRanges(); }
      element.scrollLeft = start.left - shift;
      event.preventDefault();
    };
    const up = () => {
      if (!start) return;
      start = null;
      element.classList.remove('drag-scrolling');
      // A drag ends with a click on what is under the mouse; it should not open anything.
      if (moved) window.addEventListener('click', swallow, {capture: true, once: true});
      setTimeout(() => window.removeEventListener('click', swallow, {capture: true}), 0);
    };
    const swallow = event => { event.stopPropagation(); event.preventDefault(); };
    element.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('blur', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('blur', up);
      window.removeEventListener('click', swallow, {capture: true});
    };
  }, [element]);
}
