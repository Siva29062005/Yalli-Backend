import Link from 'next/link';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

export default function ProductNotFound() {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <h1 className="font-heading text-[28px] font-bold text-[#113322]">This product isn’t available</h1>
        <p className="text-[14px] text-[#8A958E]">It may have been removed or the link is incorrect.</p>
        <Link href="/catalog" className="rounded-xl bg-[#116644] px-6 py-3 text-[14px] font-semibold text-white hover:bg-[#0e5237]">
          Continue shopping
        </Link>
      </main>
      <Footer />
    </>
  );
}
