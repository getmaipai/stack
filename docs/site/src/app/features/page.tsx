import { getStars } from '@/kit/stars';
import { AreaCards, Footer, Kit, Nav } from '@/kit/blocks';
import { areas, featuresBase, site } from '@/lib/site';

export const metadata = { title: 'Features: MaiPai Stack', description: 'What MaiPai Stack takes care of.' };

export default async function Page() {
  const stars = await getStars(site.repo.user, site.repo.repo);
  return (
    <Kit product="stack">
      <Nav site={site} stars={stars} />
      <div className="herobg">
        <div className="wrap pagehead">
          <div className="eyebrow">Features</div>
          <h1 style={{ maxWidth: 'none' }}>What MaiPai Stack takes <span className="hl">care of</span>.</h1>
          <p className="lead">Pick a feature to see what it does and where to read more.</p>
        </div>
      </div>
      <section style={{ paddingTop: 24 }}>
        <div className="wrap"><AreaCards areas={areas} base={featuresBase} product="stack" /></div>
      </section>
      <Footer site={site} />
    </Kit>
  );
}
