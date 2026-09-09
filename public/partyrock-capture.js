/*
 * public/partyrock-capture.js
 *
 * Runs INSIDE a partyrock.aws app page and collects the app's structure —
 * widgets, prompts, and any AI output the human triggered — then hands it to
 * the scoring app.
 *
 * Why this exists
 * ---------------
 * AWS WAF blocks PartyRock's internal `getLatestAppVersion` API whenever the
 * request looks automated, so a headless crawler can never see widget data.
 * This script does not call that API. It only observes the responses the page
 * requests for itself, in a real logged-in session, plus what is already
 * rendered in the DOM. The human clicking widgets to trigger generation is
 * both the point (only a human can judge which widget to click on an unseen
 * app) and the reason the session looks legitimate.
 *
 * Two ways to run it
 * ------------------
 * 1. Driven by `scripts/partyrock-navigate.js` (normal path). The navigator
 *    injects this file before the page loads, so the network hooks are in
 *    place from the first request, then reads `window.__partyRockCapture()`
 *    and posts the result from Node — no CORS involved.
 *
 * 2. Standalone. Paste the file into DevTools console, or load it as a
 *    bookmarklet, on an app page. The panel's Send button then posts to
 *    `/api/capture` directly, which is why that route allows CORS from the
 *    partyrock.aws origin.
 *
 * Configure before load (optional):
 *   window.__PR_CAPTURE_CONFIG = {
 *     apiUrl: 'http://localhost:3000/api/capture',
 *     token: '<CAPTURE_TOKEN>',
 *     postFromPage: true,   // false when Node does the posting
 *   }
 */
;(function () {
  'use strict'

  // Injected once per page; a re-injection should not re-wrap fetch.
  if (window.__PR_CAPTURE_INSTALLED) {
    if (typeof window.__prCaptureShowPanel === 'function') window.__prCaptureShowPanel()
    return
  }
  window.__PR_CAPTURE_INSTALLED = true

  var CONFIG = Object.assign(
    {
      apiUrl: 'http://localhost:3000/api/capture',
      token: '',
      postFromPage: true,
    },
    window.__PR_CAPTURE_CONFIG || {},
  )

  /**
   * Signal read by the Playwright navigator to know the human is done with
   * this page: '' (still working), 'sent', or 'skipped'.
   */
  window.__PR_CAPTURE_STATE = ''

  // ---------------------------------------------------------------------
  // Network observation
  //
  // PartyRock is a React Router SPA: the app definition arrives as JSON on
  // the page's own XHR/fetch traffic. Wrapping both transports lets us read
  // that JSON without issuing a single extra request.
  // ---------------------------------------------------------------------

  /** Raw JSON bodies seen so far, newest last. Capped to bound memory. */
  var observedPayloads = []
  var MAX_PAYLOADS = 40

  function recordPayload(url, text) {
    if (!text || text.length > 2000000) return
    var trimmed = text.trim()
    if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return
    var parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      return
    }
    observedPayloads.push({ url: String(url || ''), body: parsed })
    if (observedPayloads.length > MAX_PAYLOADS) observedPayloads.shift()
    scheduleRefresh()
  }

  /**
   * Feed an already-parsed JSON body in from outside the page.
   *
   * The Playwright navigator also watches responses at the browser level,
   * which catches traffic the in-page hooks cannot see (service worker,
   * navigation preloads). Pushing it back in here means the extraction
   * walkers exist in exactly one place.
   */
  window.__prCaptureIngest = function (url, body) {
    if (body === null || typeof body !== 'object') return
    observedPayloads.push({ url: String(url || ''), body: body })
    if (observedPayloads.length > MAX_PAYLOADS) observedPayloads.shift()
    scheduleRefresh()
  }

  var originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      var args = arguments
      var requestUrl = ''
      try {
        requestUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
      } catch (e) {
        /* ignore */
      }
      return originalFetch.apply(this, args).then(function (response) {
        // Read from a clone so the page still consumes its own body.
        try {
          response
            .clone()
            .text()
            .then(function (text) {
              recordPayload(requestUrl, text)
            })
            .catch(function () {})
        } catch (e) {
          /* ignore */
        }
        return response
      })
    }
  }

  var OriginalXHR = window.XMLHttpRequest
  if (typeof OriginalXHR === 'function') {
    var originalOpen = OriginalXHR.prototype.open
    var originalSend = OriginalXHR.prototype.send
    OriginalXHR.prototype.open = function (method, url) {
      this.__prCaptureUrl = url
      return originalOpen.apply(this, arguments)
    }
    OriginalXHR.prototype.send = function () {
      var xhr = this
      xhr.addEventListener('load', function () {
        try {
          if (typeof xhr.responseText === 'string') {
            recordPayload(xhr.__prCaptureUrl, xhr.responseText)
          }
        } catch (e) {
          /* responseType may not be text — ignore */
        }
      })
      return originalSend.apply(this, arguments)
    }
  }

  // ---------------------------------------------------------------------
  // Extraction from observed JSON
  //
  // PartyRock's internal response shape is not a public contract, so nothing
  // here hard-codes a field path. Both walkers look for *shapes* instead:
  // objects that look like a widget, and string fields that look like a
  // prompt. That survives a rename on Amazon's side.
  // ---------------------------------------------------------------------

  var WIDGET_TYPE_KEYS = ['type', 'widgetType', 'kind', 'componentType']
  var WIDGET_LABEL_KEYS = ['title', 'name', 'label', 'displayName', 'heading']
  var PROMPT_KEY_PATTERN = /prompt|template|instruction|systemMessage/i
  var MAX_WALK_NODES = 20000

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function firstStringKey(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return null
  }

  /** Does this object look like a widget definition? */
  function looksLikeWidget(obj) {
    if (!isPlainObject(obj)) return false
    var type = firstStringKey(obj, WIDGET_TYPE_KEYS)
    if (!type) return false
    // A bare {type: 'string'} appears all over JSON schemas; require some
    // additional widget-ish evidence before believing it.
    var hasLabel = firstStringKey(obj, WIDGET_LABEL_KEYS) !== null
    var hasPrompt = Object.keys(obj).some(function (k) {
      return PROMPT_KEY_PATTERN.test(k) && typeof obj[k] === 'string'
    })
    return hasLabel || hasPrompt
  }

  /**
   * Walk an arbitrary JSON tree, collecting widget-shaped objects and
   * prompt-shaped strings. Depth- and node-limited so a pathological payload
   * cannot hang the page.
   */
  function walkJson(root, onWidget, onPrompt) {
    var stack = [{ node: root, depth: 0 }]
    var visited = 0
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null

    while (stack.length > 0 && visited < MAX_WALK_NODES) {
      var frame = stack.pop()
      var node = frame.node
      if (node === null || typeof node !== 'object' || frame.depth > 30) continue
      if (seen) {
        if (seen.has(node)) continue
        seen.add(node)
      }
      visited++

      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          stack.push({ node: node[i], depth: frame.depth + 1 })
        }
        continue
      }

      if (looksLikeWidget(node)) onWidget(node)

      var keys = Object.keys(node)
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k]
        var value = node[key]
        if (typeof value === 'string') {
          if (PROMPT_KEY_PATTERN.test(key) && value.trim().length > 2) {
            onPrompt(value.trim())
          }
        } else if (value && typeof value === 'object') {
          stack.push({ node: value, depth: frame.depth + 1 })
        }
      }
    }
  }

  function extractFromNetwork() {
    var widgets = []
    var prompts = []

    for (var i = 0; i < observedPayloads.length; i++) {
      walkJson(
        observedPayloads[i].body,
        function (obj) {
          widgets.push({
            type: firstStringKey(obj, WIDGET_TYPE_KEYS) || 'unknown',
            label: firstStringKey(obj, WIDGET_LABEL_KEYS) || '',
          })
        },
        function (text) {
          prompts.push(text)
        },
      )
    }

    return { widgets: widgets, prompts: prompts }
  }

  // ---------------------------------------------------------------------
  // Extraction from the DOM
  //
  // A backstop for whatever the network walk misses, and the only source for
  // AI output the human just triggered (that text is rendered, not refetched).
  // Selectors are tried broadest-last because PartyRock ships hashed class
  // names that change between deploys.
  // ---------------------------------------------------------------------

  function textOf(el) {
    if (!el) return ''
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return text
  }

  function uniqueStrings(list, maxLength) {
    var seen = {}
    var out = []
    for (var i = 0; i < list.length; i++) {
      var value = (list[i] || '').trim()
      if (!value) continue
      if (maxLength && value.length > maxLength) value = value.slice(0, maxLength)
      if (seen[value]) continue
      seen[value] = true
      out.push(value)
    }
    return out
  }

  function findWidgetElements() {
    var selectors = [
      '[data-widget-type]',
      '[data-widget-id]',
      '[data-testid*="widget" i]',
      '[class*="widget" i]',
      '[data-testid*="card" i]',
    ]
    for (var i = 0; i < selectors.length; i++) {
      var found
      try {
        found = document.querySelectorAll(selectors[i])
      } catch (e) {
        continue
      }
      if (found && found.length > 0) return Array.prototype.slice.call(found)
    }
    return []
  }

  function extractFromDom() {
    var widgets = []
    var prompts = []
    var outputs = []

    var elements = findWidgetElements()
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i]
      var type =
        el.getAttribute('data-widget-type') ||
        el.getAttribute('data-testid') ||
        'widget'
      var heading = el.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="label" i]')
      widgets.push({ type: String(type), label: textOf(heading).slice(0, 200) })

      // Generated output tends to be the longest prose block in a widget card
      // that is not an input control.
      var body = textOf(el)
      if (body.length > 120) outputs.push(body.slice(0, 4000))
    }

    var inputs = document.querySelectorAll('textarea, [contenteditable="true"]')
    for (var j = 0; j < inputs.length; j++) {
      var node = inputs[j]
      var value = node.value != null ? node.value : textOf(node)
      if (value && String(value).trim().length > 2) prompts.push(String(value).trim())
    }

    // PartyRock prompt syntax references other widgets with @Name or {{Name}};
    // any visible text using it is almost certainly a prompt.
    var candidates = document.querySelectorAll('p, span, div, pre, code')
    for (var k = 0; k < candidates.length && k < 4000; k++) {
      var text = textOf(candidates[k])
      if (!text || text.length > 2000) continue
      if (/\{\{[^}]+\}\}/.test(text)) prompts.push(text)
    }

    return { widgets: widgets, prompts: prompts, outputs: outputs }
  }

  function metaContent(selector) {
    var el = document.querySelector(selector)
    return el ? (el.getAttribute('content') || '').trim() : ''
  }

  // ---------------------------------------------------------------------
  // Public API — what the navigator and the panel both call
  // ---------------------------------------------------------------------

  /**
   * Build the capture payload for the page as it stands right now.
   * Safe to call repeatedly; each call re-reads the DOM.
   */
  window.__partyRockCapture = function () {
    var net = extractFromNetwork()
    var dom = extractFromDom()

    // Network widgets are authoritative (real types and labels); DOM widgets
    // only fill in when the network walk found nothing at all.
    var widgets = net.widgets.length > 0 ? net.widgets : dom.widgets
    var widgetKeys = {}
    var dedupedWidgets = []
    for (var i = 0; i < widgets.length; i++) {
      var key = widgets[i].type + '||' + widgets[i].label
      if (widgetKeys[key]) continue
      widgetKeys[key] = true
      dedupedWidgets.push(widgets[i])
    }

    var prompts = uniqueStrings(net.prompts.concat(dom.prompts), 20000)
    var outputs = uniqueStrings(dom.outputs, 20000)

    var title =
      metaContent('meta[property="og:title"]') ||
      textOf(document.querySelector('h1')) ||
      document.title ||
      ''

    var description =
      metaContent('meta[name="description"]') ||
      metaContent('meta[property="og:description"]') ||
      ''

    var source = 'mixed'
    if (net.widgets.length > 0 && dom.widgets.length === 0) source = 'network'
    else if (net.widgets.length === 0 && dom.widgets.length > 0) source = 'dom'

    return {
      url: location.href,
      title: title ? title.slice(0, 1000) : null,
      description: description ? description.slice(0, 5000) : null,
      widgets: dedupedWidgets.slice(0, 500),
      prompts: prompts.slice(0, 500),
      outputs: outputs.slice(0, 500),
      appDefinition: observedPayloads.length > 0
        ? observedPayloads[observedPayloads.length - 1].body
        : null,
      source: source,
      capturedAt: new Date().toISOString(),
    }
  }

  /** POST the current capture to the scoring app from inside the page. */
  window.__partyRockSend = function () {
    var payload = window.__partyRockCapture()
    return fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Capture-Token': CONFIG.token || '',
      },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, status: res.status, body: body }
      })
    })
  }

  // ---------------------------------------------------------------------
  // Floating panel
  //
  // The operator needs to see what was actually captured before moving on —
  // an app whose widgets never loaded should be obvious, not silent.
  // ---------------------------------------------------------------------

  var panel, statusLine, countsLine, refreshTimer

  function styleButton(btn, background) {
    btn.style.cssText =
      'flex:1;padding:7px 10px;border:0;border-radius:6px;font:600 12px system-ui,sans-serif;' +
      'cursor:pointer;color:#fff;background:' + background + ';'
    return btn
  }

  function buildPanel() {
    panel = document.createElement('div')
    panel.id = 'pr-capture-panel'
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:280px;' +
      'background:#111827;color:#f9fafb;border-radius:10px;padding:12px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.35);font:12px/1.5 system-ui,sans-serif;'

    var heading = document.createElement('div')
    heading.textContent = 'PartyRock Capture'
    heading.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:6px;'
    panel.appendChild(heading)

    countsLine = document.createElement('div')
    countsLine.style.cssText = 'color:#9ca3af;margin-bottom:8px;'
    panel.appendChild(countsLine)

    var hint = document.createElement('div')
    hint.textContent =
      'Klik widget di halaman ini untuk memicu generate, lalu tekan Kirim.'
    hint.style.cssText = 'color:#6b7280;margin-bottom:10px;'
    panel.appendChild(hint)

    var row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;'

    var sendBtn = styleButton(document.createElement('button'), '#2563eb')
    sendBtn.textContent = 'Kirim & Lanjut'
    sendBtn.onclick = function () {
      if (!CONFIG.postFromPage) {
        // The navigator is driving: it reads the payload itself once state flips.
        setStatus('Dikirim ke navigator...', '#93c5fd')
        window.__PR_CAPTURE_STATE = 'sent'
        return
      }
      setStatus('Mengirim...', '#93c5fd')
      window
        .__partyRockSend()
        .then(function (res) {
          if (res.ok) {
            setStatus('Tersimpan: ' + (res.body.message || 'OK'), '#6ee7b7')
            window.__PR_CAPTURE_STATE = 'sent'
          } else {
            setStatus('Gagal: ' + (res.body.message || res.status), '#fca5a5')
          }
        })
        .catch(function (err) {
          setStatus('Gagal: ' + err.message, '#fca5a5')
        })
    }
    row.appendChild(sendBtn)

    var skipBtn = styleButton(document.createElement('button'), '#4b5563')
    skipBtn.textContent = 'Lewati'
    skipBtn.onclick = function () {
      window.__PR_CAPTURE_STATE = 'skipped'
      setStatus('Dilewati.', '#fcd34d')
    }
    row.appendChild(skipBtn)
    panel.appendChild(row)

    var row2 = document.createElement('div')
    row2.style.cssText = 'display:flex;gap:6px;'

    var copyBtn = styleButton(document.createElement('button'), '#374151')
    copyBtn.textContent = 'Salin JSON'
    copyBtn.onclick = function () {
      var json = JSON.stringify(window.__partyRockCapture(), null, 2)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(
          function () {
            setStatus('JSON disalin ke clipboard.', '#6ee7b7')
          },
          function () {
            setStatus('Clipboard ditolak — cek console.', '#fca5a5')
            console.log(json)
          },
        )
      } else {
        console.log(json)
        setStatus('JSON dicetak di console.', '#6ee7b7')
      }
    }
    row2.appendChild(copyBtn)

    var rescanBtn = styleButton(document.createElement('button'), '#374151')
    rescanBtn.textContent = 'Pindai Ulang'
    rescanBtn.onclick = function () {
      refreshCounts()
      setStatus('Dipindai ulang.', '#9ca3af')
    }
    row2.appendChild(rescanBtn)
    panel.appendChild(row2)

    statusLine = document.createElement('div')
    statusLine.style.cssText = 'margin-top:8px;color:#9ca3af;word-break:break-word;'
    panel.appendChild(statusLine)

    document.documentElement.appendChild(panel)
  }

  function setStatus(text, color) {
    if (!statusLine) return
    statusLine.textContent = text
    statusLine.style.color = color || '#9ca3af'
  }

  function refreshCounts() {
    if (!countsLine) return
    var data = window.__partyRockCapture()
    countsLine.textContent =
      data.widgets.length +
      ' widget · ' +
      data.prompts.length +
      ' prompt · ' +
      data.outputs.length +
      ' output'
    countsLine.style.color = data.widgets.length > 0 ? '#6ee7b7' : '#fca5a5'
  }

  /** Coalesce the burst of refreshes a page load produces into one repaint. */
  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(function () {
      refreshTimer = null
      try {
        refreshCounts()
      } catch (e) {
        /* ignore */
      }
    }, 400)
  }

  window.__prCaptureShowPanel = function () {
    if (!panel) return
    panel.style.display = 'block'
    refreshCounts()
  }

  function install() {
    if (document.getElementById('pr-capture-panel')) return
    buildPanel()
    refreshCounts()
    setInterval(scheduleRefresh, 3000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install)
  } else {
    install()
  }
})()
