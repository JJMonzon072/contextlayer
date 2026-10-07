import { describe, expect, it } from 'vitest'

import { GAP, inView, MARGIN, placeCard } from '../src/content/player/position'

const VIEWPORT = { width: 1_000, height: 800 }
const CARD = { width: 320, height: 200 }
const box = (left: number, top: number, width = 120, height = 32) => ({ left, top, width, height })

describe('placing the player card', () => {
  it('goes below the target by default, aligned with its left edge', () => {
    expect(placeCard(CARD, box(100, 100), 'auto', VIEWPORT)).toEqual({
      left: 100,
      top: 100 + 32 + GAP,
      side: 'bottom',
    })
  })

  it('flips above when there is no room below', () => {
    expect(placeCard(CARD, box(100, 700), 'auto', VIEWPORT)).toEqual({
      left: 100,
      top: 700 - GAP - 200,
      side: 'top',
    })
  })

  it('tries the step placement first, then its opposite side', () => {
    expect(placeCard(CARD, box(500, 300), 'left', VIEWPORT).side).toBe('left')
    expect(placeCard(CARD, box(100, 300), 'left', VIEWPORT).side).toBe('right')
    expect(placeCard(CARD, box(100, 300), 'top', VIEWPORT).side).toBe('top')
  })

  it('centres a card beside the target vertically', () => {
    expect(placeCard(CARD, box(500, 300, 120, 40), 'right', VIEWPORT)).toEqual({
      left: 500 + 120 + GAP,
      top: 300 + 20 - 100,
      side: 'right',
    })
  })

  it('shifts the card along its side to stay inside the viewport', () => {
    expect(placeCard(CARD, box(900, 100), 'auto', VIEWPORT).left).toBe(1_000 - 320 - MARGIN)
    expect(placeCard(CARD, box(-50, 100), 'auto', VIEWPORT).left).toBe(MARGIN)
  })

  it('uses the side with the most room when none fits, inside the viewport', () => {
    const huge = box(0, 0, 1_000, 700)

    const placed = placeCard(CARD, huge, 'auto', VIEWPORT)

    expect(placed.side).toBe('bottom')
    expect(placed.top).toBe(800 - 200 - MARGIN)
    expect(placed.left).toBe(MARGIN)
  })

  it('puts an unanchored card in the bottom-right corner', () => {
    expect(placeCard(CARD, null, 'top', VIEWPORT)).toEqual({
      left: 1_000 - 320 - MARGIN,
      top: 800 - 200 - MARGIN,
      side: null,
    })
  })

  it('keeps the card on screen in a viewport smaller than the card', () => {
    const tiny = { width: 200, height: 150 }

    expect(placeCard(CARD, null, 'auto', tiny)).toMatchObject({ left: MARGIN, top: MARGIN })
    expect(placeCard(CARD, box(10, 10, 20, 20), 'auto', tiny)).toMatchObject({
      left: MARGIN,
      top: MARGIN,
    })
  })

  it('says whether a box needs scrolling', () => {
    expect(inView(box(10, 10), VIEWPORT)).toBe(true)
    expect(inView(box(10, 790), VIEWPORT)).toBe(false)
    expect(inView(box(10, -5), VIEWPORT)).toBe(false)
  })
})
