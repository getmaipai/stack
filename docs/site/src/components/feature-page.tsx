import Link from 'next/link';
import { Footer, Kit, Nav } from '@/kit/blocks';
import { Icon } from '@/kit/icons';
import { docUrl, featuresBase, features, site } from '@/lib/site';
import { CodeSample, Frame, ILLUS, Lanes, Pic } from './visuals';

type Area = (typeof features.areas)[number];

function Visual({ a }: { a: Area }) {
  const v = a.visual as { kind: string; shot?: string; alt: string };
  if (v.kind === 'screen' && v.shot)
    return <Frame caption={v.alt}><Pic shot={v.shot} alt={v.alt} crop /></Frame>;
  return (
    <Frame caption={ILLUS} label={v.alt}>
      {v.kind === 'lanes' ? <Lanes /> : <CodeSample />}
    </Frame>
  );
}

export function FeaturePage({ a, stars }: { a: Area; stars: string | null }) {
  const more = features.areas.filter((x) => x.slug !== a.slug).slice(0, 3);
  return (
    <Kit product="stack">
      <Nav site={site} stars={stars} />
      <div className="herobg">
        <div className="wrap h2c">
          <div className="stack-hero-l">
            <div className="crumb"><Link href={featuresBase}>Features</Link> / {a.name}</div>
            <h1>{a.hero.before}<span className="hl">{a.hero.hl}</span>{a.hero.after}</h1>
            <p className="lead">{a.lead}</p>
            <div className="cta">
              <a className="btn pri" href={docUrl(a.guide.doc)}>Read the {a.guide.title}</a>
              <a className="btn" href={site.getStartedHref}>Get started</a>
            </div>
          </div>
          <div className="stack-hero-r"><Visual a={a} /></div>
        </div>
      </div>
      <section style={{ paddingTop: 24 }}>
        <div className="wrap">
          <h2>What it does</h2>
          <div style={{ height: 14 }} />
          <ul className="sq">
            {a.bullets.map((b) => {
              const planned = b.includes('(status: Planned)');
              return (
                <li key={b}>
                  <span>
                    {b.replace(' (status: Planned)', '')}
                    <span className={`badge ${planned ? 'b-plan' : 'b-ok'}`}>{planned ? 'Planned' : 'Shipped'}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      <section className="alt-bg">
        <div className="wrap">
          <h2>Related docs</h2>
          <div className="cards" style={{ marginTop: 14 }}>
            {a.related.map((r) => (
              <a className="card" href={docUrl(r.doc)} key={r.doc + r.title}>
                <b>{r.title}</b><p>{r.text}</p><em>docs/{r.doc.replace(/\.md$/, '')} &rarr;</em>
              </a>
            ))}
          </div>
          <h2 style={{ marginTop: 48 }}>More features</h2>
          <div style={{ height: 14 }} />
          <div className="cards">
            {more.map((m) => (
              <Link className="card" href={`${featuresBase}/${m.slug}`} key={m.slug}>
                <Icon paths={m.icon} /><b>{m.name}</b><p>{m.card}</p><em>Read about {m.name} &rarr;</em>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <Footer site={site} />
    </Kit>
  );
}
