// lib/validators/schemas.ts

import { z } from 'zod'
import { ScoringMode } from '@prisma/client'
import { validateProjectUrl } from './url-rules'
import {
  MAX_SOURCE_CODE_LENGTH,
  SOURCE_CODE_TOO_LONG_MESSAGE,
} from './source-code-rules'

/**
 * The Source Code length limit and its message now live in
 * `lib/validators/source-code-rules.ts`, a Prisma-free module, because client
 * components need the number for their character counters and this file pulls
 * in the Prisma runtime via `z.nativeEnum`. Re-exported here so callers that
 * already read the limit off the schemas module keep working.
 */
export { MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE }

/**
 * Object-level URL check for submission payloads. `superRefine` (rather than
 * `refine`) is used so the specific reason — unparseable or wrong scheme —
 * reaches the caller instead of one catch-all message, and `path: ['url']`
 * keeps the issue attached to the field the admin has to fix.
 *
 * `url` is optional (Requirement: a project may be submitted with Source Code
 * only, no live URL), so a blank/absent value is not itself an error here —
 * that is `refineUrlOrSourceCode`'s job.
 */
function refineProjectUrl(
  data: { url?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (typeof data.url !== 'string' || data.url.length === 0) return

  const result = validateProjectUrl(data.url)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.message,
      path: ['url'],
    })
  }
}

/** Whether a text field holds anything beyond whitespace. */
function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * A project needs *some* evidence to crawl or score from: either a live URL
 * to fetch, or Source Code pasted/uploaded directly. Neither field is
 * required on its own — this is what enforces that at least one of them is
 * present. Attached to `sourceCode` (rather than `url`) so the message lands
 * next to the field an admin submitting without a URL is most likely to be
 * missing.
 */
function refineUrlOrSourceCode(
  data: { url?: string | null; sourceCode?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (hasText(data.url) || hasText(data.sourceCode)) return

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'Provide a Project URL or upload/paste Source Code — at least one is required.',
    path: ['sourceCode'],
  })
}

// -----------------------------------------------------------------------
// EventSchema
// Validates input for creating or updating a competition event.
// -----------------------------------------------------------------------

/**
 * Accepts a date-only string (YYYY-MM-DD, as sent by HTML `<input type="date">`),
 * a full ISO 8601 datetime string, a `Date` object, `null`, or `undefined`.
 * Normalises everything to `Date | null`.
 */
const dateInputSchema = z
  .union([z.string(), z.date()])
  .optional()
  .nullable()
  .transform((val) => {
    if (val == null || val === '') return null
    if (val instanceof Date) return val
    const parsed = new Date(val)
    if (isNaN(parsed.getTime())) {
      throw new Error('Invalid date')
    }
    return parsed
  })

export const EventSchema = z.object({
  name: z
    .string()
    .min(1, 'Event name is required')
    .max(255, 'Event name must not exceed 255 characters'),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional()
    .nullable(),
  startDate: dateInputSchema,
  endDate: dateInputSchema,
})

/**
 * `EventInput` represents the raw (pre-transform) shape accepted by
 * `EventSchema` — i.e. what callers (forms, actions, services) build and
 * pass in before validation/parsing. `startDate`/`endDate` may be a
 * date-only string, full ISO string, `Date`, `null`, or `undefined` here;
 * `EventSchema.parse()` normalises them to `Date | null` on output.
 */
export type EventInput = z.input<typeof EventSchema>

// -----------------------------------------------------------------------
// CategorySchema
// Validates input for creating or updating a scoring category within an event.
// -----------------------------------------------------------------------

export const CategorySchema = z.object({
  eventId: z.string().min(1, 'Event ID is required'),
  name: z
    .string()
    .min(1, 'Category name is required')
    .max(255, 'Category name must not exceed 255 characters'),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional()
    .nullable(),
})

export type CategoryInput = z.infer<typeof CategorySchema>

// -----------------------------------------------------------------------
// ParameterSchema
// Validates a single scoring parameter definition.
// -----------------------------------------------------------------------

export const ParameterSchema = z.object({
  categoryId: z.string().min(1, 'Category ID is required'),
  name: z
    .string()
    .min(1, 'Parameter name is required')
    .max(255, 'Parameter name must not exceed 255 characters'),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional()
    .nullable(),
  weight: z
    .number()
    .gt(0, 'Weight must be greater than 0%')
    .lte(100, 'Weight must not exceed 100%'),
  minScore: z
    .number()
    .min(0, 'Minimum score must be at least 0'),
  maxScore: z
    .number()
    .min(0, 'Maximum score must be at least 0'),
  scoringMode: z.nativeEnum(ScoringMode).default(ScoringMode.AUTO),
  orderIndex: z.number().int().min(0).default(0),
}).refine(
  (data) => data.maxScore > data.minScore,
  {
    message: 'maxScore must be greater than minScore',
    path: ['maxScore'],
  }
)

export type ParameterInput = z.infer<typeof ParameterSchema>

// -----------------------------------------------------------------------
// ParameterSetSchema
// Validates a full set of parameters for a category.
// Refine: total weight of all parameters must equal 100% within ±0.001 tolerance.
// -----------------------------------------------------------------------

const ParameterItemSchema = z.object({
  name: z
    .string()
    .min(1, 'Parameter name is required')
    .max(255, 'Parameter name must not exceed 255 characters'),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .optional()
    .nullable(),
  weight: z
    .number()
    .gt(0, 'Weight must be greater than 0%')
    .lte(100, 'Weight must not exceed 100%'),
  minScore: z
    .number()
    .min(0, 'Minimum score must be at least 0'),
  maxScore: z
    .number()
    .min(0, 'Maximum score must be at least 0'),
  scoringMode: z.nativeEnum(ScoringMode).default(ScoringMode.AUTO),
  orderIndex: z.number().int().min(0).default(0),
}).refine(
  (data) => data.maxScore > data.minScore,
  {
    message: 'maxScore must be greater than minScore',
    path: ['maxScore'],
  }
)

export const ParameterSetSchema = z
  .array(ParameterItemSchema)
  .min(1, 'At least one parameter is required')
  .superRefine((parameters, ctx) => {
    const totalWeight = parameters.reduce((sum, p) => sum + p.weight, 0)
    if (Math.abs(totalWeight - 100) > 0.001) {
      const diff = (100 - totalWeight).toFixed(3)
      const direction = totalWeight < 100 ? 'increase' : 'decrease'
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Total parameter weight must equal 100%. Current total is ${totalWeight.toFixed(3)}%. Please ${direction} weights by ${Math.abs(Number(diff)).toFixed(3)}%.`,
        path: [],
      })
    }
  })

export type ParameterSetInput = z.infer<typeof ParameterSetSchema>

// -----------------------------------------------------------------------
// SubmissionSchema
// Validates a project submission URL and participant details.
// -----------------------------------------------------------------------

export const SubmissionSchema = z.object({
  /**
   * Optional: a submission may instead rely entirely on pasted/uploaded
   * Source Code, with no live URL to crawl. `refineUrlOrSourceCode` below
   * enforces that at least one of `url`/`sourceCode` is present.
   */
  url: z.string().optional().nullable(),
  participantName: z
    .string()
    .min(1, 'Participant name is required')
    .max(255, 'Participant name must not exceed 255 characters'),
  teamName: z
    .string()
    .max(255, 'Team name must not exceed 255 characters')
    .optional()
    .nullable(),
  sourceCode: z
    .string()
    .max(MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE)
    .optional()
    .nullable(),
  categoryId: z.string().min(1, 'Category ID is required'),
})
  .superRefine(refineProjectUrl)
  .superRefine(refineUrlOrSourceCode)

export type SubmissionInput = z.infer<typeof SubmissionSchema>

// -----------------------------------------------------------------------
// SourceCodeUpdateSchema
// Validates the body of `PATCH /api/submissions/[id]` — the admin editor that
// pastes or corrects a project's Source Code after submission.
// -----------------------------------------------------------------------

export const SourceCodeUpdateSchema = z.object({
  /**
   * Blank input normalises to `null` rather than `''`.
   *
   * Downstream, `hasUsableText` in the scorer and `hasUsableSourceCode` in the
   * crawler both treat a whitespace-only string as "no evidence". Storing `''`
   * would satisfy neither predicate yet still read as a non-null column, so the
   * normalisation happens here — at the only write path that can introduce the
   * value — instead of being re-derived by every reader.
   *
   * The length cap is checked before the trim, so a payload over the limit is
   * rejected on what the admin actually sent.
   */
  sourceCode: z
    .string()
    .max(MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE)
    .nullable()
    .transform((value) => {
      if (value == null) return null
      return value.trim().length > 0 ? value : null
    }),
})

/** Raw body shape accepted by `SourceCodeUpdateSchema` (pre-transform). */
export type SourceCodeUpdateInput = z.input<typeof SourceCodeUpdateSchema>
/** Validated, normalised body — `sourceCode` is `string | null`, never `''`. */
export type SourceCodeUpdateData = z.infer<typeof SourceCodeUpdateSchema>

// -----------------------------------------------------------------------
// JuryScoreSchema
// Validates a jury score submission for a single parameter.
// Score must be within the [minScore, maxScore] range configured per parameter.
// -----------------------------------------------------------------------

export const JuryScoreSchema = z
  .object({
    projectId: z.string().min(1, 'Project ID is required'),
    parameterId: z.string().min(1, 'Parameter ID is required'),
    score: z.number().finite('Score must be a finite number'),
    comment: z
      .string()
      .max(2000, 'Comment must not exceed 2000 characters')
      .optional()
      .nullable(),
    /** Range bounds — resolved from the Parameter record before validation */
    minScore: z.number(),
    maxScore: z.number(),
  })
  .superRefine((data, ctx) => {
    if (data.score < data.minScore || data.score > data.maxScore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Score must be between ${data.minScore} and ${data.maxScore}`,
        path: ['score'],
      })
    }
  })

export type JuryScoreInput = z.infer<typeof JuryScoreSchema>

// -----------------------------------------------------------------------
// CsvRowSchema
// Validates a single row from a bulk CSV import.
// Columns: url, participantName (or participant_name), teamName (or team_name),
//          sourceCode (or source_code), categoryId (or category_id)
// -----------------------------------------------------------------------

export const CsvRowSchema = z.object({
  /**
   * Optional, same as `SubmissionSchema.url` — a row may rely entirely on
   * `source_code` instead. Nullable-but-not-optional for the same `.pipe()`
   * reason as `teamName`/`sourceCode` below: the raw transform always
   * produces `string | null`, never `undefined`.
   */
  url: z.string().nullable(),
  participantName: z
    .string()
    .min(1, 'Participant name is required')
    .max(255, 'Participant name must not exceed 255 characters'),
  /**
   * teamName is nullable. When reading from CSV the raw transform always
   * produces `string | null`, so we do not mark it as `.optional()` here —
   * that keeps the input type as `string | null` and makes `.pipe()` happy.
   */
  teamName: z
    .string()
    .max(255, 'Team name must not exceed 255 characters')
    .nullable(),
  /**
   * Pasted source code, mapped to the nullable `Project.sourceCode` column.
   * Same nullable-but-not-optional treatment as `teamName`: the raw transform
   * always produces `string | null`, and `.pipe()` requires the piped-into
   * input type to match exactly, so `.optional()` must not be added here.
   * A missing `source_code` column arrives as `null`.
   */
  sourceCode: z
    .string()
    .max(MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE)
    .nullable(),
  categoryId: z.string().min(1, 'Category ID is required'),
})
  .superRefine(refineProjectUrl)
  .superRefine(refineUrlOrSourceCode)

export type CsvRowInput = z.infer<typeof CsvRowSchema>

// -----------------------------------------------------------------------
// CsvRowRawSchema
// Handles snake_case column headers from CSV files before normalisation.
// -----------------------------------------------------------------------

export const CsvRowRawSchema = z
  .object({
    url: z.string().optional(),
    participant_name: z.string().optional(),
    participantName: z.string().optional(),
    team_name: z.string().optional().nullable(),
    teamName: z.string().optional().nullable(),
    source_code: z.string().optional().nullable(),
    sourceCode: z.string().optional().nullable(),
    category_id: z.string().optional(),
    categoryId: z.string().optional(),
  })
  .transform((row) => {
    const teamRaw = row.teamName ?? row.team_name
    const sourceRaw = row.sourceCode ?? row.source_code
    const urlRaw = row.url
    return {
      // Blank/absent means "no URL for this row" — same treatment as
      // teamName/sourceCode below, so a row can rely on source_code alone.
      url: urlRaw != null && urlRaw.trim() !== '' ? urlRaw.trim() : null,
      participantName: (row.participantName ?? row.participant_name ?? '').trim(),
      // Ensure teamName is always string | null (never undefined) for CsvRowSchema
      teamName: teamRaw != null && teamRaw.trim() !== '' ? teamRaw.trim() : null,
      // Same for sourceCode — absent column means "no code pasted", i.e. null
      sourceCode: sourceRaw != null && sourceRaw.trim() !== '' ? sourceRaw : null,
      categoryId: (row.categoryId ?? row.category_id ?? '').trim(),
    }
  })
  .pipe(CsvRowSchema)

export type CsvRowRawInput = z.input<typeof CsvRowRawSchema>
