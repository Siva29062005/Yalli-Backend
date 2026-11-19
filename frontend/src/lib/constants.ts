import { Category } from "./types";

/** Legacy design fixture only. Live storefront categories come from CategoryProvider. */
export const CATEGORIES: Category[] = [
  {
    id: "all",
    name: "All",
    slug: "all-products",
    iconName: "LayoutGrid",
    description: "Browse everything curated for modern living across India",
    productCount: 128,
  },
  {
    id: "electronics-gadgets",
    name: "Electronics & Gadgets",
    slug: "desktops",
    iconName: "Smartphone",
    description: "Smart tech, daily utility gadgets, lighting & audio",
    productCount: 34,
  },
  {
    id: "home-accessories",
    name: "Home Accessories",
    slug: "laptop-notebook",
    iconName: "Home",
    description: "Bathroom decor, cleaning supplies, organizers & home comfort",
    productCount: 29,
  },
  {
    id: "kitchen-dining",
    name: "Kitchen and Dining",
    slug: "component",
    iconName: "Utensils",
    description: "Cookware, tableware, storage jars & everyday kitchen joy",
    productCount: 42,
  },
  {
    id: "combo",
    name: "Combo",
    slug: "tablet",
    iconName: "Sparkles",
    description: "Curated bundles & value sets — save up to 30%",
    productCount: 15,
  },
  {
    id: "outdoor-travel",
    name: "Outdoor and Travel",
    slug: "cameras",
    iconName: "Compass",
    description: "Travel organizers, bottles, portable kits & utility gear",
    productCount: 18,
  },
  {
    id: "health-wellness",
    name: "Health & Wellness",
    slug: "mp3-players",
    iconName: "HeartPulse",
    description: "Personal care, posture aids, grooming & mindful living",
    productCount: 16,
  },
  {
    id: "yalli-products",
    name: "Yalli Products",
    slug: "smartphone",
    iconName: "CheckCircle2",
    description: "Our signature in-house creations. Thoughtfully crafted.",
    productCount: 22,
    featured: true,
  },
];

export const BRAND = {
  name: "yalli",
  tagline: "Thoughtfully home.",
  announcement:
    "THE EVERYDAY JOY SALE · Up to 40% off top favourites · Free shipping above ₹499",
  supportEmail: "care@yalli.in",
  supportPhone: "+91 98765 43210",
  freeShippingThresholdPaise: 49900, // ₹499.00
  currencySymbol: "₹",
};
