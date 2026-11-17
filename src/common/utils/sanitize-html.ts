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

/** Plain text (for summaries, names): strips ALL markup. */
export const stripTags = (value: string): string =>
  sanitize(value, { allowedTags: [], allowedAttributes: {} }).trim();
