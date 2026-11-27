import sanitize from 'sanitize-html';

/**
 * Allow-list sanitiser for merchant-authored product descriptions (the current site stores HTML).
 * Scripts, styles, event handlers, iframes, forms, images and non-http(s) URLs are removed.
 * This is defence in depth: consumers must still render with framework escaping / a strict CSP.
 */
export function sanitizeRichText(html: string): string {
  return sanitize(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      'ul',
      'ol',
      'li',
      'h2',
      'h3',
      'h4',
      'blockquote',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitize.simpleTransform('a', {
        rel: 'nofollow noopener noreferrer',
        target: '_blank',
      }),
    },
    allowedSchemesAppliedToAttributes: ['href'],
  }).trim();
}

const TEXT_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>' };

/**
 * Plain text (names, summaries, tags, alt text, reviews): strips ALL markup and returns real characters, so
 * "Kitchen & Dining" stays "Kitchen & Dining" (not `&amp;`). sanitize-html decodes every input entity and re-encodes
 * text with exactly `&amp;` `&lt;` `&gt;`, so decoding those three in one pass restores the text exactly. The result
 * is never longer than the input (stripping and entity decoding only shorten), so column limits checked on the input
 * still hold. It may contain a literal `<`: it is TEXT, and every consumer must escape it (React, `esc()` in invoices,
 * email templates); never insert it as HTML.
 */
export const stripTags = (value: string): string =>
  sanitize(value, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt);/g, (_, e: string) => TEXT_ENTITIES[e]!)
    .trim();
