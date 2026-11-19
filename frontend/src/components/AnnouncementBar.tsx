import React from "react";
import { BRAND } from "@/lib/constants";

export function AnnouncementBar() {
  return (
    <div className="bg-[#113322] text-[#FFFFFE] text-[12px] md:text-[13px] font-medium py-2 px-4 text-center tracking-wide">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 flex items-center justify-center gap-2">
        <span>{BRAND.announcement}</span>
      </div>
    </div>
  );
}
