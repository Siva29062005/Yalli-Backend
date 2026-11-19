import { OrderConfirmation } from "./OrderConfirmation";

export const metadata = { title: "Order confirmation | Yalli", robots: { index: false } };

export default async function OrderConfirmationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderConfirmation id={id} />;
}
