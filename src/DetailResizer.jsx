import React, {useEffect, useRef, useState} from 'react';
import './detail-split.css';

const widthKey = 'opencrm.detailLeftWidth';

export function useDetailSplit() {
  const [leftWidth, setLeftWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey) ?? localStorage.getItem('opencrm.dealLeftWidth'));
      return saved >= 320 && saved <= 760 ? saved : 420;
    } catch { return 420; }
  });
  const layoutRef = useRef(null);
  const resizingRef = useRef(false);
  const resizeLeft = width => {
    const available = (layoutRef.current?.clientWidth || 1080) - 327;
    const next = Math.round(Math.max(320, Math.min(width, 760, available)));
    setLeftWidth(next);
    try { localStorage.setItem(widthKey, String(next)); } catch {}
  };
  useEffect(() => {
    const clamp = () => {
      const width = layoutRef.current?.clientWidth;
      if (width > 694) setLeftWidth(current => Math.min(current, Math.max(320, width - 327)));
    };
    window.addEventListener('resize', clamp);
    clamp();
    return () => window.removeEventListener('resize', clamp);
  }, []);
  const stopResize = event => {
    resizingRef.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    layoutRef,
    leftWidth,
    style: {'--detail-left-width': leftWidth + 'px'},
    onPointerDown: event => {
      if (event.button !== 0) return;
      event.preventDefault();
      resizingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: event => {
      if (resizingRef.current) resizeLeft(event.clientX - layoutRef.current.getBoundingClientRect().left);
    },
    onPointerUp: stopResize,
    onPointerCancel: stopResize,
    onDoubleClick: () => resizeLeft(420),
    onKeyDown: event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        resizeLeft(leftWidth + (event.key === 'ArrowLeft' ? -20 : 20));
      } else if (event.key === 'Home') {
        event.preventDefault();
        resizeLeft(420);
      }
    },
  };
}

export default function DetailResizer({split}) {
  return <div className="detail-resizer" role="separator" aria-label="Ширина данных карточки" aria-orientation="vertical" aria-valuenow={split.leftWidth} aria-valuemin={320} aria-valuemax={760} tabIndex={0} title="Перетащите, чтобы изменить ширину; двойной клик — сбросить" onPointerDown={split.onPointerDown} onPointerMove={split.onPointerMove} onPointerUp={split.onPointerUp} onPointerCancel={split.onPointerCancel} onDoubleClick={split.onDoubleClick} onKeyDown={split.onKeyDown}/>;
}
