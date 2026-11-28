import { notFound } from 'next/navigation';
import { getStars } from '@/kit/stars';
import { FeaturePage } from '@/components/feature-page';
import { features, site } from '@/lib/site';

export const dynamicParams = false;
export function generateStaticParams() {
  return features.areas.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = features.areas.find((x) => x.slug === slug);
  return a ? { title: `${a.name}: MaiPai Stack`, description: a.card } : {};
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = features.areas.find((x) => x.slug === slug);
  if (!a) notFound();
  const stars = await getStars(site.repo.user, site.repo.repo);
  return <FeaturePage a={a} stars={stars} />;
}
