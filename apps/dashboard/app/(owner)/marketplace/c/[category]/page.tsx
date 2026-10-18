"use client";

import { useParams } from "next/navigation";
import { MarketHome } from "../../../../../components/market/MarketHome";

export default function CategoryPage() {
  const { category } = useParams<{ category: string }>();
  return <MarketHome key={category} category={category} />;
}
