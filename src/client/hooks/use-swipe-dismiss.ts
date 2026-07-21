import { useCallback, useRef, type PointerEventHandler } from "react";

type SwipeDirection = "left" | "right" | "either";

type SwipeDismissOptions = {
  direction: SwipeDirection;
  enabled?: boolean;
  minimumDistance?: number;
};

type SwipeStart = {
  pointerId: number;
  x: number;
  y: number;
};

/** Adds a touch/pen swipe affordance without interfering with vertical scrolling. */
export function useSwipeDismiss<T extends HTMLElement>(
  onDismiss: () => void,
  { direction, enabled = true, minimumDistance = 72 }: SwipeDismissOptions
): {
  onPointerDown: PointerEventHandler<T>;
  onPointerUp: PointerEventHandler<T>;
  onPointerCancel: PointerEventHandler<T>;
} {
  const startRef = useRef<SwipeStart | null>(null);

  const onPointerDown = useCallback<PointerEventHandler<T>>((event) => {
    if (!enabled || (event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary) return;
    startRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointers may not be capturable. */ }
  }, [enabled]);

  const onPointerUp = useCallback<PointerEventHandler<T>>((event) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* The pointer may already be released. */ }
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < minimumDistance || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    if (direction === "either" || (direction === "left" && deltaX < 0) || (direction === "right" && deltaX > 0)) onDismiss();
  }, [direction, minimumDistance, onDismiss]);

  const onPointerCancel = useCallback<PointerEventHandler<T>>(() => {
    startRef.current = null;
  }, []);

  return { onPointerDown, onPointerUp, onPointerCancel };
}
