/**
 * Skeleton shown while a catalogue page loads. Used as an explicit <Suspense> fallback INSIDE the page (not as a
 * route `loading.tsx`): a route loading boundary starts streaming before the page can call notFound(), which would turn
 * an unknown category's 404 into a 200.
 */
export function CatalogLoading() {
  return (
    <main aria-busy="true" aria-label="Loading products" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-8 lg:px-12">
      <div className="mb-6 h-9 w-64 animate-pulse rounded-lg bg-[#E6EAE7]" />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-2xl border border-[#E6EAE7] bg-white">
            <div className="aspect-[4/3] animate-pulse bg-[#EEF1EF]" />
            <div className="space-y-2 p-4">
              <div className="h-4 w-3/4 animate-pulse rounded bg-[#EEF1EF]" />
              <div className="h-4 w-1/3 animate-pulse rounded bg-[#EEF1EF]" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
