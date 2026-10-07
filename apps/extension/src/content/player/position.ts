/**
 * Where the player card goes, next to its target or on its own (Phase 6a).
 * The two moves Floating UI would make for this card, written out so the
 * content script does not ship a positioning library (budget, ADR 0013):
 *
 * - flip: the preferred side first, then the opposite side, then the other
 *   two; the first side where the card fits inside the viewport wins;
 * - shift: the card is slid along that side to stay inside the viewport.
 *
 * When no side fits (a target as large as the viewport), the side with the
 * most room is used and the card overlaps the target, clamped to the
 * viewport. Pure: it works on numbers, so it is tested without layout.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Placement = 'auto' | Side

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Space between the target and the card, and between the card and the viewport edges. */
export const GAP = 10
export const MARGIN = 12

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
/** Below first: the card does not cover what is above the target (headings, labels). */
const AUTO_ORDER: Side[] = ['bottom', 'top', 'right', 'left']

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function sidesFor(placement: Placement): Side[] {
  if (placement === 'auto') return AUTO_ORDER
  const first = [placement, OPPOSITE[placement]]
  return [...first, ...AUTO_ORDER.filter((side) => !first.includes(side))]
}

/** Room for the card on each side of the target. */
function room(side: Side, target: Box, viewport: Viewport): number {
  switch (side) {
    case 'top':
      return target.top - GAP - MARGIN
    case 'bottom':
      return viewport.height - (target.top + target.height) - GAP - MARGIN
    case 'left':
      return target.left - GAP - MARGIN
    case 'right':
      return viewport.width - (target.left + target.width) - GAP - MARGIN
  }
}

/** The card's top-left corner on `side`, shifted inside the viewport. */
function onSide(side: Side, card: Viewport, target: Box, viewport: Viewport) {
  const maxLeft = Math.max(MARGIN, viewport.width - card.width - MARGIN)
  const maxTop = Math.max(MARGIN, viewport.height - card.height - MARGIN)
  if (side === 'top' || side === 'bottom') {
    const top =
      side === 'bottom' ? target.top + target.height + GAP : target.top - GAP - card.height
    return { left: clamp(target.left, MARGIN, maxLeft), top: clamp(top, MARGIN, maxTop) }
  }
  const left = side === 'right' ? target.left + target.width + GAP : target.left - GAP - card.width
  const centred = target.top + target.height / 2 - card.height / 2
  return { left: clamp(left, MARGIN, maxLeft), top: clamp(centred, MARGIN, maxTop) }
}

/**
 * The card's position next to `target` (viewport coordinates), or, without a
 * target, its unanchored place: the bottom-right corner, where it covers the
 * least of a typical page.
 */
export function placeCard(
  card: Viewport,
  target: Box | null,
  placement: Placement,
  viewport: Viewport,
): { left: number; top: number; side: Side | null } {
  if (!target) {
    return {
      left: Math.max(MARGIN, viewport.width - card.width - MARGIN),
      top: Math.max(MARGIN, viewport.height - card.height - MARGIN),
      side: null,
    }
  }
  const sides = sidesFor(placement)
  const needed = (side: Side) => (side === 'top' || side === 'bottom' ? card.height : card.width)
  const side =
    sides.find((candidate) => room(candidate, target, viewport) >= needed(candidate)) ??
    sides.reduce((best, candidate) =>
      room(candidate, target, viewport) > room(best, target, viewport) ? candidate : best,
    )
  return { ...onSide(side, card, target, viewport), side }
}

/** True when the box is fully inside the viewport (nothing to scroll). */
export function inView(box: Box, viewport: Viewport): boolean {
  return (
    box.top >= 0 &&
    box.left >= 0 &&
    box.top + box.height <= viewport.height &&
    box.left + box.width <= viewport.width
  )
}
