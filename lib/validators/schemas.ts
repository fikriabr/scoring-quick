// lib/validators/schemas.ts

import { z } from 'zod'
import { ScoringMode, ScoringTrack } from '@prisma/client'
import { validateProjectUrl } from './url-rules'
import {
  IDEA_DOC_REQUIRED_MESSAGE,
  IDEA_DOC_TOO_LONG_MESSAGE,
  MAX_IDEA_DOC_LENGTH,
  MAX_SOURCE_CODE_LENGTH,
  SOURCE_CODE_TOO_LONG_MESSAGE,
} from './source-code-rules'
import { MAX_CRITIC_ROUNDS_LIMIT, SCORING_TRACKS } from '@/lib/scoring/tracks'

/**
 * The Source Code length limit and its message now live in
 * `lib/validators/source-code-rules.ts`, a Prisma-free module, because client
 * components need the number for their character counters and this file pulls
 * in the Prisma runtime via `z.nativeEnum`. Re-exported here so callers that
 * already read the limit off the schemas module keep working.
 */
export { MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE, MAX_IDEA_DOC_LENGTH }

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

/**
 * Both files are mandatory: the idea document feeds the IDEA track and the
 * HTML (URL or Source Code) feeds the HTML track. A submission without the
 * idea document would have its IDEA track scored 0, so it is rejected up
 * front instead.
 */
function refineIdeaDocRequired(
  data: { ideaDoc?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (hasText(data.ideaDoc)) return
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: IDEA_DOC_REQUIRED_MESSAGE,
    path: ['ideaDoc'],
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
  track: z.nativeEnum(ScoringTrack).default(ScoringTrack.HTML),
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
// Refine: every track (IDEA, HTML) needs at least one parameter, and each
// track's weights must total 100% within ±0.001 tolerance. The blend between
// the tracks is a category setting (CategoryScoringConfigSchema).
// -----------------------------------------------------------------------

const ParameterItemSchema = z.object({
  /** Id of an existing parameter being kept; absent for a new row. */
  id: z.string().min(1).optional().nullable(),
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
  track: z.nativeEnum(ScoringTrack).default(ScoringTrack.HTML),
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
    for (const track of SCORING_TRACKS) {
      const inTrack = parameters.filter((p) => p.track === track)
      if (inTrack.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `The ${track} track needs at least one parameter — both files are scored.`,
          path: [],
        })
        continue
      }
      const totalWeight = inTrack.reduce((sum, p) => sum + p.weight, 0)
      if (Math.abs(totalWeight - 100) > 0.001) {
        const diff = (100 - totalWeight).toFixed(3)
        const direction = totalWeight < 100 ? 'increase' : 'decrease'
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Total ${track} parameter weight must equal 100%. Current total is ${totalWeight.toFixed(3)}%. Please ${direction} weights by ${Math.abs(Number(diff)).toFixed(3)}%.`,
          path: [],
        })
      }
    }
  })

export type ParameterSetInput = z.input<typeof ParameterSetSchema>

// -----------------------------------------------------------------------
// CategoryScoringConfigSchema
// How the two track scores are blended, and how the critic agent behaves.
// -----------------------------------------------------------------------

export const CategoryScoringConfigSchema = z
  .object({
    ideaWeight: z.number().min(0, 'Idea weight must be at least 0%').max(100),
    htmlWeight: z.number().min(0, 'HTML weight must be at least 0%').max(100),
    criticEnabled: z.boolean().default(true),
    maxCriticRounds: z
      .number()
      .int()
      .min(0, 'Max critic rounds must be at least 0')
      .max(
        MAX_CRITIC_ROUNDS_LIMIT,
        `Max critic rounds must not exceed ${MAX_CRITIC_ROUNDS_LIMIT}`,
      )
      .default(2),
  })
  .superRefine((data, ctx) => {
    const total = data.ideaWeight + data.htmlWeight
    if (Math.abs(total - 100) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Idea weight + HTML weight must equal 100%. Current total is ${total.toFixed(1)}%.`,
        path: ['htmlWeight'],
      })
    }
  })

export type CategoryScoringConfigInput = z.input<typeof CategoryScoringConfigSchema>
export type CategoryScoringConfig = z.infer<typeof CategoryScoringConfigSchema>

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
  /** Idea document (markdown) — required, evidence for the IDEA track. */
  ideaDoc: z
    .string()
    .max(MAX_IDEA_DOC_LENGTH, IDEA_DOC_TOO_LONG_MESSAGE)
    .optional()
    .nullable(),
  categoryId: z.string().min(1, 'Category ID is required'),
})
  .superRefine(refineProjectUrl)
  .superRefine(refineUrlOrSourceCode)
  .superRefine(refineIdeaDocRequired)

export type SubmissionInput = z.infer<typeof SubmissionSchema>

// -----------------------------------------------------------------------
// EvidenceUpdateSchema
// Validates the body of `PATCH /api/submissions/[id]` — the admin editors that
// paste or correct a project's HTML Source Code and/or idea document after
// submission. At least one of the two keys must be present.
// -----------------------------------------------------------------------

/**
 * Blank input normalises to `null` rather than `''`: downstream readers treat
 * a whitespace-only string as "no evidence", and storing `''` would satisfy
 * neither predicate yet still read as a non-null column. The length cap is
 * checked before the trim, so a payload over the limit is rejected on what the
 * admin actually sent.
 */
function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return value.trim().length > 0 ? value : null
}

export const EvidenceUpdateSchema = z
  .object({
    sourceCode: z
      .string()
      .max(MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE)
      .nullable()
      .optional()
      .transform(blankToNull),
    ideaDoc: z
      .string()
      .max(MAX_IDEA_DOC_LENGTH, IDEA_DOC_TOO_LONG_MESSAGE)
      .nullable()
      .optional()
      .transform(blankToNull),
  })
  .superRefine((data, ctx) => {
    if (data.sourceCode === undefined && data.ideaDoc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide sourceCode and/or ideaDoc to update.',
        path: [],
      })
    }
  })

/** Kept for existing callers — the Source Code editor sends only `sourceCode`. */
export const SourceCodeUpdateSchema = EvidenceUpdateSchema

/** Raw body shape accepted by `EvidenceUpdateSchema` (pre-transform). */
export type EvidenceUpdateInput = z.input<typeof EvidenceUpdateSchema>
export type SourceCodeUpdateInput = EvidenceUpdateInput
/** Validated, normalised body — values are `string | null | undefined`, never `''`. */
export type EvidenceUpdateData = z.infer<typeof EvidenceUpdateSchema>
export type SourceCodeUpdateData = EvidenceUpdateData

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
//          sourceCode (or source_code), ideaDoc (or idea_doc),
//          categoryId (or category_id)
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
  /** Idea document (markdown). Nullable-but-not-optional, same as above. */
  ideaDoc: z
    .string()
    .max(MAX_IDEA_DOC_LENGTH, IDEA_DOC_TOO_LONG_MESSAGE)
    .nullable(),
  categoryId: z.string().min(1, 'Category ID is required'),
})
  .superRefine(refineProjectUrl)
  .superRefine(refineUrlOrSourceCode)
  .superRefine(refineIdeaDocRequired)

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
    idea_doc: z.string().optional().nullable(),
    ideaDoc: z.string().optional().nullable(),
    category_id: z.string().optional(),
    categoryId: z.string().optional(),
  })
  .transform((row) => {
    const teamRaw = row.teamName ?? row.team_name
    const sourceRaw = row.sourceCode ?? row.source_code
    const ideaRaw = row.ideaDoc ?? row.idea_doc
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
      ideaDoc: ideaRaw != null && ideaRaw.trim() !== '' ? ideaRaw : null,
      categoryId: (row.categoryId ?? row.category_id ?? '').trim(),
    }
  })
  .pipe(CsvRowSchema)

export type CsvRowRawInput = z.input<typeof CsvRowRawSchema>
