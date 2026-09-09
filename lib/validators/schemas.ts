// lib/validators/schemas.ts

import { z } from 'zod'
import { ProjectType, ScoringMode } from '@prisma/client'
import { isPartyRockHost, validateProjectUrl } from './url-rules'
import {
  MAX_SOURCE_CODE_LENGTH,
  SOURCE_CODE_TOO_LONG_MESSAGE,
} from './source-code-rules'

// -----------------------------------------------------------------------
// Shared URL rule
// The hostname rule used to be duplicated in SubmissionSchema, CsvRowSchema
// and CaptureSchema. All three now delegate to lib/validators/url-rules.ts,
// which is also what the client-side form validation uses.
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
// -----------------------------------------------------------------------

/**
 * The `projectType` field shared by the submission schemas. Defaulting to
 * `PARTYROCK` keeps every existing caller — API clients, forms, CSV imports —
 * working without sending the field, and matches the Prisma column default so
 * records written before this feature stay valid.
 * Requirements: 1.2, 8.1
 */
const projectTypeField = z.nativeEnum(ProjectType).default(ProjectType.PARTYROCK)

/**
 * The Source Code length limit and its message now live in
 * `lib/validators/source-code-rules.ts`, a Prisma-free module, because client
 * components need the number for their character counters and this file pulls
 * in the Prisma runtime via `z.nativeEnum`. Re-exported here so callers that
 * already read the limit off the schemas module keep working.
 * Requirements: 5.3
 */
export { MAX_SOURCE_CODE_LENGTH, SOURCE_CODE_TOO_LONG_MESSAGE }

/**
 * Object-level URL check for submission payloads.
 *
 * This has to live on the object rather than the `url` field itself: the rule
 * depends on the sibling `projectType`, which a field-level refinement cannot
 * see. `superRefine` (rather than `refine`) is used so the specific reason —
 * unparseable, wrong scheme, or wrong host — reaches the caller instead of one
 * catch-all message, and `path: ['url']` keeps the issue attached to the field
 * the admin has to fix.
 *
 * A non-string or empty `url`, or an unrecognised `projectType`, has already
 * produced its own field-level issue, so this check stays quiet rather than
 * adding a second, less specific one.
 */
function refineProjectUrl(
  data: { url: string; projectType: ProjectType },
  ctx: z.RefinementCtx,
): void {
  if (typeof data.url !== 'string' || data.url.length === 0) return
  if (data.projectType == null) return

  const result = validateProjectUrl(data.url, data.projectType)
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.message,
      path: ['url'],
    })
  }
}

// -----------------------------------------------------------------------
// EventSchema
// Validates input for creating or updating a competition event.
// Requirements: 1.2, 1.4, 9.3
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
// Requirements: 1.3, 1.4, 9.3
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
// Requirements: 2.1, 2.2, 2.3, 9.3
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
// Requirements: 2.2, 2.3, 9.3
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
// The URL rule depends on projectType: PARTYROCK submissions are restricted to
// the partyrock.aws domain, HTML submissions accept any hostname.
// Requirements: 2.1, 2.2, 2.4, 3.1, 3.2, 9.3
// -----------------------------------------------------------------------

export const SubmissionSchema = z.object({
  /** Placed first because it decides which URL rule applies below. */
  projectType: projectTypeField,
  url: z.string().min(1, 'URL is required'),
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
}).superRefine(refineProjectUrl)

/**
 * Validated submission data. This is the *output* type, so `projectType` is
 * always present here even when the caller omitted it. Callers that build a
 * payload before parsing should use `z.input<typeof SubmissionSchema>` instead,
 * where `projectType` is optional.
 */
export type SubmissionInput = z.infer<typeof SubmissionSchema>

// -----------------------------------------------------------------------
// SourceCodeUpdateSchema
// Validates the body of `PATCH /api/submissions/[id]` — the admin editor that
// pastes or corrects a project's Source Code after submission.
//
// Applies to both project types: an HTML project whose URL cannot be fetched
// needs pasted markup to be scoreable at all, and a PartyRock project can
// still carry hand-collected evidence.
// Requirements: 5.2, 5.3
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
// Requirements: 6.3, 6.4, 9.3
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
// Requirements: 2.1, 2.2, 2.4, 3.4, 3.5, 9.3
// -----------------------------------------------------------------------

export const CsvRowSchema = z.object({
  /**
   * Optional on input with a `PARTYROCK` default, which is what lets
   * `CsvRowRawSchema` keep piping into this schema without yet forwarding a
   * project type of its own (that arrives with the CSV header aliases).
   */
  projectType: projectTypeField,
  url: z.string().min(1, 'URL is required'),
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
}).superRefine(refineProjectUrl)

/**
 * Validated CSV row data — the *output* type, so `projectType` is always
 * present (defaulted to `PARTYROCK` when the column is absent).
 */
export type CsvRowInput = z.infer<typeof CsvRowSchema>

// -----------------------------------------------------------------------
// CsvRowRawSchema
// Handles snake_case column headers from CSV files before normalisation.
// Requirements: 3.4, 3.5
// -----------------------------------------------------------------------

export const CsvRowRawSchema = z
  .object({
    url: z.string().min(1, 'URL is required'),
    participant_name: z.string().optional(),
    participantName: z.string().optional(),
    team_name: z.string().optional().nullable(),
    teamName: z.string().optional().nullable(),
    source_code: z.string().optional().nullable(),
    sourceCode: z.string().optional().nullable(),
    category_id: z.string().optional(),
    categoryId: z.string().optional(),
    /**
     * Accepted as a free-form string, not as the enum, because the cell comes
     * from a hand-edited spreadsheet: it needs trimming and case folding before
     * it can be matched against the enum, and rejecting `html` here would
     * produce a confusing error for a value the admin clearly meant.
     * Requirements: 1.5
     */
    project_type: z.string().optional().nullable(),
    projectType: z.string().optional().nullable(),
  })
  .transform((row) => {
    const teamRaw = row.teamName ?? row.team_name
    const sourceRaw = row.sourceCode ?? row.source_code
    const projectTypeRaw = row.projectType ?? row.project_type
    const projectTypeNormalised = projectTypeRaw?.trim().toUpperCase()
    return {
      url: row.url,
      participantName: (row.participantName ?? row.participant_name ?? '').trim(),
      // Ensure teamName is always string | null (never undefined) for CsvRowSchema
      teamName: teamRaw != null && teamRaw.trim() !== '' ? teamRaw.trim() : null,
      // Same for sourceCode — absent column means "no code pasted", i.e. null
      sourceCode: sourceRaw != null && sourceRaw.trim() !== '' ? sourceRaw : null,
      categoryId: (row.categoryId ?? row.category_id ?? '').trim(),
      /**
       * An absent column, a `null`, or a blank/whitespace cell must leave the
       * key off entirely so `CsvRowSchema`'s `PARTYROCK` default applies —
       * passing `''` through would instead fail the enum check and reject the
       * row.
       *
       * Spread conditionally rather than assigning `undefined`: an explicit
       * `projectType: undefined` types the key as *required* (present, possibly
       * undefined), which `.pipe(CsvRowSchema)` rejects because the target's
       * input has it optional. The spread keeps the key optional.
       *
       * The cast is needed because `z.nativeEnum` types its input as the enum,
       * while the CSV only ever gives us a string. It is safe: an unrecognised
       * value is still rejected downstream by the enum check, which is exactly
       * the per-row rejection Requirement 1.6 asks for.
       */
      ...(projectTypeNormalised
        ? { projectType: projectTypeNormalised as ProjectType }
        : {}),
    }
  })
  .pipe(CsvRowSchema)

export type CsvRowRawInput = z.input<typeof CsvRowRawSchema>

// -----------------------------------------------------------------------
// CaptureSchema
// Validates a manual capture payload produced by `public/partyrock-capture.js`
// and posted to `POST /api/capture`.
//
// This is the replacement for headless crawling of widget/prompt data:
// AWS WAF blocks PartyRock's internal `getLatestAppVersion` API for
// automated browsers, so widgets and prompts are collected from a real,
// human-driven browser session instead. See docs/CAPTURE.md.
// Requirements: 4.2, 4.5, 9.3
// -----------------------------------------------------------------------

export const CaptureWidgetSchema = z.object({
  type: z.string().max(200).default('unknown'),
  label: z.string().max(500).default(''),
})

export const CaptureSchema = z.object({
  /**
   * The PartyRock app URL that was open in the browser when captured.
   * Always host-restricted regardless of project type — the capture pipeline
   * only exists for PartyRock (Requirement 2.6).
   */
  url: z
    .string()
    .min(1, 'URL is required')
    .refine(
      (url) => {
        try {
          return isPartyRockHost(new URL(url).hostname)
        } catch {
          return false
        }
      },
      { message: 'URL must be a valid PartyRock URL (domain: partyrock.aws)' },
    ),
  title: z.string().max(1000).optional().nullable(),
  description: z.string().max(5000).optional().nullable(),
  widgets: z.array(CaptureWidgetSchema).max(500).default([]),
  prompts: z.array(z.string().max(20000)).max(500).default([]),
  /** Text the app's AI widgets actually generated, if the human triggered them. */
  outputs: z.array(z.string().max(20000)).max(500).default([]),
  /**
   * Raw app-definition JSON observed on the page's own network traffic.
   * Free-form because PartyRock's internal response shape is not a contract.
   */
  appDefinition: z.unknown().optional().nullable(),
  /** Where the data came from — useful when debugging a thin capture. */
  source: z.enum(['network', 'dom', 'mixed', 'manual']).default('mixed'),
  capturedAt: z.string().max(100).optional().nullable(),
  /** Restrict matching to a single category; otherwise every match is updated. */
  categoryId: z.string().max(100).optional().nullable(),
})

export type CaptureInput = z.input<typeof CaptureSchema>
export type CaptureData = z.infer<typeof CaptureSchema>
