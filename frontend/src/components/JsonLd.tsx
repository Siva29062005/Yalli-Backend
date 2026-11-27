import { jsonLdScript } from '@/lib/seo';

/** Structured data for search engines. `<` is escaped in the payload, so product text can never end the script tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data) }} />;
}
