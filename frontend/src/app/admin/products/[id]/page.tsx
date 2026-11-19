import { ProductEditor } from '@/components/ProductEditor';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  return <ProductEditor id={(await params).id} />;
}
