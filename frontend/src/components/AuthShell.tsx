import Image from 'next/image';
import Link from 'next/link';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { AnnouncementBar } from '@/components/AnnouncementBar';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';

/** Split brand + form card shared by the login and registration screens. */
export function AuthSplitShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="flex-1 max-w-[1200px] w-full mx-auto px-4 md:px-8 py-10">
        <div className="flex justify-end mb-4">
          <Link href="/catalog" className="text-[13px] text-[#4A5550] hover:text-[#116644] font-medium">
            ← Back to the shop
          </Link>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center bg-white rounded-3xl border border-[#E6EAE7] overflow-hidden p-6 md:p-10 shadow-xs">
          <div className="hidden lg:block lg:col-span-5 bg-[#EEFFEE]/50 rounded-2xl p-8 border border-[#D5EAD9] space-y-6">
            <span className="text-[11px] font-bold text-[#116644] tracking-wider uppercase block">
              A Little More Joy, Every Day
            </span>
            <h2 className="font-heading text-[32px] font-bold text-[#113322] leading-tight">
              Good things begin at home.
            </h2>
            <p className="text-[14px] text-[#4A5550] leading-relaxed">
              One account for your favourites, little upgrades, and everything that makes a house your home.
            </p>
            <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-white border border-[#D5EAD9]">
              <Image
                src="https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80"
                alt=""
                fill
                sizes="40vw"
                className="object-cover"
              />
            </div>
            <p className="text-[12px] text-[#116644] font-medium">Thoughtfully chosen. Honestly priced. Always Yalli.</p>
          </div>
          <div className="lg:col-span-7 max-w-md mx-auto w-full space-y-6 py-4 min-w-0">{children}</div>
        </div>
      </main>
      <Footer />
    </>
  );
}

/** Narrow centred card for the single-purpose screens (verify email, reset password). */
export function AuthNarrowShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnnouncementBar />
      <Header />
      <main className="flex-1 max-w-[520px] w-full mx-auto px-4 md:px-8 py-16 text-center space-y-6">{children}</main>
      <Footer />
    </>
  );
}

export const inputClass =
  'w-full bg-[#F5F6F5] text-[14px] px-4 py-2.5 rounded-xl border border-transparent focus:border-[#116644] focus:bg-white outline-none disabled:opacity-60 aria-[invalid=true]:border-red-400';
export const primaryButtonClass =
  'w-full bg-[#FF9900] hover:bg-[#e68a00] text-[#113322] font-bold text-[15px] py-3.5 rounded-xl transition shadow-xs cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed';

export function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'success'; children: React.ReactNode }) {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-xl px-4 py-3 text-[13px] text-left ${
        tone === 'error' ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-[#EEFFEE] text-[#116644] border border-[#D5EAD9]'
      }`}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-[12px] text-red-600">
      {message}
    </p>
  );
}
