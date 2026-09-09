// types/index.ts

import type {
  CrawlStatus,
  ScoreStatus,
  ScoringMode,
} from '@prisma/client'

// -----------------------------------------------------------------------
// Crawler Types
// -----------------------------------------------------------------------

export interface WidgetInfo {
  type: string
  label: string
}

// -----------------------------------------------------------------------
// HTML Structure Types
// -----------------------------------------------------------------------

export interface HeadingInfo {
  level: number
  text: string
}

/**
 * Metrik struktur hasil `parseHtmlStructure` (lib/services/html-structure.service.ts).
 * Disimpan pada `CrawlMetadata.structure` supaya tidak dihitung ulang tiap scoring.
 */
export interface HtmlStructure {
  // Hierarki heading
  headings: HeadingInfo[]
  headingCount: number
  hasSingleH1: boolean
  /** Tidak ada level heading yang dilompati */
  headingHierarchyValid: boolean

  // Semantik
  /** header, nav, main, article, section, aside, footer */
  semanticElementCount: number
  /** div, span */
  genericElementCount: number
  /** semantic / (semantic + generic) */
  semanticRatio: number

  // Landmark & ARIA
  landmarks: string[]
  ariaAttributeCount: number
  hasSkipLink: boolean

  // Aksesibilitas
  imageCount: number
  imagesWithAlt: number
  altTextRatio: number
  formFieldCount: number
  labelledFormFields: number
  formLabelRatio: number

  // Kompleksitas dokumen
  totalElementCount: number
  maxDomDepth: number
  scriptCount: number
  inlineStyleCount: number
  externalStylesheetCount: number

  // Metadata dokumen
  documentTitle: string | null
  metaDescription: string | null
  langAttribute: string | null
  hasViewportMeta: boolean
}

// -----------------------------------------------------------------------
// Project Metadata (input scorer)
// -----------------------------------------------------------------------

/**
 * Tipe input scorer untuk project.
 */
export interface ProjectMetadata {
  title: string | null
  description: string | null
  widgets: WidgetInfo[]
  prompts: string[]
  widgetCount: number
  sourceCode?: string | null
  structure?: HtmlStructure | null
  /** URL project, dipakai oleh prompt sebagai context tambahan. */
  url?: string | null
}

// -----------------------------------------------------------------------
// Scoring Types
// -----------------------------------------------------------------------

export interface ScoringParameter {
  id: string
  name: string
  description: string | null
  weight: number
  minScore: number
  maxScore: number
  scoringMode: ScoringMode
}

export interface ScoringResult {
  score: number
  reasoning: string
  /** True when the raw Gemini value was out of range and was clamped */
  clamped?: boolean
}

// -----------------------------------------------------------------------
// Leaderboard / Report Types
// -----------------------------------------------------------------------

export interface ParameterScore {
  parameterId: string
  parameterName: string
  weight: number
  aiScore: number | null
  aiReasoning: string | null
  juryScore: number | null
  juryComment: string | null
  finalScore: number | null
}

export interface ProjectWithScores {
  id: string
  categoryId: string
  url: string
  participantName: string
  teamName: string | null
  crawlStatus: CrawlStatus
  scoreStatus: ScoreStatus
  finalScore: number | null
  createdAt: Date
  aiScores: Array<{ parameterId: string; score: number; reasoning: string }>
  juryScores: Array<{
    parameterId: string
    juryId: string
    score: number
    comment: string | null
  }>
  parameterScores?: ParameterScore[]
  rank?: number
}

// -----------------------------------------------------------------------
// API Error Type
// -----------------------------------------------------------------------

export interface ApiError {
  error: string
  message: string
  code: string
}
