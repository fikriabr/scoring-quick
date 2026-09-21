// lib/services/ai/evidence.ts
// Renders the evidence each track's agents are allowed to see.
//
// Isolation is the first line of defence against cross-file bias: the IDEA
// agents only ever receive the markdown document, and the HTML agents only
// ever receive the page (structure metrics, markup, URL). Neither prompt
// contains the other file, so a beautiful page cannot lift the idea score and
// a brilliant idea cannot lift the markup score. The critic then audits what
// is left (length, formatting, "sounds impressive", off-parameter reasoning).

import { parse } from 'node-html-parser'
import { formatStructureForPrompt } from '@/lib/services/html-structure.service'
import type { HtmlStructure } from '@/types'
import type { ScoringTrack } from '@/lib/scoring/tracks'

/**
 * Total character budget for the HTML evidence — the structure summary and
 * the markup excerpt combined. The structure summary is bounded (≤2500 chars)
 * and is the most informative evidence, so it is rendered in full first and
 * the markup gets what is left.
 */
export const HTML_EVIDENCE_CHAR_BUDGET = 20000

/**
 * Share of the HTML budget reserved for the page's visible text. Content
 * parameters (clarity, tone, accuracy…) are judged from this block; without
 * it the text is buried in markup and CSS, and the model ends up citing
 * stylesheets as evidence of "clarity".
 */
export const HTML_VISIBLE_TEXT_CHAR_BUDGET = 6000

/** Budget for the idea document. Markdown is dense prose, so it gets more. */
export const IDEA_EVIDENCE_CHAR_BUDGET = 30000

/**
 * Appended when an excerpt is cut, so the model reads it as an excerpt rather
 * than as a complete document (and does not penalise a missing ending).
 */
export const TRUNCATION_MARKER = '\n... [truncated]'

const HTML_STRUCTURE_UNAVAILABLE_NOTICE =
  '(HTML structure unavailable — the markup could not be retrieved or parsed. Judge from the source excerpt below.)'

const HTML_SOURCE_UNAVAILABLE_NOTICE = '(no HTML source provided)'

export interface IdeaEvidence {
  track: 'IDEA'
  ideaDoc: string
}

export interface HtmlEvidence {
  track: 'HTML'
  url: string | null
  sourceCode: string | null
  structure: HtmlStructure | null
}

export type TrackEvidence = IdeaEvidence | HtmlEvidence

export function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text
  const keep = budget - TRUNCATION_MARKER.length
  return keep > 0 ? text.slice(0, keep) + TRUNCATION_MARKER : ''
}

/**
 * Renders the markup block within whatever budget the structure summary left
 * behind. An empty result is correct when the allowance is exhausted — the
 * alternative would be truncating the structure summary.
 */
function renderMarkupExcerpt(sourceCode: string | null, budget: number): string {
  if (!sourceCode) {
    return budget >= HTML_SOURCE_UNAVAILABLE_NOTICE.length
      ? HTML_SOURCE_UNAVAILABLE_NOTICE
      : ''
  }
  return truncate(sourceCode, budget)
}

/**
 * The text a visitor actually reads: scripts, styles and templates removed,
 * one line per block. Returns '' when the markup cannot be parsed.
 */
export function extractVisibleText(html: string | null): string {
  if (!html) return ''
  try {
    const root = parse(html)
    root.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove())
    const body = root.querySelector('body') ?? root
    return body.structuredText
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

export function renderEvidence(evidence: TrackEvidence): string {
  if (evidence.track === 'IDEA') {
    return `## Idea Document (markdown)
<<<IDEA_DOCUMENT
${truncate(evidence.ideaDoc, IDEA_EVIDENCE_CHAR_BUDGET)}
IDEA_DOCUMENT>>>`
  }

  const structureSection = evidence.structure
    ? formatStructureForPrompt(evidence.structure)
    : HTML_STRUCTURE_UNAVAILABLE_NOTICE
  const visibleText =
    truncate(extractVisibleText(evidence.sourceCode), HTML_VISIBLE_TEXT_CHAR_BUDGET) ||
    '(no visible text could be extracted)'
  const remaining = Math.max(
    0,
    HTML_EVIDENCE_CHAR_BUDGET - structureSection.length - visibleText.length,
  )

  return `## Page URL
${evidence.url ?? '(no url)'}

## HTML Structure (computed metrics — evidence for structure/accessibility/code parameters)
${structureSection}

## Visible Text (what a visitor reads — evidence for content, clarity and tone parameters)
<<<VISIBLE_TEXT
${visibleText}
VISIBLE_TEXT>>>

## HTML Source (excerpt)
<<<HTML_SOURCE
${renderMarkupExcerpt(evidence.sourceCode, remaining)}
HTML_SOURCE>>>`
}

/** What the agents of each track judge — and explicitly what they must ignore. */
export const TRACK_BRIEF: Record<ScoringTrack, { subject: string; ignore: string[] }> = {
  IDEA: {
    subject:
      "the participant's IDEA as written in their markdown idea document: the problem, the proposed solution, its originality, feasibility and impact",
    ignore: [
      'Document length — a short document with a strong idea can score high; padding and repetition earn nothing.',
      'Markdown formatting, headings, tables, emojis and visual neatness of the document.',
      'Buzzwords, hype and confident tone that are not backed by concrete substance.',
      'Anything about a website, UI or implementation that is not in the document — you have not seen the page and must not guess about it.',
    ],
  },
  HTML: {
    subject:
      "the participant's HTML page. What aspect of the page is judged — its markup/engineering, or the content a visitor reads — is set by each parameter's own criterion",
    ignore: [
      'How good or important the underlying idea/topic of the page is — that is judged separately from the idea document.',
      'Visual attractiveness implied by colours, gradients, animations, images or fancy CSS, unless the parameter explicitly measures visual design.',
      'Marketing copy and claims on the page about how innovative the product is.',
      'Sheer size: more elements or more sections is not better by itself.',
    ],
  },
}
