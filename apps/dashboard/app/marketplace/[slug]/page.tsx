"use client";

import { useParams } from "next/navigation";
import { ListingDetail } from "../../../components/market/ListingDetail";

export default function ListingPage() {
  const { slug } = useParams<{ slug: string }>();
  return <ListingDetail key={slug} slug={slug} />;
}
