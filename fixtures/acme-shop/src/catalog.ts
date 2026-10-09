export type Product = {
  id: string;
  name: string;
  priceCents: number;
};

export const SEED_PRODUCTS: readonly Product[] = [
  { id: "p-100", name: "Trail Backpack", priceCents: 8900 },
  { id: "p-101", name: "Insulated Bottle", priceCents: 2400 },
  { id: "p-102", name: "Wool Socks (3 pack)", priceCents: 1800 },
  { id: "p-103", name: "Headlamp", priceCents: 3500 },
  { id: "p-104", name: "Camp Stove", priceCents: 5900 },
  { id: "p-105", name: "Rain Shell", priceCents: 12900 },
  { id: "p-106", name: "Field Notebook", priceCents: 900 },
];
