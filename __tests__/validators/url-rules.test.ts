/**
 * Unit tests for the shared URL rule module.
 */

import { describe, it, expect } from 'vitest'
import { validateProjectUrl } from '@/lib/validators/url-rules'

describe('validateProjectUrl', () => {
  it.each(['https://google.com', 'http://example.dev/index.html', 'https://partyrock.aws/app'])(
    'accepts any host: %s',
    (url) => {
      expect(validateProjectUrl(url)).toEqual({ ok: true })
    },
  )

  it('rejects a non-web scheme', () => {
    expect(validateProjectUrl('ftp://example.com/file.html')).toEqual({
      ok: false,
      message: 'URL must use http or https',
    })
  })
})

describe('validateProjectUrl — unparseable input', () => {
  it.each(['', 'not-a-url', 'partyrock.aws', '//partyrock.aws/app', 'http://'])(
    'rejects %s',
    (url) => {
      expect(validateProjectUrl(url)).toEqual({
        ok: false,
        message: 'URL must be a valid URL',
      })
    },
  )
})
