import Link from "next/link";
import { Suspense } from "react";
import { AccountDeletedNotice } from "@/components/AccountDeletedNotice";
import Image from "next/image";
import { ArrowRight, ShieldCheck, FileText, Truck, MessageCircle } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CategoryTiles } from "@/components/CategoryTiles";
import { ProductCard } from "@/components/ProductCard";
import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { listProducts } from "@/lib/catalog-api";
import { BUSINESS, HOME_HERO } from "@/lib/business";
import { ProductImage } from "@/components/ProductImage";
import { websiteJsonLd } from "@/lib/seo";
import { SITE_URL, canonicalFor } from "@/lib/site";

export const metadata: Metadata = { ...canonicalFor("/") };

export default async function HomePage() {
  // Featured row is best-effort: an API outage must not break the home page.
  const bestsellers = await listProducts({ inStock: true, pageSize: 5, sort: "newest" })
    .then((p) => p.items)
    .catch(() => []);
  // The sale card is shown only while something is really on sale (best-effort, like the row above).
  const sale = await listProducts({ special: true, pageSize: 5 })
    .then((p) => ({ items: p.items, total: p.meta.total }))
    .catch(() => ({ items: [], total: 0 }));
  const onSale = sale.total;
  // The banner the owner supplied, else a real product photo (never a stock photo), else none.
  const heroProduct = [...sale.items, ...bestsellers].find((p) => p.imageUrl);

  return (
    <>
      {SITE_URL && <JsonLd data={websiteJsonLd({ name: BUSINESS.tradeName, siteUrl: SITE_URL })} />}
      <AnnouncementBar />
      <Header />

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 md:px-8 lg:px-12 py-6 space-y-12">
        <Suspense>
          <AccountDeletedNotice />
        </Suspense>
        {/* 1. Hero Section matching Figma Screen 01 */}
        <section className="bg-[#EEFFEE]/60 rounded-3xl p-6 md:p-12 lg:p-16 border border-[#E0EFE5] overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            {/* Left Column (~45%) */}
            <div className={`${HOME_HERO.image || heroProduct ? "lg:col-span-6" : "lg:col-span-12"} space-y-6`}>
              <span className="inline-block text-[11px] font-bold text-[#116644] bg-white px-3 py-1.5 rounded-full border border-[#116644]/30 uppercase tracking-wider">
                Good Living. Great Company.
              </span>

              <h1 className="font-heading text-[38px] sm:text-[46px] lg:text-[54px] font-bold text-[#113322] leading-[1.1] tracking-tight">
                Fresh Living, <br />
                Honest Prices
              </h1>

              <p className="text-[15px] sm:text-[16px] text-[#4A5550] max-w-lg leading-relaxed">
                Little upgrades. Big everyday joy. Discover home, kitchen, and lifestyle essentials that feel as good as they work.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link
                  href="/catalog"
                  className="bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-semibold text-[15px] px-8 py-3.5 rounded-xl transition shadow-sm inline-flex items-center gap-2"
                >
                  <span>Shop Now</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>

                <span className="text-[13px] text-[#116644] font-medium">
                  Thoughtfully chosen. Honestly priced.
                </span>
              </div>
            </div>

            {/* Right Column: the owner's banner (public/), else a real product photo linking to it */}
            {HOME_HERO.image ? (
              <div className="lg:col-span-6 relative aspect-[16/10] rounded-2xl overflow-hidden shadow-sm">
                <Image src={HOME_HERO.image} alt={HOME_HERO.alt} fill priority sizes="(max-width: 1024px) 100vw, 50vw" className="object-cover" />
              </div>
            ) : heroProduct ? (
              <Link href={`/products/${heroProduct.slug}`} className="lg:col-span-6 relative block aspect-[16/10] rounded-2xl overflow-hidden shadow-sm bg-white">
                <ProductImage src={heroProduct.imageUrl} alt={heroProduct.name} priority sizes="(max-width: 1024px) 100vw, 50vw" className="object-contain" />
              </Link>
            ) : null}
          </div>
        </section>

        {/* 2. Newest products (there is no bestseller data yet) */}
        <section className="space-y-6">
          <div className="flex items-end justify-between">
            <div>
              <span className="text-[11px] font-bold text-[#5F6B64] uppercase tracking-wider block">
                New Arrivals
              </span>
              <h2 className="font-heading text-[24px] md:text-[28px] font-bold text-[#113322]">
                Everyday favourites, for a reason.
              </h2>
            </div>
            <Link
              href="/catalog"
              className="text-[14px] font-semibold text-[#116644] hover:underline flex items-center gap-1"
            >
              <span>Explore all products</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {bestsellers.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {bestsellers.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-[#E6EAE7] bg-white p-8 text-center text-[14px] text-[#5F6B64]">
              New arrivals are on their way. <Link href="/catalog" className="font-semibold text-[#116644] hover:underline">Browse the shop</Link>
            </p>
          )}
        </section>

        {/* 2b. What is on sale right now (only while something is) */}
        {sale.items.length > 0 && (
          <section className="space-y-6" aria-labelledby="sale-h">
            <div className="flex items-end justify-between">
              <div>
                <span className="text-[11px] font-bold text-[#A65500] uppercase tracking-wider block">On sale now</span>
                <h2 id="sale-h" className="font-heading text-[24px] md:text-[28px] font-bold text-[#113322]">Special prices</h2>
              </div>
              <Link href="/specials" className="text-[14px] font-semibold text-[#116644] hover:underline flex items-center gap-1">
                <span>See all offers</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {sale.items.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          </section>
        )}

        {/* 3. Category tiles (from the catalogue) */}
        <CategoryTiles />

        {/* 4. What the shop really offers. Every claim here is true today (CLAUDE.md: never claim a discount, free
            shipping or a promise the shop does not keep): the sale card only appears while products are on sale. */}
        <section className="bg-[#EEFFEE]/50 rounded-2xl p-6 border border-[#E0EFE5]">
          <div className={`grid grid-cols-1 gap-4 ${onSale > 0 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
            {onSale > 0 && (
              <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
                <div>
                  <span className="text-[11px] font-bold text-[#A65500] uppercase tracking-wider">On sale now</span>
                  <h3 className="font-heading text-[17px] font-bold text-[#113322]">
                    {onSale === 1 ? "1 product at a special price" : `${onSale} products at special prices`}
                  </h3>
                </div>
                <Link href="/catalog?sale=true" className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1">
                  <span>See the offers</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            )}

            <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
              <div>
                <span className="text-[11px] font-bold text-[#116644] uppercase tracking-wider">Secure checkout</span>
                <h3 className="font-heading text-[17px] font-bold text-[#113322]">Pay online by UPI, card or netbanking through Razorpay</h3>
              </div>
              <Link href="/help#ordering" className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1">
                <span>How paying works</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
              <div>
                <span className="text-[11px] font-bold text-[#113322] uppercase tracking-wider">Returns</span>
                <h3 className="font-heading text-[17px] font-bold text-[#113322]">Return an item within 7 days of delivery</h3>
              </div>
              <Link href="/returns" className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1">
                <span>Read the returns policy</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* 5. Trust row: facts only (no invented reviews, fees or channels). */}
        <section className="bg-white rounded-2xl p-6 border border-[#E6EAE7]">
          <div className="flex flex-wrap items-center justify-center gap-6 text-[13px] text-[#4A5550]">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[#116644]" />
              <span>Secure payments with Razorpay</span>
            </div>
            <span className="text-[#5F6B64]">·</span>
            <div className="flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-[#116644]" />
              <span>GST invoice with every order</span>
            </div>
            <span className="text-[#5F6B64]">·</span>
            <div className="flex items-center gap-1.5">
              <Truck className="w-4 h-4 text-[#116644]" />
              <span>Delivery fee shown before you pay</span>
            </div>
            {(BUSINESS.supportEmail || BUSINESS.supportPhone) && (
              <>
                <span className="text-[#5F6B64]">·</span>
                <Link href="/contact" className="flex items-center gap-1.5 hover:text-[#116644]">
                  <MessageCircle className="w-4 h-4 text-[#116644]" />
                  <span>Contact support</span>
                </Link>
              </>
            )}
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
