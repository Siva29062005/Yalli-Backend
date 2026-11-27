-- Data repair (hand-written, no schema change). Before 2026-11-27 `stripTags` stored plain-text fields HTML-encoded
-- ("Kitchen & Dining" became "Kitchen &amp; Dining"). It now returns real characters; this decodes rows written before.
-- Decoding is the exact inverse of what stripTags produced: it only ever emitted &amp; &lt; &gt; in text, and one
-- replace pass (lt, gt, then amp) equals a single-pass decode ("&amp;lt;" becomes the literal text "&lt;").
-- Slugs are URLs and are deliberately left unchanged. Unique names (brands, tags) are skipped if decoding would collide.

UPDATE "products" SET "name" = replace(replace(replace("name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "name" ~ '&(amp|lt|gt);';
UPDATE "products" SET "summary" = replace(replace(replace("summary", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "summary" ~ '&(amp|lt|gt);';
UPDATE "categories" SET "name" = replace(replace(replace("name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "name" ~ '&(amp|lt|gt);';
UPDATE "product_attributes" SET "name" = replace(replace(replace("name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "name" ~ '&(amp|lt|gt);';
UPDATE "product_attributes" SET "value" = replace(replace(replace("value", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "value" ~ '&(amp|lt|gt);';
UPDATE "product_images" SET "alt_text" = replace(replace(replace("alt_text", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "alt_text" ~ '&(amp|lt|gt);';
UPDATE "product_reviews" SET "title" = replace(replace(replace("title", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "title" ~ '&(amp|lt|gt);';
UPDATE "product_reviews" SET "body" = replace(replace(replace("body", '&lt;', '<'), '&gt;', '>'), '&amp;', '&') WHERE "body" ~ '&(amp|lt|gt);';

UPDATE "brands" b SET "name" = replace(replace(replace(b."name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&')
WHERE b."name" ~ '&(amp|lt|gt);'
  AND NOT EXISTS (SELECT 1 FROM "brands" o WHERE o."id" <> b."id" AND lower(o."name") = lower(replace(replace(replace(b."name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&')));

UPDATE "tags" t SET "name" = replace(replace(replace(t."name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&')
WHERE t."name" ~ '&(amp|lt|gt);'
  AND NOT EXISTS (SELECT 1 FROM "tags" o WHERE o."id" <> t."id" AND lower(o."name") = lower(replace(replace(replace(t."name", '&lt;', '<'), '&gt;', '>'), '&amp;', '&')));
