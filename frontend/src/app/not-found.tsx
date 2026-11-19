import Link from 'next/link';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

export const metadata = { title: 'Page not found | Yalli' };

const linkClass =
  'rounded-xl px-6 py-3 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#116644]';

export default function NotFound() {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main id="content" className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-20 text-center">
        <p className="text-[14px] font-semibold uppercase tracking-widest text-[#116644]">Error 404</p>
        <h1 className="font-heading text-[30px] font-bold text-[#113322]">We can’t find that page</h1>
        <p className="text-[15px] text-[#4A5550]">
          The link may be old or mistyped. Try one of these instead.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/" className={`${linkClass} bg-[#116644] text-white hover:bg-[#0e5237]`}>Go to the home page</Link>
          <Link href="/catalog" className={`${linkClass} border border-[#116644] text-[#116644] hover:bg-[#EEFFEE]`}>Browse products</Link>
          <Link href="/help" className={`${linkClass} text-[#116644] underline`}>Help centre</Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
