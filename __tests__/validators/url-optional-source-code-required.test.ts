/**
 * Unit Tests: Project URL is optional, but Source Code is required in its
 * absence.
 *
 * A project may be submitted either with a live URL (crawled by the pipeline)
 * or with Source Code pasted/uploaded directly, or both — but not neither.
 * `SubmissionSchema` and `CsvRowSchema` both enforce this via
 * `refineUrlOrSourceCode`, attaching the error to `sourceCode`.
 */

import { describe, it, expect } from 'vitest'
import { ZodError } from 'zod'
import {
  SubmissionSchema,
  CsvRowRawSchema,
} from '@/lib/validators/schemas'

function firstIssuePath(error: ZodError): string {
  return String(error.issues[0]?.path.join('.'))
}

describe('SubmissionSchema — URL optional, Source Code required in its absence', () => {
  const base = {
    participantName: 'Test Participant',
    categoryId: 'cat-1',
    ideaDoc: '# Idea',
  }

  it('accepts a URL with no Source Code', () => {
    const result = SubmissionSchema.parse({
      ...base,
      url: 'https://example.com/project',
    })
    expect(result.url).toBe('https://example.com/project')
    expect(result.sourceCode ?? null).toBeNull()
  })

  it('accepts Source Code with no URL', () => {
    const result = SubmissionSchema.parse({
      ...base,
      sourceCode: '<html><body>Hi</body></html>',
    })
    expect(result.url ?? null).toBeNull()
    expect(result.sourceCode).toBe('<html><body>Hi</body></html>')
  })

  it('accepts both URL and Source Code together', () => {
    const result = SubmissionSchema.parse({
      ...base,
      url: 'https://example.com/project',
      sourceCode: '<html></html>',
    })
    expect(result.url).toBe('https://example.com/project')
    expect(result.sourceCode).toBe('<html></html>')
  })

  it('rejects when both URL and Source Code are absent', () => {
    expect(() => SubmissionSchema.parse({ ...base })).toThrow(ZodError)

    try {
      SubmissionSchema.parse({ ...base })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError)
      expect(firstIssuePath(e as ZodError)).toBe('sourceCode')
    }
  })

  it('rejects when both URL and Source Code are blank/whitespace', () => {
    expect(() =>
      SubmissionSchema.parse({ ...base, url: '   ', sourceCode: '   ' }),
    ).toThrow(ZodError)
  })
})

describe('CsvRowRawSchema — same URL-or-Source-Code rule per row', () => {
  const base = {
    participant_name: 'Test Participant',
    categoryId: 'cat-1',
    idea_doc: '# Idea',
  }

  it('accepts a row with url but no source_code', () => {
    const result = CsvRowRawSchema.parse({
      ...base,
      url: 'https://example.com/project',
    })
    expect(result.url).toBe('https://example.com/project')
    expect(result.sourceCode).toBeNull()
  })

  it('accepts a row with source_code but no url', () => {
    const result = CsvRowRawSchema.parse({
      ...base,
      source_code: '<html></html>',
    })
    expect(result.url).toBeNull()
    expect(result.sourceCode).toBe('<html></html>')
  })

  it('rejects a row with neither url nor source_code', () => {
    expect(() => CsvRowRawSchema.parse({ ...base })).toThrow(ZodError)
  })
})

describe('Idea document (markdown) is required on every submission', () => {
  const html = { url: 'https://example.com/project', sourceCode: '<html></html>' }

  it('SubmissionSchema rejects a missing idea document, on the ideaDoc path', () => {
    const result = SubmissionSchema.safeParse({
      ...html,
      participantName: 'P',
      categoryId: 'cat-1',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((i) => i.path.join('.') === 'ideaDoc')).toBe(true)
  })

  it('SubmissionSchema rejects a whitespace-only idea document', () => {
    const result = SubmissionSchema.safeParse({
      ...html,
      participantName: 'P',
      categoryId: 'cat-1',
      ideaDoc: '   \n  ',
    })
    expect(result.success).toBe(false)
  })

  it('CsvRowRawSchema reads the idea_doc column and requires it', () => {
    const ok = CsvRowRawSchema.parse({
      participant_name: 'P',
      categoryId: 'cat-1',
      url: html.url,
      idea_doc: '# My idea',
    })
    expect(ok.ideaDoc).toBe('# My idea')

    expect(() =>
      CsvRowRawSchema.parse({ participant_name: 'P', categoryId: 'cat-1', url: html.url }),
    ).toThrow(ZodError)
  })
})
