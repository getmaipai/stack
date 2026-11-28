import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyCommand, ThemeToggle } from './client';
import { GithubMark, Icon } from './icons';
import { withBase } from './base';
import sponsorFile from './sponsors.json';
import type { Area, SiteConfig } from './types';

/** Wrapper that carries the product token set. Put it around every kit page. */
export function Kit({ product, children }: { product: SiteConfig['product']; children: ReactNode }) {
  return (
    <div className="kit" data-product={product}>
      {children}
    </div>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  return <div className="banner">{children}</div>;
}

export function Nav({ site, stars }: { site: SiteConfig; stars: string | null }) {
  const gh = `https://github.com/${site.repo.user}/${site.repo.repo}`;
  return (
    <nav aria-label="Main">
      <div className="wrap">
        <Link className="brand" href="/" aria-label={site.name}>
          <img className="l-light" src={withBase(site.logo.light)} alt={site.name} />
          <img className="l-dark" src={withBase(site.logo.dark)} alt="" />
        </Link>
        <div className="links">
          <Link href={site.featuresHref}>Features</Link>
          <a href={site.docsHref}>Docs</a>
          {site.extraLinks?.map((l) => (
            <Link href={l.href} key={l.href}>{l.text}</Link>
          ))}
          <a href={site.sister.href}>{site.sister.name}</a>
        </div>
        <span className="sp" />
        <a className="btn star" href={gh} title="View the code on GitHub">
          <GithubMark />
          <span className="gh-text">GitHub</span>
          {stars && (
            <b aria-label={`${stars} stars`}>
              <span aria-hidden>★ </span>
              {stars}
            </b>
          )}
        </a>
        <ThemeToggle />
        <Link className="btn pri" href={site.getStartedHref}>
          Get started
        </Link>
      </div>
    </nav>
  );
}

export function Footer({ site }: { site: SiteConfig }) {
  const gh = `https://github.com/${site.repo.user}/${site.repo.repo}`;
  return (
    <footer>
      <div className="wrap">
        <span>{site.name}, AGPL-3.0. Private, local AI that is yours.</span>
        <span>
          <a href={gh}>GitHub</a> &middot; <a href={site.docsHref}>Docs</a> &middot; <a href={site.sponsorHref}>Sponsor</a> &middot; <a href={site.privacyHref}>Privacy</a>
        </span>
      </div>
    </footer>
  );
}

export type Switch = { name: string; note: string; on: boolean };

/** Split hero: text left, an illustrated switch panel right. */
export function Hero({
  eyebrow, title, lead, small, command, ctas, badges, switches, caption,
}: {
  eyebrow: string; title: ReactNode; lead: string; small: string; command: string;
  ctas: ReactNode; badges: ReactNode; switches: Switch[]; caption: string;
}) {
  return (
    <div className="herobg">
      <div className="wrap h2c">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          <p className="lead">{lead}</p>
          <p className="small">{small}</p>
          <div className="cta">{ctas}</div>
          <CopyCommand command={command} />
          <div className="dl">{badges}</div>
        </div>
        <figure className="shot" style={{ margin: 0 }}>
          <div className="bar" aria-hidden><i /><i /><i /></div>
          <div className="tg">
            <h4>Turn on what you use</h4>
            {switches.map((s) => (
              <div className="tgr" key={s.name}>
                <div>{s.name}<small>{s.note}</small></div>
                <span className={`sw${s.on ? ' on' : ''}`} role="img" aria-label={s.on ? 'On' : 'Off'} />
              </div>
            ))}
          </div>
          <figcaption className="cap">{caption}</figcaption>
        </figure>
      </div>
    </div>
  );
}

export function Stats({ items }: { items: { value: string; label: string }[] }) {
  return (
    <div className="wrap" style={{ paddingBottom: 8 }}>
      <div className="stats">
        {items.map((s) => (
          <div className="stat" key={s.label}><b>{s.value}</b><small>{s.label}</small></div>
        ))}
      </div>
    </div>
  );
}

export function Section({ eyebrow, title, sub, alt, children }: { eyebrow?: string; title: string; sub?: string; alt?: boolean; children: ReactNode }) {
  return (
    <section className={alt ? 'alt-bg' : undefined}>
      <div className="wrap">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </section>
  );
}

export function InfoCards({ items }: { items: { title: string; text: string; tag: string }[] }) {
  return (
    <div className="cards">
      {items.map((c) => (
        <div className="card lift" key={c.title}><b>{c.title}</b><p>{c.text}</p><em className="mut">{c.tag}</em></div>
      ))}
    </div>
  );
}

export function FamiliarCards({ items }: { items: { from: string; does: string; added: string }[] }) {
  return (
    <div className="fam">
      {items.map((c) => (
        <div className="fc" key={c.from}>
          <span className="like">From {c.from}</span>
          <b>{c.does}</b>
          <span className="plus"><i>We added</i> {c.added}</span>
        </div>
      ))}
    </div>
  );
}

export function Chips({ items }: { items: string[] }) {
  return (
    <div className="pills" style={{ marginTop: 26 }}>
      {items.map((t) => (
        <span className="badge b-ok" style={{ padding: '6px 16px', fontSize: '.85rem' }} key={t}>{t}</span>
      ))}
    </div>
  );
}

export function AreaCards({ areas, base, product }: { areas: Area[]; base: string; product: string }) {
  return (
    <div className="cards">
      {areas.map((a) => (
        <Link className="card" href={`${base}/${a.slug}`} key={a.slug}>
          <Icon paths={a.icon} />
          <b>{a.title}</b>
          <p>{a.line}</p>
          <em>Read about {a.title} &rarr;</em>
        </Link>
      ))}
    </div>
  );
}

export function Sponsors() {
  const list = sponsorFile.sponsors as { name: string; href: string; logo?: string }[];
  return (
    <section>
      <div className="wrap" style={{ textAlign: 'center' }}>
        <h2>Sponsors</h2>
        <p className="sub" style={{ marginInline: 'auto' }}>MaiPai is free and open source. These people and companies keep it that way.</p>
        <div className="pills">
          {list.length === 0
            ? [1, 2, 3].map((n) => (
                <span className="badge b-plan" style={{ padding: '14px 28px', fontSize: '.9rem' }} key={n}>Your logo here</span>
              ))
            : list.map((s) => (
                <a className="badge b-plan" style={{ padding: '10px 24px', fontSize: '.9rem' }} href={s.href} key={s.name}>
                  {s.logo ? <img src={withBase(s.logo)} alt={s.name} height={28} /> : s.name}
                </a>
              ))}
        </div>
        <p style={{ marginTop: 20 }}>
          <a className="btn pri" href={sponsorFile.become}>Become a sponsor</a>
        </p>
      </div>
    </section>
  );
}

export function StackBand({ stackHref }: { stackHref: string }) {
  return (
    <section className="alt-bg">
      <div className="wrap">
        <div className="h2c" style={{ paddingBlock: 0 }}>
          <div>
            <div className="eyebrow">Built on MaiPai Stack</div>
            <h2>A foundation that keeps it running.</h2>
            <p className="sub">
              Home is the household hub. Underneath, Stack runs the engines on your own computer, queues the heavy work, fits everything in memory and tells you plainly when something needs help. It is what lets Home work for two people or twenty.
            </p>
            <a className="btn" href={stackHref}>Learn about Stack &rarr;</a>
          </div>
          <figure className="shot" style={{ margin: 0 }}>
            <div className="bar" aria-hidden><i /><i /><i /></div>
            <div className="health">
              <div className="hrow"><span>Pictures engine stopped</span><span className="btn pri" style={{ padding: '4px 12px' }}>Restart</span></div>
              <div className="hrow"><span>Update available: voice engine</span><span className="btn" style={{ padding: '4px 12px' }}>Update</span></div>
              <div className="hrow"><span>All other checks pass</span><span className="badge b-ok">Healthy</span></div>
            </div>
            <figcaption className="cap">Illustration, not a real screen.</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
