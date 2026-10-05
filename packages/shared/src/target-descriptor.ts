import { z } from 'zod'

import { urlPatternSchema } from './url-pattern.js'

/**
 * TargetDescriptor v1 (ADR 0014): the signals captured for one step's element.
 * Phase 3 only defines, validates and stores it; capture arrives in Phase 5 and
 * resolution in Phase 6. Every string and array is bounded and unknown keys are
 * rejected, so a descriptor cannot become an arbitrary JSON blob.
 */
export const TARGET_DESCRIPTOR_MAX_LENGTH = 16_384
export const CAPTURED_TEXT_MAX_LENGTH = 80

/** First-party attribute first, then the common test attributes (ADR 0014, capture step 3). */
export const TEST_ID_ATTRIBUTES = [
  'data-contextlayer-id',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
] as const

export const TARGET_FALLBACKS = ['show-unanchored', 'skip', 'end'] as const

const capturedText = z.string().min(1).max(CAPTURED_TEXT_MAX_LENGTH)
const optionalText = z.string().max(CAPTURED_TEXT_MAX_LENGTH)
const tagName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Invalid tag name.')
const roleName = z.string().regex(/^[a-z][a-z-]{0,39}$/, 'Invalid ARIA role.')
const selector = z.string().min(1).max(512)
const count = (max: number) => z.number().int().min(0).max(max)

const testIdSchema = z.strictObject({ attr: z.enum(TEST_ID_ATTRIBUTES), value: capturedText })

const locatorBase = { scope: z.enum(['root', 'container']), matchCount: count(10_000) }
const textLocator = <S extends string>(strategy: S) =>
  z.strictObject({
    strategy: z.literal(strategy),
    text: capturedText,
    exact: z.boolean(),
    ...locatorBase,
  })

export const targetLocatorSchema = z.discriminatedUnion('strategy', [
  z.strictObject({
    strategy: z.literal('testId'),
    attr: z.enum(TEST_ID_ATTRIBUTES),
    value: capturedText,
    ...locatorBase,
  }),
  z.strictObject({ strategy: z.literal('id'), value: capturedText, ...locatorBase }),
  z.strictObject({
    strategy: z.literal('role'),
    role: roleName,
    name: optionalText,
    exact: z.boolean(),
    ...locatorBase,
  }),
  textLocator('label'),
  textLocator('placeholder'),
  textLocator('altText'),
  textLocator('title'),
  textLocator('text'),
  z.strictObject({ strategy: z.literal('css'), selector, ...locatorBase }),
  z.strictObject({ strategy: z.literal('cssPath'), selector, ...locatorBase }),
  z.strictObject({ strategy: z.literal('xpath'), expression: selector, ...locatorBase }),
])

export const targetAnchorSchema = z.discriminatedUnion('relation', [
  z.strictObject({
    relation: z.literal('ancestor'),
    distance: z.number().int().min(1).max(20),
    tag: tagName,
    id: capturedText.optional(),
    testId: testIdSchema.optional(),
    role: roleName.optional(),
  }),
  z.strictObject({
    relation: z.literal('precedingHeading'),
    level: z.number().int().min(1).max(6),
    text: capturedText,
  }),
  z.strictObject({ relation: z.literal('label'), text: capturedText }),
])

const attributeName = z.string().regex(/^[a-z][a-z0-9_:.-]{0,39}$/, 'Invalid attribute name.')

const elementSchema = z.strictObject({
  tag: tagName,
  role: roleName.optional(),
  accessibleName: optionalText.optional(),
  text: optionalText.optional(),
  testIds: z.array(testIdSchema).max(5),
  id: z.strictObject({ value: capturedText, generated: z.boolean() }).optional(),
  attributes: z
    .record(attributeName, optionalText.nullable())
    .refine((attributes) => Object.keys(attributes).length <= 12, {
      message: 'At most 12 attributes.',
    }),
  classes: z
    .strictObject({
      stable: z.array(z.string().regex(/^-?[A-Za-z_][A-Za-z0-9_-]{0,79}$/)).max(10),
      droppedCount: count(1000),
    })
    .optional(),
  nthOfType: z
    .strictObject({
      index: z.number().int().min(1).max(10_000),
      count: z.number().int().min(1).max(10_000),
    })
    .refine((nth) => nth.index <= nth.count, { message: 'index must not exceed count.' })
    .optional(),
  rect: z
    .strictObject({
      x: z.number().min(-1e6).max(1e6),
      y: z.number().min(-1e6).max(1e6),
      width: z.number().min(0).max(1e6),
      height: z.number().min(0).max(1e6),
    })
    .optional(),
})

export const targetDescriptorV1Schema = z
  .strictObject({
    version: z.literal(1),
    capturedAt: z.iso.datetime(),
    capture: z.strictObject({
      extensionVersion: z.string().regex(/^\d{1,5}(\.\d{1,5}){0,3}$/, 'Invalid version.'),
      chromeMajor: z.number().int().min(100).max(999).optional(),
      viewport: z
        .strictObject({
          width: z.number().int().min(1).max(20_000),
          height: z.number().int().min(1).max(20_000),
          devicePixelRatio: z.number().min(0.1).max(10),
        })
        .optional(),
      pickedTag: tagName,
      promotion: z.enum(['none', 'interactive-ancestor']),
    }),
    page: z.strictObject({ urlPattern: urlPatternSchema }),
    framePath: z
      .array(
        z.strictObject({
          urlPattern: urlPatternSchema.optional(),
          name: capturedText.optional(),
          title: capturedText.optional(),
          testId: testIdSchema.optional(),
          index: count(1000).optional(),
        }),
      )
      .max(5),
    shadowPath: z
      .array(
        z.strictObject({
          mode: z.enum(['open', 'closed']),
          host: z.strictObject({
            tag: tagName,
            testId: testIdSchema.optional(),
            id: capturedText.optional(),
            cssPath: selector.optional(),
          }),
        }),
      )
      .max(5),
    container: z
      .strictObject({
        kind: z.enum([
          'dialog',
          'menu',
          'listbox',
          'form',
          'region',
          'navigation',
          'table',
          'other',
        ]),
        role: roleName.optional(),
        accessibleName: optionalText.optional(),
        modal: z.boolean().optional(),
      })
      .optional(),
    element: elementSchema,
    anchors: z.array(targetAnchorSchema).max(6),
    locators: z.array(targetLocatorSchema).min(1).max(12),
    resolution: z.strictObject({
      minScore: z.number().min(0).max(1),
      minMargin: z.number().min(0).max(1),
      timeoutMs: z.number().int().min(0).max(60_000),
      textPolicy: z.enum(['normalized', 'exact', 'ignore']).optional(),
      onAmbiguous: z.enum(TARGET_FALLBACKS),
      onNotFound: z.enum(TARGET_FALLBACKS),
    }),
  })
  .superRefine((descriptor, ctx) => {
    if (JSON.stringify(descriptor).length > TARGET_DESCRIPTOR_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: `A target descriptor must stay under ${String(TARGET_DESCRIPTOR_MAX_LENGTH)} characters.`,
      })
    }
  })

/** Discriminated on `version`: a descriptor with an unknown version is rejected. */
export const targetDescriptorSchema = z.discriminatedUnion('version', [targetDescriptorV1Schema])

export type TargetDescriptor = z.infer<typeof targetDescriptorSchema>
export type TargetLocator = z.infer<typeof targetLocatorSchema>
