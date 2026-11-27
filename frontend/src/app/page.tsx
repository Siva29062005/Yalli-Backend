import Link from "next/link";
import Image from "next/image";
import { ArrowRight, ShieldCheck, FileText, Truck, MessageCircle, Star } from "lucide-react";
import { AnnouncementBar } from "@/components/AnnouncementBar";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CategoryTiles } from "@/components/CategoryTiles";
import { ProductCard } from "@/components/ProductCard";
import { CartDrawer } from "@/components/CartDrawer";
import type { Metadata } from "next";
import { JsonLd } from "@/components/JsonLd";
import { listProducts } from "@/lib/catalog-api";
import { BUSINESS } from "@/lib/business";
import { websiteJsonLd } from "@/lib/seo";
import { SITE_URL, canonicalFor } from "@/lib/site";

export const metadata: Metadata = { ...canonicalFor("/") };

export default async function HomePage() {
  // Featured row is best-effort: an API outage must not break the home page.
  const bestsellers = await listProducts({ inStock: true, pageSize: 5, sort: "newest" })
    .then((p) => p.items)
    .catch(() => []);

  return (
    <>
      {SITE_URL && <JsonLd data={websiteJsonLd({ name: BUSINESS.tradeName, siteUrl: SITE_URL })} />}
      <AnnouncementBar />
      <Header />
      <CartDrawer />

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 md:px-8 lg:px-12 py-6 space-y-12">
        {/* 1. Hero Section matching Figma Screen 01 */}
        <section className="bg-[#EEFFEE]/60 rounded-3xl p-6 md:p-12 lg:p-16 border border-[#E0EFE5] overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            {/* Left Column (~45%) */}
            <div className="lg:col-span-6 space-y-6">
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

            {/* Right Column: Hero Photo */}
            <div
              className="lg:col-span-6 relative aspect-[16/10] rounded-2xl overflow-hidden shadow-sm"
              style={{ position: "relative" }}
            >
              <Image
                src="https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=1200&q=80"
                alt="Yalli Kitchen & Home Essentials"
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
            </div>
          </div>
        </section>

        {/* 2. Bestsellers Row matching Screen 01 */}
        <section className="space-y-6">
          <div className="flex items-end justify-between">
            <div>
              <span className="text-[11px] font-bold text-[#8A958E] uppercase tracking-wider block">
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
            <p className="rounded-2xl border border-[#E6EAE7] bg-white p-8 text-center text-[14px] text-[#8A958E]">
              New arrivals are on their way. <Link href="/catalog" className="font-semibold text-[#116644] hover:underline">Browse the shop</Link>
            </p>
          )}
        </section>

        {/* 3. 8 Core Category Tiles (Context change to user-specified categories) */}
        <CategoryTiles />

        {/* 4. Deal Strip matching Figma / Canva Spec */}
        <section className="bg-[#EEFFEE]/50 rounded-2xl p-6 border border-[#E0EFE5]">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
              <div>
                <span className="text-[11px] font-bold text-[#FF9900] uppercase tracking-wider">
                  Combo Offers
                </span>
                <h3 className="font-heading text-[17px] font-bold text-[#113322]">
                  Save up to 30% on curated bundles
                </h3>
              </div>
              <Link
                href="/catalog/tablet"
                className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1"
              >
                <span>Shop combo deals</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
              <div>
                <span className="text-[11px] font-bold text-[#116644] uppercase tracking-wider">
                  First Order Offer
                </span>
                <h3 className="font-heading text-[17px] font-bold text-[#113322]">
                  Flat ₹100 off with code WELCOME100
                </h3>
              </div>
              <Link
                href="/catalog"
                className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1"
              >
                <span>Use coupon now</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            <div className="bg-white rounded-xl p-5 border border-[#E6EAE7] flex flex-col justify-between space-y-3">
              <div>
                <span className="text-[11px] font-bold text-[#113322] uppercase tracking-wider">
                  Our Promise
                </span>
                <h3 className="font-heading text-[17px] font-bold text-[#113322]">
                  7-Day easy replacement guarantee
                </h3>
              </div>
              <Link
                href="/shipping"
                className="text-[13px] font-semibold text-[#116644] hover:underline inline-flex items-center gap-1"
              >
                <span>Learn about returns</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </section>

        {/* 5. Trust Row & Testimonial matching Figma Screen 01 */}
        <section className="bg-white rounded-2xl p-6 border border-[#E6EAE7] flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Testimonial */}
          <div className="flex items-center gap-3">
            <div className="flex text-[#FF9900]">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="w-4 h-4 fill-[#FF9900]" />
              ))}
            </div>
            <p className="text-[14px] text-[#113322] italic">
              &ldquo;Beautiful quality, without the big-brand price tag.&rdquo;
            </p>
            <span className="text-[13px] text-[#8A958E]">
              — Ananya S., Bengaluru
            </span>
          </div>

          {/* Trust Badges */}
          <div className="flex flex-wrap items-center gap-6 text-[13px] text-[#4A5550]">
            <div className="flex items-center gap-1.5">
              <Truck className="w-4 h-4 text-[#116644]" />
              <span>Free shipping above ₹499</span>
            </div>
            <span className="text-[#8A958E]">·</span>
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[#116644]" />
              <span>Secure Razorpay</span>
            </div>
            <span className="text-[#8A958E]">·</span>
            <div className="flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-[#116644]" />
              <span>GST invoice</span>
            </div>
            <span className="text-[#8A958E]">·</span>
            <div className="flex items-center gap-1.5">
              <MessageCircle className="w-4 h-4 text-[#116644]" />
              <span>WhatsApp support</span>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
